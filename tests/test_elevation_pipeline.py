"""Offline tests for the open DEM/DSM clipping pipeline."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import geopandas as gpd
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import Polygon

from backend.elevation_pipeline import (
    SelectedDemItem,
    resolve_admin_boundary_path,
    run_elevation_pipeline,
    validate_elevation_parameters,
)


WGS84 = "EPSG:4326"


def test_validate_dem_rejects_fake_resolution() -> None:
    with pytest.raises(ValueError, match="nhỏ hơn độ phân giải nguồn"):
        validate_elevation_parameters("cop-dem-glo30", "dsm", "dem", 10, "auto", 10)


def test_admin_code_resolver_requires_exact_feature(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "admin.gpkg"
    gpd.GeoDataFrame(
        {"code": ["A-1", "A-2"]},
        geometry=[
            Polygon([(105, 21), (105.02, 21), (105.02, 21.02), (105, 21.02)]),
            Polygon([(105.02, 21), (105.04, 21), (105.04, 21.02), (105.02, 21.02)]),
        ],
        crs=WGS84,
    ).to_file(source, layer="admin", driver="GPKG")
    monkeypatch.setenv("ADMIN_BOUNDARIES_PATH", str(source))
    monkeypatch.setenv("ADMIN_CODE_FIELD", "code")

    output, source_name = resolve_admin_boundary_path("A-2", tmp_path / "resolved")

    assert output.exists()
    assert source_name == "admin.gpkg"
    resolved = gpd.read_file(output)
    assert len(resolved) == 1
    assert str(resolved.iloc[0]["code"]) == "A-2"


def test_admin_code_resolver_does_not_guess_geometry(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("ADMIN_BOUNDARIES_PATH", raising=False)
    with pytest.raises(RuntimeError, match="ADMIN_BOUNDARIES_PATH"):
        resolve_admin_boundary_path("A-2", tmp_path)


def test_full_dem_pipeline_masks_aoi_and_writes_publication_outputs(tmp_path: Path, monkeypatch) -> None:
    boundary_polygon = Polygon([(105.02, 21.02), (105.06, 21.02), (105.06, 21.08), (105.04, 21.08), (105.02, 21.05)])
    boundary_path = tmp_path / "boundary.geojson"
    gpd.GeoDataFrame({"name": ["test"]}, geometry=[boundary_polygon], crs=WGS84).to_file(boundary_path, driver="GeoJSON")

    dem_path = tmp_path / "dem-source.tif"
    transform = from_origin(105.0, 21.1, 0.0025, 0.0025)
    height, width = 40, 40
    rows, cols = np.indices((height, width))
    data = (100.0 + rows * 1.7 + cols * 0.9).astype(np.float32)
    profile = {
        "driver": "GTiff",
        "height": height,
        "width": width,
        "count": 1,
        "dtype": "float32",
        "crs": WGS84,
        "transform": transform,
        "nodata": -9999.0,
    }
    with rasterio.open(dem_path, "w", **profile) as dataset:
        dataset.write(data, 1)

    item = SimpleNamespace(
        id="synthetic-dem",
        datetime=datetime(2026, 9, 1, tzinfo=timezone.utc),
        properties={},
    )
    monkeypatch.setattr(
        "backend.elevation_pipeline.select_dem_items",
        lambda _aoi, _parameters: [SelectedDemItem(item, "synthetic", str(dem_path))],
    )
    parameters = validate_elevation_parameters(
        "cop-dem-glo30",
        "dsm",
        "dem,hillshade,slope,aspect,contours,map,preview,geojson",
        5,
        "auto",
    )
    output_dir = tmp_path / "output"

    result = run_elevation_pipeline(boundary_path, "boundary.geojson", parameters, output_dir, "/api/v1/files/job")

    metadata = result["metadata"]
    assert metadata["operation"] == "elevation_clip"
    assert metadata["clip_verified"] is True
    assert metadata["outside_valid_pixel_count"] == 0
    assert metadata["valid_pixel_count"] > 0
    assert metadata["masked_pixel_count"] > 0
    assert metadata["analysis_crs"].startswith("EPSG:326")
    for filename in ("dem.tif", "hillshade.tif", "slope.tif", "aspect.tif", "preview.png", "map.png", "map.pdf", "aoi.geojson", "contours.gpkg", "contours.geojson"):
        assert (output_dir / filename).exists(), filename
    with rasterio.open(output_dir / "dem.tif") as dataset:
        values = dataset.read(1)
        mask = dataset.read_masks(1) > 0
        assert dataset.nodata == -9999
        assert np.count_nonzero(mask) == metadata["valid_pixel_count"]
        assert np.all(values[~mask] == -9999)
