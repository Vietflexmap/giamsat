"""Open-data Shapefile/GeoJSON clipping pipeline.

The pipeline is intentionally independent from Earth Engine. It uses an
open STAC catalog for Sentinel-2/Landsat COG assets and Rasterio for the
same operation that an ENVI ``Subset Data via ROIs`` workflow performs:

1. read and validate the boundary file;
2. repair polygon topology and dissolve the uploaded features;
3. search an analysis-ready open image intersecting the AOI;
4. mask the raster with the AOI and crop its bounding window;
5. write a masked GeoTIFF/COG and an RGBA PNG preview.

The uploaded Shapefile is never trusted as-is. A ZIP must contain the
``.shp``, ``.shx``, ``.dbf`` and ``.prj`` sidecars with one unambiguous layer.
An undefined CRS is rejected rather than guessed.
"""

from __future__ import annotations

import json
import logging
import math
import os
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Literal

import geopandas as gpd
import numpy as np
import pystac_client
import rasterio
from PIL import Image
from rasterio.features import geometry_mask
from rasterio.mask import mask as raster_mask
from rasterio.shutil import copy as raster_copy
from rasterio.warp import transform_bounds
from shapely import make_valid
from shapely.geometry import mapping
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union


LOGGER = logging.getLogger("vietflex.clip")

WGS84 = "EPSG:4326"
AREA_CRS = "EPSG:6933"
STAC_API_URL = os.getenv("STAC_API_URL", "https://planetarycomputer.microsoft.com/api/stac/v1")
STAC_MAX_ITEMS = max(int(os.getenv("STAC_MAX_ITEMS", "100")), 1)
MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 256
NODATA = -9999.0

SourceName = Literal["s2", "landsat9"]


@dataclass(frozen=True)
class BoundaryInfo:
    """Validated, dissolved AOI and its provenance."""

    geometry_wgs84: BaseGeometry
    source_crs: str
    feature_count: int
    area_ha: float
    bbox_wgs84: tuple[float, float, float, float]


@dataclass(frozen=True)
class ClipParameters:
    """Validated parameters for one open-imagery clip."""

    satellite: SourceName
    start_date: date
    end_date: date
    cloud_max: float
    outputs: frozenset[str]
    render_mode: str


@dataclass(frozen=True)
class SelectedItem:
    """STAC item and the asset names needed for the requested sensor."""

    item: Any
    collection: str
    assets: dict[str, str]
    cloud_cover: float | None


def parse_user_date(value: str) -> date:
    """Parse the Vietnamese UI date or an ISO date without guessing."""

    text = str(value or "").strip()
    for pattern in ("%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    raise ValueError(f"Ngày không hợp lệ: {value!r}; dùng dd/mm/yyyy hoặc yyyy-mm-dd.")


def validate_clip_parameters(
    satellite: str,
    start_date: str,
    end_date: str,
    cloud_max: float,
    outputs: str,
    render_mode: str,
) -> ClipParameters:
    """Validate request values before any remote STAC or raster operation."""

    source = str(satellite).strip().lower()
    if source not in {"s2", "landsat9"}:
        raise ValueError("satellite chỉ nhận s2 hoặc landsat9.")
    start = parse_user_date(start_date)
    end = parse_user_date(end_date)
    if start > end:
        raise ValueError("Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.")
    try:
        cloud = float(cloud_max)
    except (TypeError, ValueError) as error:
        raise ValueError("cloud_max phải là số phần trăm.") from error
    if not math.isfinite(cloud) or not 0 <= cloud <= 100:
        raise ValueError("cloud_max phải nằm trong khoảng 0–100.")
    requested = frozenset(
        part.strip().lower()
        for part in str(outputs or "geotiff,png").split(",")
        if part.strip()
    )
    allowed = {"geotiff", "png", "geojson"}
    if not requested or not requested.issubset(allowed):
        raise ValueError("output chỉ nhận geotiff, png và geojson.")
    mode = str(render_mode or "true_color").strip().lower()
    if mode != "true_color":
        raise ValueError("render_mode hiện chỉ hỗ trợ true_color.")
    return ClipParameters(source, start, end, cloud, requested, mode)  # type: ignore[arg-type]


def _safe_zip_member(name: str) -> Path:
    """Return a relative member path or reject path traversal/symlinks."""

    parsed = PurePosixPath(name)
    if parsed.is_absolute() or ".." in parsed.parts:
        raise ValueError(f"Archive chứa đường dẫn không an toàn: {name!r}.")
    if not parsed.parts:
        raise ValueError("Archive chứa tên tệp rỗng.")
    return Path(*parsed.parts)


def prepare_boundary_path(upload_path: Path, work_dir: Path) -> Path:
    """Extract a safe Shapefile archive and return its vector path.

    A standalone ``.shp`` is deliberately rejected because a Shapefile is a
    sidecar set, not one file. GeoJSON and GeoPackage are accepted as
    interoperable fallbacks.
    """

    suffix = upload_path.suffix.lower()
    if suffix == ".zip":
        extract_dir = work_dir / "boundary"
        extract_dir.mkdir(parents=True, exist_ok=True)
        total_size = 0
        with zipfile.ZipFile(upload_path) as archive:
            members = archive.infolist()
            if len(members) > MAX_ARCHIVE_MEMBERS:
                raise ValueError("Archive có quá nhiều thành phần.")
            for member in members:
                relative = _safe_zip_member(member.filename)
                mode = (member.external_attr >> 16) & 0o170000
                if mode == 0o120000:
                    raise ValueError("Archive chứa symbolic link, bị từ chối.")
                if member.is_dir():
                    continue
                total_size += member.file_size
                if total_size > MAX_UNCOMPRESSED_BYTES:
                    raise ValueError("Kích thước giải nén vượt quá giới hạn 512 MB.")
                destination = extract_dir / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, destination.open("wb") as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
        shp_files = sorted(extract_dir.rglob("*.shp")) + sorted(extract_dir.rglob("*.SHP"))
        if len(shp_files) != 1:
            raise ValueError("ZIP phải chứa đúng một lớp .shp để tránh clip nhầm.")
        shp_path = shp_files[0]
        siblings = {
            path.suffix.lower(): path
            for path in shp_path.parent.iterdir()
            if path.stem.lower() == shp_path.stem.lower()
        }
        required = [siblings.get(ext) for ext in (".shp", ".shx", ".dbf", ".prj")]
        missing = [ext for ext, path in zip((".shp", ".shx", ".dbf", ".prj"), required) if path is None]
        if missing:
            raise ValueError(f"Shapefile thiếu sidecar bắt buộc: {', '.join(missing)}.")
        return required[0]  # type: ignore[return-value]
    if suffix == ".shp":
        raise ValueError("Hãy nạp ZIP chứa .shp, .shx, .dbf và .prj; .shp đơn lẻ không đủ dữ liệu.")
    if suffix in {".geojson", ".json", ".gpkg"}:
        return upload_path
    raise ValueError("Chỉ nhận ZIP Shapefile, GeoJSON hoặc GeoPackage.")


def _polygonal_geometry(geometry: BaseGeometry) -> BaseGeometry | None:
    """Repair a geometry and retain only polygonal parts."""

    if geometry is None or geometry.is_empty:
        return None
    repaired = make_valid(geometry)
    if repaired.is_empty:
        return None
    if repaired.geom_type in {"Polygon", "MultiPolygon"}:
        return repaired
    if repaired.geom_type == "GeometryCollection":
        polygons = [part for part in repaired.geoms if part.geom_type in {"Polygon", "MultiPolygon"} and not part.is_empty]
        return unary_union(polygons) if polygons else None
    return None


def load_boundary(vector_path: Path) -> BoundaryInfo:
    """Read, validate, repair, dissolve and project the uploaded boundary."""

    try:
        frame = gpd.read_file(vector_path)
    except UnicodeDecodeError:
        try:
            frame = gpd.read_file(vector_path, encoding="cp1258")
        except Exception as fallback_error:
            raise ValueError("Không đọc được mã hóa thuộc tính Shapefile.") from fallback_error
    except Exception as error:
        raise ValueError(f"Không đọc được ranh giới: {error}") from error
    if frame.empty:
        raise ValueError("Lớp ranh giới không có feature.")
    if frame.crs is None:
        raise ValueError("Ranh giới thiếu CRS/.prj; không được tự đoán hệ tọa độ.")

    geometries: list[BaseGeometry] = []
    invalid_rows: list[int] = []
    for row_number, geometry in enumerate(frame.geometry, start=1):
        repaired = _polygonal_geometry(geometry)
        if repaired is not None:
            geometries.append(repaired)
        else:
            invalid_rows.append(row_number)
    if invalid_rows:
        preview = ", ".join(str(row) for row in invalid_rows[:8])
        suffix = "…" if len(invalid_rows) > 8 else ""
        raise ValueError(f"Feature không phải Polygon/MultiPolygon hoặc rỗng ở dòng {preview}{suffix}.")
    if not geometries:
        raise ValueError("Ranh giới không có Polygon/MultiPolygon hợp lệ.")
    dissolved = _polygonal_geometry(unary_union(geometries))
    if dissolved is None or dissolved.is_empty:
        raise ValueError("Không tạo được AOI sau khi dissolve.")

    source_crs = frame.crs.to_string()
    source_frame = gpd.GeoDataFrame({"geometry": [dissolved]}, crs=frame.crs)
    area_ha = float(source_frame.to_crs(AREA_CRS).geometry.area.iloc[0] / 10_000)
    if not math.isfinite(area_ha) or area_ha <= 0:
        raise ValueError("Diện tích AOI không hợp lệ sau khi chuyển CRS.")
    wgs_frame = source_frame.to_crs(WGS84)
    geometry_wgs84 = wgs_frame.geometry.iloc[0]
    west, south, east, north = (float(value) for value in geometry_wgs84.bounds)
    if not all(math.isfinite(value) for value in (west, south, east, north)):
        raise ValueError("BBOX AOI chứa tọa độ không hợp lệ.")
    if not (-180 <= west <= 180 and -180 <= east <= 180 and -90 <= south <= 90 and -90 <= north <= 90):
        raise ValueError("BBOX AOI vượt giới hạn tọa độ WGS84.")
    return BoundaryInfo(geometry_wgs84, source_crs, len(geometries), area_ha, (west, south, east, north))


def _stac_datetime(start: date, end: date) -> str:
    """Build an RFC3339 half-open date range for STAC."""

    start_dt = datetime.combine(start, time.min, tzinfo=timezone.utc)
    end_dt = datetime.combine(end + timedelta(days=1), time.min, tzinfo=timezone.utc)
    return f"{start_dt.isoformat().replace('+00:00', 'Z')}/{end_dt.isoformat().replace('+00:00', 'Z')}"


def _cloud_cover(item: Any) -> float | None:
    value = item.properties.get("eo:cloud_cover")
    try:
        cloud = float(value)
    except (TypeError, ValueError):
        return None
    return cloud if math.isfinite(cloud) else None


def _asset_map(source: SourceName) -> tuple[str, dict[str, str]]:
    if source == "s2":
        return "sentinel-2-l2a", {"red": "B04", "green": "B03", "blue": "B02"}
    return "landsat-c2-l2", {"red": "red", "green": "green", "blue": "blue"}


def _sign_item(item: Any) -> Any:
    """Sign Planetary Computer blob assets when the configured catalog needs it."""

    if os.getenv("STAC_SIGN_ASSETS", "true").strip().lower() not in {"1", "true", "yes"}:
        return item
    try:
        import planetary_computer
    except ImportError as error:
        raise RuntimeError("STAC_SIGN_ASSETS=true nhưng thiếu planetary-computer.") from error
    return planetary_computer.sign(item)


def select_stac_item(aoi: BaseGeometry, parameters: ClipParameters) -> SelectedItem:
    """Find the least-cloudy compatible scene intersecting the AOI."""

    collection, asset_names = _asset_map(parameters.satellite)
    try:
        catalog = pystac_client.Client.open(STAC_API_URL)
        search = catalog.search(
            collections=[collection],
            intersects=mapping(aoi),
            datetime=_stac_datetime(parameters.start_date, parameters.end_date),
            max_items=STAC_MAX_ITEMS,
        )
        candidates = list(search.items())
    except Exception as error:
        raise RuntimeError(f"Không truy vấn được STAC catalog: {error}") from error

    eligible: list[tuple[Any, float | None]] = []
    for item in candidates:
        if parameters.satellite == "landsat9":
            platform = str(item.properties.get("platform", "")).lower()
            if platform not in {"landsat-9", "landsat9"}:
                continue
        cloud = _cloud_cover(item)
        if cloud is not None and cloud > parameters.cloud_max:
            continue
        if any(name not in item.assets or not item.assets[name].href for name in asset_names.values()):
            continue
        eligible.append((item, cloud))
    if not eligible:
        raise RuntimeError(
            f"Không tìm thấy cảnh {collection} phù hợp trong khoảng "
            f"{parameters.start_date.isoformat()}–{parameters.end_date.isoformat()} "
            f"với mây ≤ {parameters.cloud_max:g}%.")

    midpoint = datetime.combine(
        parameters.start_date + (parameters.end_date - parameters.start_date) / 2,
        time.min,
        tzinfo=timezone.utc,
    )

    def score(pair: tuple[Any, float | None]) -> tuple[float, float]:
        item, cloud = pair
        item_time = item.datetime or midpoint
        item_time = item_time.replace(tzinfo=timezone.utc) if item_time.tzinfo is None else item_time
        return (cloud if cloud is not None else 100.0, abs((item_time - midpoint).total_seconds()))

    item, cloud = min(eligible, key=score)
    signed_item = _sign_item(item)
    hrefs = {key: signed_item.assets[name].href for key, name in asset_names.items()}
    return SelectedItem(signed_item, collection, hrefs, cloud)


def _source_geometry(aoi_wgs84: BaseGeometry, crs: Any) -> BaseGeometry:
    """Transform the AOI from WGS84 to the raster CRS."""

    frame = gpd.GeoDataFrame({"geometry": [aoi_wgs84]}, crs=WGS84)
    return frame.to_crs(crs).geometry.iloc[0]


def _read_asset(href: str, aoi_wgs84: BaseGeometry, scale: float, offset: float) -> tuple[np.ndarray, np.ndarray, Any, Any]:
    """Read one COG through the AOI and return values, valid mask, grid and CRS."""

    try:
        with rasterio.open(href) as source:
            aoi_source = _source_geometry(aoi_wgs84, source.crs)
            data, transform = raster_mask(
                source,
                [mapping(aoi_source)],
                crop=True,
                all_touched=False,
                filled=False,
            )
            masked = data[0]
            valid = ~np.ma.getmaskarray(masked)
            values = np.asarray(masked.data, dtype=np.float32) * scale + offset
            values[~valid] = np.nan
            return values, valid, transform, source.crs
    except ValueError as error:
        raise RuntimeError(f"AOI không giao với raster: {error}") from error
    except Exception as error:
        raise RuntimeError(f"Không đọc được COG từ STAC: {error}") from error


def _write_masked_geotiff(
    path: Path,
    bands: list[np.ndarray],
    valid: np.ndarray,
    transform: Any,
    crs: Any,
) -> str:
    """Write a tiled masked GeoTIFF and opportunistically convert it to COG."""

    height, width = bands[0].shape
    profile: dict[str, Any] = {
        "driver": "GTiff",
        "height": height,
        "width": width,
        "count": len(bands),
        "dtype": "float32",
        "crs": crs,
        "transform": transform,
        "nodata": NODATA,
        "tiled": True,
        "compress": "deflate",
        "BIGTIFF": "IF_SAFER",
    }
    raw_path = path.with_suffix(".source.tif")
    with rasterio.open(raw_path, "w", **profile) as destination:
        for index, band in enumerate(bands, start=1):
            output = np.where(valid & np.isfinite(band), band, NODATA).astype(np.float32)
            destination.write(output, index)
        destination.write_mask(np.where(valid, 255, 0).astype(np.uint8))

    try:
        raster_copy(
            str(raw_path),
            str(path),
            driver="COG",
            compress="DEFLATE",
            blocksize=256,
            overview_resampling="NEAREST",
        )
        raw_path.unlink(missing_ok=True)
        return "COG"
    except Exception as error:
        LOGGER.warning("GDAL COG driver không khả dụng, giữ GeoTIFF tiled: %s", error)
        raw_path.replace(path)
        return "GeoTIFF"


def _stretch(values: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Convert reflectance to an 8-bit display channel."""

    finite = values[valid & np.isfinite(values)]
    if finite.size == 0:
        return np.zeros(values.shape, dtype=np.uint8)
    low, high = np.nanpercentile(finite, [2, 98])
    if not math.isfinite(float(low)) or not math.isfinite(float(high)) or high <= low:
        low, high = float(np.nanmin(finite)), float(np.nanmax(finite))
    if high <= low:
        high = low + 1.0
    channel = np.clip((np.nan_to_num(values, nan=low) - low) / (high - low) * 255, 0, 255)
    return channel.astype(np.uint8)


def _write_png(path: Path, bands: list[np.ndarray], valid: np.ndarray) -> None:
    """Write a true-colour RGBA PNG; alpha is zero outside the AOI."""

    rgb = [_stretch(band, valid) for band in bands]
    alpha = np.where(valid, 255, 0).astype(np.uint8)
    rgba = np.dstack([rgb[0], rgb[1], rgb[2], alpha])
    Image.fromarray(rgba, mode="RGBA").save(path, format="PNG", optimize=True)


def _write_aoi_geojson(path: Path, boundary: BoundaryInfo, filename: str) -> None:
    """Persist the dissolved AOI as a small WGS84 GeoJSON for audit."""

    payload = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {
                "source_filename": filename,
                "source_crs": boundary.source_crs,
                "feature_count": boundary.feature_count,
                "area_ha": boundary.area_ha,
            },
            "geometry": mapping(boundary.geometry_wgs84),
        }],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _image_bbox_wgs84(height: int, width: int, transform: Any, crs: Any) -> list[float]:
    """Return raster bounds as [west, south, east, north] in WGS84."""

    west, south, east, north = rasterio.transform.array_bounds(height, width, transform)
    if str(crs) != WGS84:
        west, south, east, north = transform_bounds(crs, WGS84, west, south, east, north)
    return [float(west), float(south), float(east), float(north)]


def run_clip_pipeline(
    boundary_upload: Path,
    boundary_filename: str,
    parameters: ClipParameters,
    output_dir: Path,
    public_prefix: str,
) -> dict[str, Any]:
    """Run the complete upload → STAC → masked raster workflow."""

    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="boundary-", dir=output_dir) as temporary:
        vector_path = prepare_boundary_path(boundary_upload, Path(temporary))
        boundary = load_boundary(vector_path)
    _write_aoi_geojson(output_dir / "aoi.geojson", boundary, boundary_filename)

    selected = select_stac_item(boundary.geometry_wgs84, parameters)
    scale, offset = (0.0001, 0.0) if parameters.satellite == "s2" else (0.0000275, -0.2)
    bands: list[np.ndarray] = []
    valid: np.ndarray | None = None
    transform: Any = None
    raster_crs: Any = None
    for name in ("red", "green", "blue"):
        values, band_valid, band_transform, band_crs = _read_asset(
            selected.assets[name], boundary.geometry_wgs84, scale, offset
        )
        if transform is None:
            transform, raster_crs = band_transform, band_crs
        elif values.shape != bands[0].shape or band_crs != raster_crs or band_transform != transform:
            raise RuntimeError("Các band COG không cùng lưới; từ chối ghép lệch pixel.")
        bands.append(values)
        valid = band_valid if valid is None else valid & band_valid

    if valid is None or transform is None or raster_crs is None:
        raise RuntimeError("Không tạo được lưới pixel chung cho ba band màu.")
    inside = geometry_mask(
        [mapping(_source_geometry(boundary.geometry_wgs84, raster_crs))],
        out_shape=valid.shape,
        transform=transform,
        invert=True,
        all_touched=False,
    )
    outside_valid = int(np.count_nonzero(valid & ~inside))
    if outside_valid:
        raise RuntimeError(f"Kiểm tra clip thất bại: còn {outside_valid} pixel hợp lệ ngoài AOI.")

    geotiff_format = None
    if "geotiff" in parameters.outputs:
        geotiff_format = _write_masked_geotiff(output_dir / "clip.tif", bands, valid, transform, raster_crs)
    if "png" in parameters.outputs:
        _write_png(output_dir / "clip.png", bands, valid)

    acquisition = selected.item.datetime.isoformat() if selected.item.datetime else None
    image_bbox = _image_bbox_wgs84(bands[0].shape[0], bands[0].shape[1], transform, raster_crs)
    metadata: dict[str, Any] = {
        "operation": "clip",
        "clip_verified": True,
        "clip_method": "rasterio.mask.mask(crop=true, all_touched=false) + dataset mask",
        "boundary_filename": boundary_filename,
        "boundary_source_crs": boundary.source_crs,
        "boundary_feature_count": boundary.feature_count,
        "boundary_area_ha": boundary.area_ha,
        "boundary_bbox_wgs84": list(boundary.bbox_wgs84),
        "source": "Microsoft Planetary Computer STAC / open COG",
        "stac_api": STAC_API_URL,
        "collection": selected.collection,
        "item_id": selected.item.id,
        "acquisition_datetime": acquisition,
        "cloud_cover_pct": selected.cloud_cover,
        "satellite": "Sentinel-2 L2A" if parameters.satellite == "s2" else "Landsat 9 Collection 2 Level-2",
        "period": [parameters.start_date.isoformat(), parameters.end_date.isoformat()],
        "reflectance_scale": scale,
        "reflectance_offset": offset,
        "render_mode": parameters.render_mode,
        "raster_crs": str(raster_crs),
        "image_bbox_wgs84": image_bbox,
        "nodata": NODATA,
        "valid_pixel_count": int(np.count_nonzero(valid)),
        "masked_pixel_count": int(np.count_nonzero(~valid)),
        "aoi_geojson_url": f"{public_prefix}/aoi.geojson",
    }
    if geotiff_format:
        metadata["geotiff_url"] = f"{public_prefix}/clip.tif"
        metadata["geotiff_format"] = geotiff_format
    if "png" in parameters.outputs:
        metadata["image_url"] = f"{public_prefix}/clip.png"
    return {"type": "FeatureCollection", "features": [], "metadata": metadata}
