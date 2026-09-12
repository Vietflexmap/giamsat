"""API contract tests with the remote STAC worker replaced by a stub."""

from __future__ import annotations

import shutil

from fastapi.testclient import TestClient

import backend.app as service


def test_clip_job_upload_poll_and_result(monkeypatch) -> None:
    def fake_pipeline(boundary_upload, boundary_filename, parameters, output_dir, public_prefix):
        return {
            "type": "FeatureCollection",
            "features": [],
            "metadata": {"operation": "clip", "clip_verified": True, "boundary_filename": boundary_filename},
        }

    monkeypatch.setattr(service, "run_clip_pipeline", fake_pipeline)
    with TestClient(service.app) as client:
        response = client.post(
            "/api/v1/clip/jobs",
            files={"boundary_file": ("boundary.shp", b"stand-in", "application/octet-stream")},
            data={"satellite": "s2", "start_date": "01/09/2026", "end_date": "10/09/2026"},
        )
        assert response.status_code == 202
        job_id = response.json()["job_id"]
        status = client.get(f"/api/v1/clip/jobs/{job_id}").json()
        assert status["status"] == "completed"
        assert status["metadata"]["clip_verified"] is True
        result = client.get(f"/api/v1/clip/jobs/{job_id}/results.geojson")
        assert result.status_code == 200
        assert result.json()["metadata"]["operation"] == "clip"
    shutil.rmtree(service.OUTPUT_ROOT / job_id, ignore_errors=True)


def test_elevation_job_upload_poll_and_result(monkeypatch) -> None:
    def fake_pipeline(boundary_upload, boundary_filename, parameters, output_dir, public_prefix):
        assert boundary_upload.exists()
        assert parameters.dem_source == "cop-dem-glo30"
        return {
            "type": "FeatureCollection",
            "features": [],
            "metadata": {
                "operation": "elevation_clip",
                "clip_verified": True,
                "boundary_filename": boundary_filename,
                "image_bbox_wgs84": [105.0, 21.0, 105.1, 21.1],
            },
        }

    monkeypatch.setattr(service, "run_elevation_pipeline", fake_pipeline)
    with TestClient(service.app) as client:
        response = client.post(
            "/api/v1/elevation/jobs",
            files={"boundary_file": ("boundary.geojson", b"stand-in", "application/geo+json")},
            data={"dem_source": "cop-dem-glo30", "products": "dem,preview", "contour_interval_m": "10"},
        )
        assert response.status_code == 202
        job_id = response.json()["job_id"]
        status = client.get(f"/api/v1/elevation/jobs/{job_id}").json()
        assert status["status"] == "completed"
        assert status["metadata"]["clip_verified"] is True
        result = client.get(f"/api/v1/elevation/jobs/{job_id}/results.geojson")
        assert result.status_code == 200
        assert result.json()["metadata"]["operation"] == "elevation_clip"
    shutil.rmtree(service.OUTPUT_ROOT / job_id, ignore_errors=True)
