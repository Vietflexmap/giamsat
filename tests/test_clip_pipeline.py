"""Focused tests for the boundary/clip invariants."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from zipfile import ZipFile

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import geometry_mask
from rasterio.transform import from_origin
from shapely.geometry import Polygon, mapping

from backend.clip_pipeline import (
    WGS84,
    _read_asset,
    load_boundary,
    parse_user_date,
    prepare_boundary_path,
    run_clip_pipeline,
    SelectedItem,
    validate_clip_parameters,
)


def test_parse_user_date_supports_ui_and_iso() -> None:
    assert parse_user_date("12/09/2026").isoformat() == "2026-09-12"
    assert parse_user_date("2026-09-12").isoformat() == "2026-09-12"


def test_clip_parameters_reject_invalid_sensor() -> None:
    try:
        validate_clip_parameters("modis", "01/01/2026", "02/01/2026", 80, "png", "true_color")
    except ValueError as error:
        assert "satellite" in str(error)
    else:
        raise AssertionError("invalid sensor was accepted")


def test_load_boundary_requires_crs_and_dissolves_polygon(tmp_path: Path) -> None:
    first = Polygon([(105.0, 21.0), (105.02, 21.0), (105.02, 21.02), (105.0, 21.02)])
    second = Polygon([(105.02, 21.0), (105.04, 21.0), (105.04, 21.02), (105.02, 21.02)])
    path = tmp_path / "boundary.geojson"
    gpd.GeoDataFrame({"name": ["a", "b"]}, geometry=[first, second], crs=WGS84).to_file(path, driver="GeoJSON")

    boundary = load_boundary(path)

    assert boundary.source_crs == WGS84
    assert boundary.feature_count == 2
    assert boundary.area_ha > 0
    assert boundary.geometry_wgs84.geom_type in {"Polygon", "MultiPolygon"}


def test_standalone_shp_is_rejected(tmp_path: Path) -> None:
    shp = tmp_path / "boundary.shp"
    shp.write_bytes(b"not-a-shapefile")
    try:
        prepare_boundary_path(shp, tmp_path / "work")
    except ValueError as error:
        assert "ZIP" in str(error)
    else:
        raise AssertionError("standalone shp was accepted")


def test_zip_shapefile_requires_and_reads_sidecars(tmp_path: Path) -> None:
    polygon = Polygon([(105.0, 21.0), (105.03, 21.0), (105.03, 21.03), (105.0, 21.03)])
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    shapefile_path = source_dir / "boundary.shp"
    gpd.GeoDataFrame({"name": ["test"]}, geometry=[polygon], crs=WGS84).to_file(shapefile_path, driver="ESRI Shapefile")
    archive_path = tmp_path / "boundary.zip"
    with ZipFile(archive_path, "w") as archive:
        for sidecar in source_dir.glob("boundary.*"):
            archive.write(sidecar, sidecar.name)

    extracted = prepare_boundary_path(archive_path, tmp_path / "work")
    boundary = load_boundary(extracted)

    assert extracted.suffix.lower() == ".shp"
    assert boundary.feature_count == 1
    assert boundary.source_crs == WGS84


def test_read_asset_masks_pixels_outside_aoi(tmp_path: Path) -> None:
    raster_path = tmp_path / "image.tif"
    transform = from_origin(105.0, 21.1, 0.01, 0.01)
    data = np.ones((10, 10), dtype=np.uint16) * 10000
    profile = {
        "driver": "GTiff",
        "height": 10,
        "width": 10,
        "count": 1,
        "dtype": "uint16",
        "crs": WGS84,
        "transform": transform,
        "nodata": 0,
    }
    with rasterio.open(raster_path, "w", **profile) as dataset:
        dataset.write(data, 1)

    aoi = Polygon([(105.02, 21.02), (105.06, 21.02), (105.06, 21.08), (105.02, 21.08)])
    values, valid, clipped_transform, crs = _read_asset(str(raster_path), aoi, 0.0001, 0.0)
    inside = geometry_mask([mapping(aoi)], out_shape=valid.shape, transform=clipped_transform, invert=True)

    assert crs.to_string() == WGS84
    assert values.shape == valid.shape
    assert np.count_nonzero(valid) > 0
    assert np.count_nonzero(valid & ~inside) == 0
    assert np.nanmax(values[valid]) == 1.0


def test_full_pipeline_writes_masked_outputs_without_remote_stac(tmp_path: Path, monkeypatch) -> None:
    boundary_polygon = Polygon([(105.02, 21.02), (105.06, 21.02), (105.06, 21.08), (105.02, 21.08)])
    boundary_path = tmp_path / "boundary.geojson"
    gpd.GeoDataFrame({"name": ["test"]}, geometry=[boundary_polygon], crs=WGS84).to_file(boundary_path, driver="GeoJSON")

    transform = from_origin(105.0, 21.1, 0.01, 0.01)
    profile = {
        "driver": "GTiff",
        "height": 10,
        "width": 10,
        "count": 1,
        "dtype": "uint16",
        "crs": WGS84,
        "transform": transform,
        "nodata": 0,
    }
    asset_paths = {}
    for index, name in enumerate(("red", "green", "blue"), start=1):
        asset_path = tmp_path / f"{name}.tif"
        with rasterio.open(asset_path, "w", **profile) as dataset:
            dataset.write(np.full((10, 10), 8000 + index * 500, dtype=np.uint16), 1)
        asset_paths[name] = str(asset_path)

    item = SimpleNamespace(
        id="synthetic-item",
        datetime=datetime(2026, 9, 1, tzinfo=timezone.utc),
        properties={"eo:cloud_cover": 2.0},
    )
    monkeypatch.setattr(
        "backend.clip_pipeline.select_stac_item",
        lambda _aoi, _parameters: SelectedItem(item, "synthetic", asset_paths, 2.0),
    )
    parameters = validate_clip_parameters("s2", "01/09/2026", "10/09/2026", 80, "geotiff,png,geojson", "true_color")
    output_dir = tmp_path / "output"

    result = run_clip_pipeline(boundary_path, "boundary.geojson", parameters, output_dir, "/api/v1/files/job")

    assert result["metadata"]["clip_verified"] is True
    assert result["metadata"]["valid_pixel_count"] > 0
    assert (output_dir / "clip.tif").exists()
    assert (output_dir / "clip.png").exists()
    assert (output_dir / "aoi.geojson").exists()
    with rasterio.open(output_dir / "clip.tif") as dataset:
        assert dataset.count == 3
        assert dataset.nodata == -9999
        assert dataset.read_masks(1).max() == 255
