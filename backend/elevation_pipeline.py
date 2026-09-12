"""Open DEM/DSM clipping and publication-map pipeline.

This module is deliberately separate from the optical-image change detector.
Elevation products are static observations, so they do not use date windows or
the Earth Engine monitor route.  The workflow is:

1. resolve an authoritative boundary (uploaded file or a server-side dataset
   keyed by ``admin_code``);
2. search an open STAC catalog for DEM tiles intersecting the AOI;
3. mosaic and reproject the source COGs to a local projected CRS;
4. apply an exact ``geometry_mask`` and crop the raster window;
5. write a masked DEM COG plus optional hillshade, slope, contours and a
   publication-ready PNG/PDF map.

The global DEM products exposed here are DSM-like elevation surfaces.  They
must not be presented as engineering-grade DTM data or as a 10 m source just
because a 30 m raster was resampled to a smaller pixel size.
"""

from __future__ import annotations

import json
import logging
import math
import os
import tempfile
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import geopandas as gpd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pystac_client
import rasterio
from matplotlib.colors import Normalize
from PIL import Image
from rasterio.features import geometry_mask
from rasterio.merge import merge
from rasterio.shutil import copy as raster_copy
from rasterio.transform import array_bounds
from rasterio.warp import calculate_default_transform, reproject, transform_bounds
from rasterio.windows import Window, transform as window_transform
from rasterio.enums import Resampling
from shapely import make_valid
from shapely.geometry import LineString, mapping
from shapely.geometry.base import BaseGeometry

try:
    from .clip_pipeline import (
        NODATA,
        STAC_API_URL,
        WGS84,
        BoundaryInfo,
        load_boundary,
        prepare_boundary_path,
    )
except ImportError:  # Supports ``uvicorn app:app`` from the backend directory.
    from clip_pipeline import (  # type: ignore[no-redef]
        NODATA,
        STAC_API_URL,
        WGS84,
        BoundaryInfo,
        load_boundary,
        prepare_boundary_path,
    )


LOGGER = logging.getLogger("vietflex.elevation")

DEM_STAC_API_URL = os.getenv("DEM_STAC_API_URL", STAC_API_URL)
DEM_MAX_ITEMS = max(int(os.getenv("DEM_MAX_ITEMS", "25")), 1)
MAX_DEM_PIXELS = max(int(os.getenv("MAX_DEM_PIXELS", "120000000")), 1)
MAX_CONTOUR_LEVELS = max(int(os.getenv("MAX_CONTOUR_LEVELS", "500")), 10)

DemSource = Literal["cop-dem-glo30", "nasadem", "alos-aw3d30"]
DemSurface = Literal["dsm"]

# Collection identifiers are environment-overridable because public STAC
# deployments can expose the same product under different collection IDs.
DEM_SOURCES: dict[str, dict[str, Any]] = {
    "cop-dem-glo30": {
        "collection": os.getenv("DEM_COP_COLLECTION", "cop-dem-glo-30"),
        "label": "Copernicus DEM GLO-30",
        "native_resolution_m": 30.0,
        "vertical_crs": "EGM2008 geoid-referenced elevation (catalog metadata)",
        "surface_type": "DSM",
    },
    "nasadem": {
        "collection": os.getenv("DEM_NASA_COLLECTION", "nasadem"),
        "label": "NASADEM",
        "native_resolution_m": 30.0,
        "vertical_crs": "EGM96 geoid-referenced elevation (catalog metadata)",
        "surface_type": "DSM-like",
    },
    "alos-aw3d30": {
        "collection": os.getenv("DEM_ALOS_COLLECTION", "alos-dem"),
        "label": "ALOS World 3D 30 m",
        "native_resolution_m": 30.0,
        "vertical_crs": "Product vertical datum; inspect source metadata before engineering use",
        "surface_type": "DSM-like",
    },
}


@dataclass(frozen=True)
class ElevationParameters:
    """Validated parameters for one DEM/DSM job."""

    dem_source: DemSource
    surface: DemSurface
    products: frozenset[str]
    contour_interval_m: float
    output_crs: str
    resolution_m: float | None


@dataclass(frozen=True)
class SelectedDemItem:
    """One STAC item and the selected elevation asset href."""

    item: Any
    collection: str
    href: str


def _code_key(value: Any) -> str:
    """Normalize a code for exact comparison without guessing names."""

    text = str(value or "").strip()
    if text.endswith(".0"):
        text = text[:-2]
    return text


def validate_elevation_parameters(
    dem_source: str,
    surface: str,
    products: str,
    contour_interval_m: float,
    output_crs: str,
    resolution_m: float | None = None,
) -> ElevationParameters:
    """Validate DEM choices and prevent false high-resolution claims."""

    source = str(dem_source or "").strip().lower()
    if source not in DEM_SOURCES:
        raise ValueError(f"dem_source chỉ nhận: {', '.join(DEM_SOURCES)}.")
    requested_surface = str(surface or "dsm").strip().lower()
    if requested_surface != "dsm":
        raise ValueError("Nguồn DEM mở hiện chỉ được khai báo là DSM; chưa hỗ trợ DTM.")

    requested = frozenset(
        part.strip().lower()
        for part in str(products or "dem,preview").split(",")
        if part.strip()
    )
    allowed = {"dem", "hillshade", "slope", "aspect", "contours", "map", "preview", "geojson"}
    if not requested or not requested.issubset(allowed):
        raise ValueError(f"products chỉ nhận: {', '.join(sorted(allowed))}.")
    requested = frozenset(set(requested) | {"dem"})

    try:
        interval = float(contour_interval_m)
    except (TypeError, ValueError) as error:
        raise ValueError("contour_interval_m phải là số mét dương.") from error
    if not math.isfinite(interval) or interval <= 0 or interval > 5000:
        raise ValueError("contour_interval_m phải nằm trong khoảng (0, 5000].")

    crs_text = str(output_crs or "auto").strip()
    if crs_text.lower() not in {"auto", "source"}:
        try:
            from pyproj import CRS

            CRS.from_user_input(crs_text)
        except Exception as error:
            raise ValueError(f"output_crs không hợp lệ: {crs_text!r}.") from error

    target_resolution: float | None
    if resolution_m in (None, ""):
        target_resolution = None
    else:
        try:
            target_resolution = float(resolution_m)
        except (TypeError, ValueError) as error:
            raise ValueError("resolution_m phải là số dương.") from error
        native = float(DEM_SOURCES[source]["native_resolution_m"])
        if not math.isfinite(target_resolution) or target_resolution <= 0:
            raise ValueError("resolution_m phải lớn hơn 0.")
        if target_resolution < native:
            raise ValueError(
                f"Không được đặt resolution_m={target_resolution:g} m nhỏ hơn độ phân giải nguồn "
                f"{native:g} m; đó chỉ là nội suy giả độ phân giải."
            )
        if target_resolution > 5000:
            raise ValueError("resolution_m không được vượt quá 5000 m.")

    return ElevationParameters(
        dem_source=source,  # type: ignore[arg-type]
        surface="dsm",
        products=requested,
        contour_interval_m=interval,
        output_crs=crs_text,
        resolution_m=target_resolution,
    )


def _sign_item(item: Any) -> Any:
    """Sign Planetary Computer assets when requested by the deployment."""

    if os.getenv("STAC_SIGN_ASSETS", "true").strip().lower() not in {"1", "true", "yes"}:
        return item
    try:
        import planetary_computer
    except ImportError as error:
        raise RuntimeError("STAC_SIGN_ASSETS=true nhưng thiếu planetary-computer.") from error
    return planetary_computer.sign(item)


def _elevation_asset(item: Any) -> str | None:
    """Pick an elevation COG without assuming a vendor-specific asset name."""

    preferred = ("data", "dem", "elevation", "dsm", "image")
    for key in preferred:
        asset = item.assets.get(key)
        if asset is not None and asset.href:
            return str(asset.href)
    for asset in item.assets.values():
        media_type = str(asset.media_type or "").lower()
        href = str(asset.href or "")
        if asset.href and ("tif" in media_type or href.lower().split("?")[0].endswith((".tif", ".tiff"))):
            return href
    return None


def select_dem_items(aoi: BaseGeometry, parameters: ElevationParameters) -> list[SelectedDemItem]:
    """Search all intersecting DEM tiles needed to cover the AOI."""

    collection = str(DEM_SOURCES[parameters.dem_source]["collection"])
    try:
        catalog = pystac_client.Client.open(DEM_STAC_API_URL)
        search = catalog.search(
            collections=[collection],
            intersects=mapping(aoi),
            max_items=DEM_MAX_ITEMS,
        )
        candidates = list(search.items())
    except Exception as error:
        raise RuntimeError(f"Không truy vấn được STAC DEM catalog: {error}") from error

    selected: list[SelectedDemItem] = []
    for item in candidates:
        href = _elevation_asset(item)
        if not href:
            continue
        signed = _sign_item(item)
        signed_href = _elevation_asset(signed) or href
        selected.append(SelectedDemItem(signed, collection, signed_href))
    if not selected:
        raise RuntimeError(
            f"Không tìm thấy asset DEM dạng GeoTIFF/COG giao AOI trong collection {collection!r}. "
            "Kiểm tra DEM_STAC_API_URL và tên collection."
        )
    return selected


def resolve_admin_boundary_path(admin_code: str, output_dir: Path) -> tuple[Path, str]:
    """Resolve one exact admin feature from a configured canonical dataset.

    ``admin.json``/PMTiles used by the browser intentionally contain lookup
    metadata and display tiles, not authoritative polygon geometry.  Therefore
    this function refuses name/centroid matching and requires a server-side
    vector dataset with a code field.
    """

    configured = os.getenv("ADMIN_BOUNDARIES_PATH", "").strip()
    if not configured:
        raise RuntimeError(
            "Chưa cấu hình ADMIN_BOUNDARIES_PATH; hãy tải ZIP Shapefile hoặc đặt "
            "GeoPackage/GeoJSON ranh giới theo admin_code."
        )
    source_path = Path(configured).expanduser().resolve()
    if not source_path.exists():
        raise RuntimeError(f"ADMIN_BOUNDARIES_PATH không tồn tại: {source_path.name}")

    try:
        frame = gpd.read_file(source_path)
    except Exception as error:
        raise RuntimeError(f"Không đọc được bộ ranh giới hành chính máy chủ: {error}") from error
    if frame.empty or frame.crs is None:
        raise RuntimeError("Bộ ranh giới hành chính máy chủ phải có feature và CRS/.prj.")

    configured_field = os.getenv("ADMIN_CODE_FIELD", "code").strip()
    candidate_fields = [configured_field, "admin_code", "code", "ma", "gid", "id"]
    code_field = next((field for field in candidate_fields if field and field in frame.columns), None)
    if not code_field:
        raise RuntimeError("Không tìm thấy cột mã hành chính; đặt ADMIN_CODE_FIELD đúng tên cột.")
    matches = frame[frame[code_field].map(_code_key) == _code_key(admin_code)].copy()
    if len(matches) != 1:
        raise RuntimeError(f"AOI {admin_code} phải khớp đúng 1 feature trong dataset máy chủ, nhận {len(matches)}.")

    geometry = matches.geometry.iloc[0]
    if geometry is None or geometry.is_empty:
        raise RuntimeError(f"AOI {admin_code} có hình học rỗng.")
    repaired = make_valid(geometry)
    if repaired.is_empty or repaired.geom_type not in {"Polygon", "MultiPolygon"}:
        raise RuntimeError(f"AOI {admin_code} không phải Polygon/MultiPolygon hợp lệ.")
    matches.geometry = [repaired]

    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / "admin-boundary.geojson"
    matches.to_crs(WGS84).to_file(destination, driver="GeoJSON")
    return destination, source_path.name


def _analysis_crs(aoi: BaseGeometry, requested: str, source_crs: Any) -> Any:
    from pyproj import CRS

    value = requested.strip().lower()
    if value == "auto":
        estimated = gpd.GeoSeries([aoi], crs=WGS84).estimate_utm_crs()
        if estimated is None:
            raise RuntimeError("Không ước tính được UTM cục bộ cho AOI.")
        return estimated
    if value == "source":
        crs = CRS.from_user_input(source_crs)
        if not crs.is_projected:
            raise RuntimeError("output_crs=source là hệ tọa độ địa lý; dùng output_crs=auto để tính đạo hàm theo mét.")
        return crs
    crs = CRS.from_user_input(requested)
    if not crs.is_projected:
        raise RuntimeError("DEM cần CRS phẳng theo mét để tính slope/contour; hãy dùng UTM hoặc output_crs=auto.")
    return crs


def _write_masked_raster(path: Path, values: np.ndarray, valid: np.ndarray, transform: Any, crs: Any, dtype: str = "float32") -> str:
    """Write a single-band masked GeoTIFF and opportunistically convert to COG."""

    fill_value: float | int = 0 if dtype == "uint8" else NODATA
    output = np.where(valid & np.isfinite(values), values, fill_value).astype(dtype)
    profile: dict[str, Any] = {
        "driver": "GTiff",
        "height": output.shape[0],
        "width": output.shape[1],
        "count": 1,
        "dtype": dtype,
        "crs": crs,
        "transform": transform,
        "nodata": NODATA if dtype.startswith("float") else 0,
        "tiled": True,
        "compress": "deflate",
        "BIGTIFF": "IF_SAFER",
    }
    raw_path = path.with_suffix(".source.tif")
    with rasterio.open(raw_path, "w", **profile) as destination:
        destination.write(output, 1)
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


def _write_aoi_geojson(path: Path, boundary: BoundaryInfo, filename: str) -> None:
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


def _read_dem_mosaic(selected: list[SelectedDemItem], aoi: BaseGeometry) -> tuple[np.ndarray, np.ndarray, Any, Any, float]:
    """Read the intersecting COGs into one common source grid."""

    with ExitStack() as stack:
        datasets = []
        for tile in selected:
            try:
                dataset = stack.enter_context(rasterio.open(tile.href))
            except Exception as error:
                raise RuntimeError(f"Không mở được DEM COG {tile.item.id}: {error}") from error
            if dataset.crs is None:
                raise RuntimeError(f"DEM item {tile.item.id} thiếu CRS.")
            datasets.append(dataset)
        source_crs = datasets[0].crs
        if any(dataset.crs != source_crs for dataset in datasets[1:]):
            raise RuntimeError("Các tile DEM có CRS khác nhau; cần chuẩn hóa trước khi mosaic.")
        left, bottom, right, top = transform_bounds(WGS84, source_crs, *aoi.bounds, densify_pts=21)
        try:
            mosaic, transform = merge(datasets, bounds=(left, bottom, right, top), indexes=1, nodata=NODATA, dtype="float32")
        except Exception as error:
            raise RuntimeError(f"Không mosaic được các tile DEM giao AOI: {error}") from error
        data = np.asarray(mosaic[0], dtype=np.float32)
        valid = np.isfinite(data) & (data != NODATA)
        if not np.any(valid):
            raise RuntimeError("DEM giao AOI nhưng không có pixel cao độ hợp lệ.")
        native_resolution = _native_resolution_m(transform, source_crs, aoi)
        return data, valid, transform, source_crs, native_resolution


def _native_resolution_m(transform: Any, crs: Any, aoi: BaseGeometry) -> float:
    """Estimate one source pixel in metres, including geographic COGs."""

    from pyproj import CRS, Transformer

    source_crs = CRS.from_user_input(crs)
    x0, y0 = transform * (0, 0)
    x1, y1 = transform * (1, 0)
    x2, y2 = transform * (0, 1)
    if source_crs.is_geographic:
        local_crs = gpd.GeoSeries([aoi], crs=WGS84).estimate_utm_crs()
        if local_crs is None:
            raise RuntimeError("Không ước tính được CRS mét để đo độ phân giải DEM nguồn.")
        converter = Transformer.from_crs(source_crs, local_crs, always_xy=True)
        p0 = converter.transform(x0, y0)
        p1 = converter.transform(x1, y1)
        p2 = converter.transform(x2, y2)
        x_resolution = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        y_resolution = math.hypot(p2[0] - p0[0], p2[1] - p0[1])
    else:
        unit_factor = float(source_crs.axis_info[0].unit_conversion_factor or 1.0)
        x_resolution = abs(float(transform.a)) * unit_factor
        y_resolution = abs(float(transform.e)) * unit_factor
    resolution = min(x_resolution, y_resolution)
    if not math.isfinite(resolution) or resolution <= 0:
        raise RuntimeError("Không xác định được độ phân giải pixel DEM nguồn theo mét.")
    return resolution


def _reproject_dem(
    data: np.ndarray,
    valid: np.ndarray,
    source_transform: Any,
    source_crs: Any,
    aoi: BaseGeometry,
    parameters: ElevationParameters,
    native_resolution: float,
) -> tuple[np.ndarray, np.ndarray, Any, Any, int]:
    """Reproject, mask, crop and verify the DEM output grid."""

    analysis_crs = _analysis_crs(aoi, parameters.output_crs, source_crs)
    resolution = parameters.resolution_m or max(native_resolution, 1.0)
    if resolution < native_resolution * 0.999:
        raise RuntimeError(
            f"resolution_m={resolution:g} m nhỏ hơn độ phân giải tile nguồn {native_resolution:g} m; "
            "không nội suy thành độ phân giải giả."
        )
    left, bottom, right, top = array_bounds(data.shape[0], data.shape[1], source_transform)
    dst_transform, dst_width, dst_height = calculate_default_transform(
        source_crs,
        analysis_crs,
        data.shape[1],
        data.shape[0],
        left,
        bottom,
        right,
        top,
        resolution=resolution,
    )
    if dst_width * dst_height > MAX_DEM_PIXELS:
        raise RuntimeError(
            f"DEM sau reprojection có {dst_width * dst_height:,} pixel, vượt MAX_DEM_PIXELS={MAX_DEM_PIXELS:,}. "
            "Tăng resolution_m hoặc giảm AOI."
        )

    source = np.where(valid & np.isfinite(data), data, NODATA).astype(np.float32)
    destination = np.full((dst_height, dst_width), NODATA, dtype=np.float32)
    reproject(
        source=source,
        destination=destination,
        src_transform=source_transform,
        src_crs=source_crs,
        src_nodata=NODATA,
        dst_transform=dst_transform,
        dst_crs=analysis_crs,
        dst_nodata=NODATA,
        resampling=Resampling.bilinear,
    )

    aoi_analysis = gpd.GeoSeries([aoi], crs=WGS84).to_crs(analysis_crs).iloc[0]
    inside = geometry_mask(
        [mapping(aoi_analysis)],
        out_shape=destination.shape,
        transform=dst_transform,
        invert=True,
        all_touched=False,
    )
    raster_valid = np.isfinite(destination) & (destination != NODATA)
    outside_valid = int(np.count_nonzero(raster_valid & ~inside))
    destination[~inside] = NODATA
    valid_output = inside & np.isfinite(destination) & (destination != NODATA)
    if not np.any(valid_output):
        raise RuntimeError("Không còn pixel DEM hợp lệ bên trong AOI sau khi mask.")
    rows, cols = np.where(inside)
    row_start, row_stop = int(rows.min()), int(rows.max()) + 1
    col_start, col_stop = int(cols.min()), int(cols.max()) + 1
    window = Window(col_start, row_start, col_stop - col_start, row_stop - row_start)
    cropped = destination[row_start:row_stop, col_start:col_stop].copy()
    cropped_valid = valid_output[row_start:row_stop, col_start:col_stop].copy()
    cropped_transform = window_transform(window, dst_transform)
    cropped[~cropped_valid] = NODATA
    # The returned array is masked before any derivative/output is written.
    verified_outside = int(np.count_nonzero((np.isfinite(cropped) & (cropped != NODATA)) & ~cropped_valid))
    if verified_outside:
        raise RuntimeError(f"Kiểm tra clip DEM thất bại: còn {verified_outside} pixel ngoài AOI.")
    return cropped, cropped_valid, cropped_transform, analysis_crs, outside_valid


def _interior_mask(valid: np.ndarray) -> np.ndarray:
    """Require a complete 3x3 neighborhood for terrain derivatives."""

    if valid.shape[0] < 3 or valid.shape[1] < 3:
        return np.zeros(valid.shape, dtype=bool)
    result = np.zeros(valid.shape, dtype=bool)
    result[1:-1, 1:-1] = (
        valid[1:-1, 1:-1]
        & valid[:-2, :-2]
        & valid[:-2, 1:-1]
        & valid[:-2, 2:]
        & valid[1:-1, :-2]
        & valid[1:-1, 2:]
        & valid[2:, :-2]
        & valid[2:, 1:-1]
        & valid[2:, 2:]
    )
    return result


def _terrain_products(elevation: np.ndarray, valid: np.ndarray, transform: Any) -> dict[str, np.ndarray]:
    """Derive slope/aspect and display hillshade in metric CRS."""

    valid_derivative = _interior_mask(valid)
    if not np.any(valid_derivative):
        raise RuntimeError("AOI quá nhỏ để tính đạo hàm địa hình trên lân cận 3x3 pixel.")
    x_size = abs(float(transform.a))
    y_size = abs(float(transform.e))
    safe_elevation = np.where(valid, elevation, np.nan).astype(np.float32)
    dy, dx = np.gradient(safe_elevation, y_size, x_size)
    slope_rad = np.arctan(np.hypot(dx, dy))
    slope = np.degrees(slope_rad).astype(np.float32)
    aspect = np.degrees(np.arctan2(-dx, dy))
    aspect = (aspect + 360.0) % 360.0
    azimuth = math.radians(315.0)
    altitude = math.radians(45.0)
    hillshade = (
        np.sin(altitude) * np.cos(slope_rad)
        + np.cos(altitude) * np.sin(slope_rad) * np.cos(azimuth - np.radians(aspect))
    )
    hillshade = np.clip(np.nan_to_num((hillshade + 1.0) * 127.5, nan=0.0), 0, 255).astype(np.uint8)
    for array in (slope, aspect):
        array[~valid_derivative] = np.nan
    hillshade[~valid_derivative] = 0
    return {"slope": slope, "aspect": aspect, "hillshade": hillshade, "derivative_valid": valid_derivative}


def _contours(
    elevation: np.ndarray,
    valid: np.ndarray,
    transform: Any,
    interval: float,
    crs: Any,
    output_dir: Path,
) -> tuple[Path, Path | None, int]:
    """Create contour lines in GeoPackage and a web-friendly GeoJSON copy."""

    finite = elevation[valid & np.isfinite(elevation)]
    if finite.size == 0:
        raise RuntimeError("Không có cao độ hợp lệ để tạo đường đồng mức.")
    low = math.floor(float(np.nanmin(finite)) / interval) * interval
    high = math.ceil(float(np.nanmax(finite)) / interval) * interval
    levels = np.arange(low, high + interval * 0.51, interval, dtype=float)
    if levels.size > MAX_CONTOUR_LEVELS:
        raise RuntimeError(
            f"Số cấp đường đồng mức {levels.size} vượt MAX_CONTOUR_LEVELS={MAX_CONTOUR_LEVELS}; "
            "tăng contour_interval_m."
        )

    height, width = elevation.shape
    x = transform.c + (np.arange(width, dtype=float) + 0.5) * transform.a
    y = transform.f + (np.arange(height, dtype=float) + 0.5) * transform.e
    masked = np.ma.masked_where(~valid | ~np.isfinite(elevation), elevation)
    figure, axis = plt.subplots()
    try:
        contour_set = axis.contour(x, y, masked, levels=levels)
        geometries: list[LineString] = []
        elevations: list[float] = []
        for level, segments in zip(contour_set.levels, contour_set.allsegs):
            for segment in segments:
                if len(segment) < 2:
                    continue
                line = LineString(segment)
                if not line.is_empty and line.length > 0:
                    geometries.append(line)
                    elevations.append(float(level))
    finally:
        plt.close(figure)
    if not geometries:
        raise RuntimeError("Không tạo được đường đồng mức trong AOI.")

    frame = gpd.GeoDataFrame({"elev_m": elevations, "geometry": geometries}, crs=crs)
    gpkg_path = output_dir / "contours.gpkg"
    frame.to_file(gpkg_path, layer="contours", driver="GPKG")
    geojson_path = output_dir / "contours.geojson"
    frame.to_crs(WGS84).to_file(geojson_path, driver="GeoJSON")
    return gpkg_path, geojson_path, len(geometries)


def _rgba_dem(elevation: np.ndarray, valid: np.ndarray, hillshade: np.ndarray | None = None) -> np.ndarray:
    finite = elevation[valid & np.isfinite(elevation)]
    if finite.size == 0:
        return np.zeros((*elevation.shape, 4), dtype=np.uint8)
    normalized = Normalize(vmin=float(np.nanpercentile(finite, 2)), vmax=float(np.nanpercentile(finite, 98)), clip=True)(elevation)
    cmap = plt.get_cmap("terrain")
    rgba = (cmap(np.nan_to_num(normalized, nan=0)) * 255).astype(np.uint8)
    if hillshade is not None:
        shade = np.clip(hillshade.astype(np.float32) / 255.0, 0.55, 1.0)
        rgba[..., :3] = np.clip(rgba[..., :3].astype(np.float32) * shade[..., None], 0, 255).astype(np.uint8)
    rgba[..., 3] = np.where(valid, 235, 0).astype(np.uint8)
    return rgba


def _raster_extent(elevation: np.ndarray, transform: Any) -> tuple[float, float, float, float]:
    west, south, east, north = array_bounds(elevation.shape[0], elevation.shape[1], transform)
    return float(west), float(east), float(south), float(north)


def _write_preview(path: Path, elevation: np.ndarray, valid: np.ndarray, transform: Any, hillshade: np.ndarray | None = None) -> None:
    rgba = _rgba_dem(elevation, valid, hillshade)
    Image.fromarray(rgba, mode="RGBA").save(path, format="PNG", optimize=True)


def _add_scale_bar(axis: Any, width_m: float, height_m: float) -> None:
    length = 1.0
    if width_m > 0:
        rough = width_m / 5.0
        magnitude = 10 ** math.floor(math.log10(max(rough, 1)))
        length = round(rough / magnitude) * magnitude
        if length <= 0:
            length = magnitude
    x0 = 0.06 * width_m
    y0 = 0.05 * height_m
    axis.plot([x0, x0 + length], [y0, y0], color="#172534", linewidth=3, solid_capstyle="butt")
    axis.text(x0 + length / 2, y0 + 0.018 * height_m, f"{length / 1000:g} km" if length >= 1000 else f"{length:g} m", ha="center", va="bottom", fontsize=8, color="#172534")


def _write_publication_map(
    png_path: Path,
    pdf_path: Path,
    elevation: np.ndarray,
    valid: np.ndarray,
    transform: Any,
    crs: Any,
    aoi: BaseGeometry,
    metadata: dict[str, Any],
    hillshade: np.ndarray | None,
    contour_path: Path | None,
) -> None:
    """Render a durable map layout inspired by the supplied publication map."""

    west, east, south, north = _raster_extent(elevation, transform)
    extent = [west, east, south, north]
    frame, axis = plt.subplots(figsize=(11.7, 8.3), constrained_layout=True)
    try:
        rgba = _rgba_dem(elevation, valid, hillshade)
        axis.imshow(rgba, extent=extent, origin="upper", interpolation="nearest")
        aoi_frame = gpd.GeoSeries([aoi], crs=WGS84).to_crs(crs)
        aoi_frame.boundary.plot(ax=axis, color="white", linewidth=2.4, zorder=5)
        aoi_frame.boundary.plot(ax=axis, color="#293b4a", linewidth=0.85, zorder=6)
        if contour_path and contour_path.exists():
            try:
                contours = gpd.read_file(contour_path, layer="contours")
                contours.plot(ax=axis, color="#65401c", linewidth=0.28, alpha=0.66, zorder=4)
            except Exception as error:
                LOGGER.warning("Không vẽ được contour vào publication map: %s", error)

        finite = elevation[valid & np.isfinite(elevation)]
        image = axis.imshow(
            np.ma.masked_where(~valid, elevation),
            extent=extent,
            origin="upper",
            cmap="terrain",
            alpha=0.0,
            interpolation="nearest",
        )
        image.set_clim(float(np.nanpercentile(finite, 2)), float(np.nanpercentile(finite, 98)))
        colorbar = frame.colorbar(image, ax=axis, shrink=0.72, pad=0.02)
        colorbar.set_label("Độ cao (m)")
        axis.set_title("DEM cắt theo ranh giới hành chính", fontsize=16, fontweight="bold", pad=12)
        axis.set_xlabel(f"X ({crs})")
        axis.set_ylabel(f"Y ({crs})")
        axis.grid(color="#516679", linewidth=0.35, alpha=0.35, linestyle="--")
        axis.annotate("N", xy=(0.95, 0.88), xytext=(0.95, 0.76), xycoords="axes fraction", ha="center", va="center", fontsize=15, fontweight="bold", arrowprops={"arrowstyle": "-|>", "lw": 1.5, "color": "#172534"})
        _add_scale_bar(axis, east - west, north - south)
        source_label = metadata.get("dem_source_label", metadata.get("dem_source", "DEM"))
        datum = metadata.get("vertical_crs", "vertical datum theo catalog")
        note = f"Nguồn: {source_label} · surface: DSM · datum: {datum}\nCRS: {crs} · pixel: {metadata.get('resolution_m', '—')} m · NoData: {NODATA:g}"
        frame.text(0.01, 0.01, note, transform=frame.transFigure, fontsize=7.5, color="#334654", va="bottom")
        frame.savefig(png_path, dpi=300, facecolor="white")
        frame.savefig(pdf_path, dpi=300, facecolor="white")
    finally:
        plt.close(frame)


def _image_bbox_wgs84(elevation: np.ndarray, transform: Any, crs: Any) -> list[float]:
    west, south, east, north = array_bounds(elevation.shape[0], elevation.shape[1], transform)
    if str(crs) != WGS84:
        west, south, east, north = transform_bounds(crs, WGS84, west, south, east, north, densify_pts=21)
    return [float(west), float(south), float(east), float(north)]


def run_elevation_pipeline(
    boundary_upload: Path,
    boundary_filename: str,
    parameters: ElevationParameters,
    output_dir: Path,
    public_prefix: str,
) -> dict[str, Any]:
    """Run the complete boundary → DEM → derivatives workflow."""

    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="boundary-", dir=output_dir) as temporary:
        vector_path = prepare_boundary_path(boundary_upload, Path(temporary))
        boundary = load_boundary(vector_path)
    _write_aoi_geojson(output_dir / "aoi.geojson", boundary, boundary_filename)

    selected = select_dem_items(boundary.geometry_wgs84, parameters)
    source_data, source_valid, source_transform, source_crs, native_resolution = _read_dem_mosaic(selected, boundary.geometry_wgs84)
    elevation, valid, transform, analysis_crs, outside_valid = _reproject_dem(
        source_data,
        source_valid,
        source_transform,
        source_crs,
        boundary.geometry_wgs84,
        parameters,
        native_resolution,
    )
    needs_terrain = bool(parameters.products & {"hillshade", "slope", "aspect", "preview", "map"})
    terrain = _terrain_products(elevation, valid, transform) if needs_terrain else {}
    derivative_valid = terrain.get("derivative_valid", np.zeros(valid.shape, dtype=bool))

    source_config = DEM_SOURCES[parameters.dem_source]
    finite = elevation[valid & np.isfinite(elevation)]
    metadata: dict[str, Any] = {
        "operation": "elevation_clip",
        "clip_verified": True,
        "clip_method": "reproject to projected CRS + geometry_mask(all_touched=false) + dataset mask",
        "boundary_filename": boundary_filename,
        "boundary_source_crs": boundary.source_crs,
        "boundary_feature_count": boundary.feature_count,
        "boundary_area_ha": boundary.area_ha,
        "boundary_bbox_wgs84": list(boundary.bbox_wgs84),
        "source": "Open DEM COG via STAC",
        "stac_api": DEM_STAC_API_URL,
        "collection": source_config["collection"],
        "dem_source": parameters.dem_source,
        "dem_source_label": source_config["label"],
        "surface": parameters.surface,
        "surface_type": source_config["surface_type"],
        "vertical_crs": source_config["vertical_crs"],
        "item_ids": [str(tile.item.id) for tile in selected],
        "source_raster_crs": str(source_crs),
        "analysis_crs": str(analysis_crs),
        "resolution_m": float(abs(float(transform.a))),
        "native_resolution_m": native_resolution,
        "nodata": NODATA,
        "image_bbox_wgs84": _image_bbox_wgs84(elevation, transform, analysis_crs),
        "valid_pixel_count": int(np.count_nonzero(valid)),
        "masked_pixel_count": int(np.count_nonzero(~valid)),
        "outside_valid_pixel_count": 0,
        "source_outside_pixel_count_before_mask": outside_valid,
        "dem_min_m": float(np.nanmin(finite)),
        "dem_max_m": float(np.nanmax(finite)),
        "contour_interval_m": parameters.contour_interval_m,
        "aoi_geojson_url": f"{public_prefix}/aoi.geojson",
        "warning": "DSM không phải DTM; không dùng trực tiếp cho mô hình dòng chảy kỹ thuật.",
    }

    dem_format = _write_masked_raster(output_dir / "dem.tif", elevation, valid, transform, analysis_crs, "float32")
    metadata["dem_url"] = f"{public_prefix}/dem.tif"
    metadata["geotiff_url"] = metadata["dem_url"]
    metadata["dem_format"] = dem_format

    contour_path: Path | None = None
    if "contours" in parameters.products or "map" in parameters.products:
        contour_path, contour_geojson, contour_count = _contours(
            elevation,
            valid,
            transform,
            parameters.contour_interval_m,
            analysis_crs,
            output_dir,
        )
        metadata["contour_count"] = contour_count
        metadata["contours_url"] = f"{public_prefix}/contours.gpkg"
        if contour_geojson:
            metadata["contours_geojson_url"] = f"{public_prefix}/contours.geojson"

    if "hillshade" in parameters.products:
        _write_masked_raster(output_dir / "hillshade.tif", terrain["hillshade"], derivative_valid, transform, analysis_crs, "uint8")
        metadata["hillshade_url"] = f"{public_prefix}/hillshade.tif"
    if "slope" in parameters.products:
        _write_masked_raster(output_dir / "slope.tif", terrain["slope"], derivative_valid, transform, analysis_crs, "float32")
        metadata["slope_url"] = f"{public_prefix}/slope.tif"
    if "aspect" in parameters.products:
        _write_masked_raster(output_dir / "aspect.tif", terrain["aspect"], derivative_valid, transform, analysis_crs, "float32")
        metadata["aspect_url"] = f"{public_prefix}/aspect.tif"

    if "preview" in parameters.products:
        _write_preview(output_dir / "preview.png", elevation, valid, transform, terrain["hillshade"])
        metadata["preview_url"] = f"{public_prefix}/preview.png"
        metadata["image_url"] = metadata["preview_url"]
    if "map" in parameters.products:
        _write_publication_map(
            output_dir / "map.png",
            output_dir / "map.pdf",
            elevation,
            valid,
            transform,
            analysis_crs,
            boundary.geometry_wgs84,
            metadata,
            terrain["hillshade"],
            contour_path,
        )
        metadata["map_png_url"] = f"{public_prefix}/map.png"
        metadata["map_pdf_url"] = f"{public_prefix}/map.pdf"

    return {"type": "FeatureCollection", "features": [], "metadata": metadata}
