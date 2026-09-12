"""FastAPI reference service for clipped Sentinel-2/Landsat change results.

The service is intentionally small enough to deploy on Cloud Run, while making
the important spatial invariants explicit:

* the client sends an administrative code, never arbitrary geometry;
* the server resolves that code from a configured Earth Engine asset;
* imagery, vectors and download regions all use the same AOI geometry;
* GeoJSON is WGS84, while reported hectares use an equal-area projection;
* credentials and the Earth Engine asset ID stay outside the public frontend.

For a multi-instance production deployment, replace the in-memory job store
with a durable queue/result store and use Cloud Storage for GeoJSON/COG files.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

import ee
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator


LOGGER = logging.getLogger("vietflex.monitor")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

S2_COLLECTION = "COPERNICUS/S2_SR_HARMONIZED"
LANDSAT_COLLECTION = "LANDSAT/LC09/C02/T1_L2"
AREA_CRS = "EPSG:6933"  # global cylindrical equal-area projection
S2_SCALE = 10
LANDSAT_SCALE = 30
CHANGE_THRESHOLD = 0.15
MAX_AOI_AREA_KM2 = 250_000


def env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_date(value: str) -> datetime:
    return datetime.strptime(value, "%d/%m/%Y").replace(tzinfo=timezone.utc)


class MonitorRequest(BaseModel):
    """Validated API contract shared with the static frontend."""

    model_config = ConfigDict(extra="forbid")

    admin_code: str = Field(min_length=1, max_length=12)
    admin_level: Literal["province", "commune"]
    province_code: str | None = Field(default=None, max_length=12)
    unit_code: str | None = Field(default=None, max_length=12)
    satellite: Literal["s2", "landsat9"] = "s2"
    monitor_type: Literal["-", "+"] = "-"
    start_dk: str
    end_dk: str
    start_ck: str
    end_ck: str
    min_area: float = Field(default=0.1, ge=0)
    max_area: float | None = Field(default=None, ge=0)
    clip_to_admin_boundary: Literal[True] = True
    output: list[Literal["geojson", "geotiff", "png"]] = Field(default_factory=lambda: ["geojson", "geotiff", "png"])

    @model_validator(mode="after")
    def validate_temporal_windows(self) -> "MonitorRequest":
        start_dk = parse_date(self.start_dk)
        end_dk = parse_date(self.end_dk)
        start_ck = parse_date(self.start_ck)
        end_ck = parse_date(self.end_ck)
        if start_dk >= end_dk or start_ck >= end_ck:
            raise ValueError("Mỗi khoảng thời gian phải có ngày bắt đầu trước ngày kết thúc.")
        if end_dk >= start_ck:
            raise ValueError("Khoảng đầu kỳ phải kết thúc trước khoảng cuối kỳ.")
        if self.max_area is not None and self.min_area >= self.max_area:
            raise ValueError("min_area phải nhỏ hơn max_area.")
        if self.admin_level == "commune" and not self.unit_code:
            raise ValueError("unit_code là bắt buộc khi admin_level=commune.")
        if self.unit_code and self.unit_code != self.admin_code:
            raise ValueError("unit_code phải trùng admin_code để tránh clip nhầm AOI.")
        return self


@dataclass
class Job:
    job_id: str
    request: MonitorRequest
    fingerprint: str
    status: str = "queued"
    message: str = "Đã xếp hàng"
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)
    result: dict[str, Any] | None = None
    error: str | None = None


JOBS: dict[str, Job] = {}
FINGERPRINTS: dict[str, str] = {}
JOB_LOCK = threading.Lock()
EXECUTOR = ThreadPoolExecutor(max_workers=env_int("JOB_WORKERS", 2), thread_name_prefix="ee-job")
EE_LOCK = threading.Lock()
EE_INITIALIZED = False


def app_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "http://localhost:8080")
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


app = FastAPI(title="Vietflex Giám sát API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=app_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Accept"],
)


def update_job(job_id: str, **changes: Any) -> None:
    with JOB_LOCK:
        job = JOBS[job_id]
        for key, value in changes.items():
            setattr(job, key, value)
        job.updated_at = utc_now()


def fingerprint(request: MonitorRequest) -> str:
    canonical = json.dumps(request.model_dump(mode="json"), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def prune_jobs_locked() -> None:
    """Keep the reference in-memory store bounded; caller holds JOB_LOCK."""

    ttl_seconds = env_int("JOB_TTL_SECONDS", 3600)
    cutoff = datetime.now(timezone.utc).timestamp() - max(ttl_seconds, 60)
    for job_id, job in list(JOBS.items()):
        try:
            updated = datetime.fromisoformat(job.updated_at).timestamp()
        except ValueError:
            continue
        if updated < cutoff and job.status in {"completed", "failed"}:
            JOBS.pop(job_id, None)
            if FINGERPRINTS.get(job.fingerprint) == job_id:
                FINGERPRINTS.pop(job.fingerprint, None)


def initialize_earth_engine() -> None:
    """Initialize once; deployment supplies ADC or Workload Identity."""

    global EE_INITIALIZED
    if EE_INITIALIZED:
        return
    with EE_LOCK:
        if EE_INITIALIZED:
            return
        project = os.getenv("EE_PROJECT")
        if not project:
            raise RuntimeError("Thiếu EE_PROJECT; backend không được tự suy đoán project.")
        # The Earth Engine client reads GOOGLE_APPLICATION_CREDENTIALS or the
        # runtime's Workload Identity. No credential is ever returned to client.
        ee.Initialize(project=project)
        EE_INITIALIZED = True


def resolve_aoi(request: MonitorRequest) -> tuple[ee.Feature, ee.Geometry]:
    asset_id = os.getenv("EE_ADMIN_ASSET")
    code_field = os.getenv("EE_ADMIN_CODE_FIELD", "code")
    if not asset_id:
        raise RuntimeError("Thiếu EE_ADMIN_ASSET; chưa thể resolve ranh giới hành chính.")
    collection = ee.FeatureCollection(asset_id)
    matches = collection.filter(ee.Filter.eq(code_field, request.admin_code))
    count = int(matches.size().getInfo())
    if count != 1:
        raise RuntimeError(f"AOI {request.admin_code} phải khớp đúng 1 feature, nhận {count}.")
    feature = ee.Feature(matches.first())
    geometry = feature.geometry()
    area_km2 = float(geometry.area(1, AREA_CRS).divide(1_000_000).getInfo())
    if area_km2 <= 0 or area_km2 > MAX_AOI_AREA_KM2:
        raise RuntimeError(f"Diện tích AOI không hợp lệ: {area_km2:.2f} km².")
    return feature, geometry


def to_ee_date(value: str) -> str:
    return parse_date(value).strftime("%Y-%m-%d")


def sentinel_collection(geometry: ee.Geometry, start: str, end: str) -> ee.ImageCollection:
    collection = (
        ee.ImageCollection(S2_COLLECTION)
        .filterBounds(geometry)
        .filterDate(to_ee_date(start), to_ee_date(end))
        .filter(ee.Filter.lte("CLOUDY_PIXEL_PERCENTAGE", 80))
    )

    def mask(image: ee.Image) -> ee.Image:
        scl = image.select("SCL")
        valid = scl.neq(3).And(scl.neq(8)).And(scl.neq(9)).And(scl.neq(10)).And(scl.neq(11))
        return (
            image.updateMask(valid)
            .select(["B4", "B8", "B12"], ["red", "nir", "swir1"])
            .multiply(0.0001)
            .copyProperties(image, ["system:time_start"])
        )

    return collection.map(mask)


def landsat_collection(geometry: ee.Geometry, start: str, end: str) -> ee.ImageCollection:
    collection = (
        ee.ImageCollection(LANDSAT_COLLECTION)
        .filterBounds(geometry)
        .filterDate(to_ee_date(start), to_ee_date(end))
        .filter(ee.Filter.lte("CLOUD_COVER", 80))
    )

    def mask_and_scale(image: ee.Image) -> ee.Image:
        qa = image.select("QA_PIXEL")
        valid = (
            qa.bitwiseAnd(1 << 0).eq(0)
            .And(qa.bitwiseAnd(1 << 1).eq(0))
            .And(qa.bitwiseAnd(1 << 2).eq(0))
            .And(qa.bitwiseAnd(1 << 3).eq(0))
            .And(qa.bitwiseAnd(1 << 4).eq(0))
            .And(qa.bitwiseAnd(1 << 5).eq(0))
        )
        return (
            image.updateMask(valid)
            .select(["SR_B4", "SR_B5", "SR_B6"], ["red", "nir", "swir1"])
            .multiply(0.0000275)
            .add(-0.2)
            .copyProperties(image, ["system:time_start"])
        )

    return collection.map(mask_and_scale)


def spectral_index(collection: ee.ImageCollection) -> ee.Image:
    """Use NBR for forest disturbance/recovery screening."""

    def add_index(image: ee.Image) -> ee.Image:
        return image.normalizedDifference(["nir", "swir1"]).rename("nbr").copyProperties(image, ["system:time_start"])

    return collection.map(add_index).median()


def build_change_result(request: MonitorRequest) -> dict[str, Any]:
    initialize_earth_engine()
    _aoi_feature, geometry = resolve_aoi(request)
    if request.satellite == "s2":
        before_collection = sentinel_collection(geometry, request.start_dk, request.end_dk)
        after_collection = sentinel_collection(geometry, request.start_ck, request.end_ck)
        collection_name = S2_COLLECTION
        scale = S2_SCALE
    else:
        before_collection = landsat_collection(geometry, request.start_dk, request.end_dk)
        after_collection = landsat_collection(geometry, request.start_ck, request.end_ck)
        collection_name = LANDSAT_COLLECTION
        scale = LANDSAT_SCALE

    counts = {
        "before": int(before_collection.size().getInfo()),
        "after": int(after_collection.size().getInfo()),
    }
    if not counts["before"] or not counts["after"]:
        raise RuntimeError(f"Không đủ cảnh ảnh sau lọc mây: before={counts['before']}, after={counts['after']}.")

    before = spectral_index(before_collection).clip(geometry)
    after = spectral_index(after_collection).clip(geometry)
    delta = after.subtract(before).rename("delta")
    forest_mask = before.gt(0.2)
    direction = delta.gte(CHANGE_THRESHOLD) if request.monitor_type == "+" else delta.lte(-CHANGE_THRESHOLD)
    change_mask = direction.And(forest_mask).selfMask()

    # The same server-side AOI is used for mask, vectorization and downloads.
    clipped_change = change_mask.clip(geometry)
    vectors = clipped_change.reduceToVectors(
        geometry=geometry,
        scale=scale,
        geometryType="polygon",
        eightConnected=True,
        labelProperty="change",
        reducer=ee.Reducer.countEvery(),
        maxPixels=1e13,
    )

    def add_area(feature: ee.Feature) -> ee.Feature:
        area_ha = feature.geometry().area(1, AREA_CRS).divide(10_000)
        return feature.set({
            "area_ha": area_ha,
            "confidence": 80,
            "monitor_type": request.monitor_type,
            "monitor_label": "Biến động tăng" if request.monitor_type == "+" else "Biến động giảm",
            "satellite": "Sentinel 2" if request.satellite == "s2" else "Landsat 9",
            "change_index": "NBR",
        })

    vectors = vectors.map(add_area).filter(ee.Filter.gte("area_ha", request.min_area))
    if request.max_area is not None:
        vectors = vectors.filter(ee.Filter.lte("area_ha", request.max_area))
    vector_count = int(vectors.size().getInfo())
    max_features = env_int("MAX_RESULT_FEATURES", 3000)
    if vector_count > max_features:
        raise RuntimeError(f"Kết quả có {vector_count} vùng; hãy tăng min_area hoặc dùng vector tiles.")

    feature_collection = vectors.getInfo()
    for index, feature in enumerate(feature_collection.get("features", []), start=1):
        properties = feature.setdefault("properties", {})
        properties.setdefault("id", f"GS-{index:04d}")
        properties.setdefault("name", f"Vùng {index:04d}")
        properties["locality"] = request.admin_code
        properties["period"] = f"{request.start_ck} — {request.end_ck}"
        geometry_info = feature.get("geometry")
        if not geometry_info:
            raise RuntimeError("Vector kết quả thiếu geometry; từ chối trả dữ liệu không thể kiểm tra.")

    metadata: dict[str, Any] = {
        "source": "Google Earth Engine",
        "collection": collection_name,
        "sensor": request.satellite,
        "index": "NBR",
        "threshold": CHANGE_THRESHOLD,
        "cloud_mask": "S2 SCL classes 3/8/9/10/11; Landsat QA_PIXEL bits 0–5",
        "periods": {"before": [request.start_dk, request.end_dk], "after": [request.start_ck, request.end_ck]},
        "aoi_code": request.admin_code,
        "admin_code": request.admin_code,
        "clip_verified": True,
        "clip_method": "ee.Image.clip(AOI) + reduceToVectors(geometry=AOI)",
        "area_crs": AREA_CRS,
        "area_unit": "ha",
        "analysis_scale_m": scale,
        "scene_counts": counts,
        "vector_count": vector_count,
        "created_at": utc_now(),
    }

    if "png" in request.output:
        try:
            visual = clipped_change.visualize(min=0, max=1, palette=["#ef8a75"])
            metadata["image_url"] = visual.getThumbURL({
                "region": geometry,
                "dimensions": 2048,
                "format": "png",
                "crs": "EPSG:4326",
            })
        except Exception as error:  # URL generation is optional; vector result remains valid.
            LOGGER.warning("Không tạo được PNG thumbnail: %s", error)
    if "geotiff" in request.output:
        try:
            metadata["geotiff_url"] = clipped_change.toByte().getDownloadURL({
                "name": f"vietflex-{request.admin_code}-{uuid.uuid4().hex[:8]}",
                "region": geometry,
                "scale": scale,
                "crs": "EPSG:4326",
                "format": "GEO_TIFF",
                "filePerBand": False,
            })
        except Exception as error:  # Large AOIs should use an EE batch export instead.
            LOGGER.warning("Không tạo được GeoTIFF URL tức thời: %s", error)
            metadata["geotiff_note"] = "AOI lớn cần chuyển sang Earth Engine batch export/Cloud Storage."

    return {"type": "FeatureCollection", "features": feature_collection.get("features", []), "metadata": metadata}


def run_job(job_id: str) -> None:
    update_job(job_id, status="running", message="Đang resolve AOI và lọc ảnh vệ tinh…")
    try:
        result = build_change_result(JOBS[job_id].request)
        update_job(job_id, status="completed", message="Đã clip và tổng hợp kết quả.", result=result)
    except Exception as error:  # The error is captured per job and never leaks credentials.
        LOGGER.exception("Job %s failed", job_id)
        update_job(job_id, status="failed", message="Job thất bại.", error=str(error))


def job_status(job: Job) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "job_id": job.job_id,
        "status": job.status,
        "message": job.message,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "status_url": f"/api/v1/monitor/jobs/{job.job_id}",
    }
    if job.status == "completed":
        payload["result_url"] = f"/api/v1/monitor/jobs/{job.job_id}/results.geojson"
        payload["metadata"] = job.result.get("metadata", {}) if job.result else {}
    if job.status == "failed":
        payload["error"] = job.error or "Unknown error"
    return payload


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "vietflex-monitor"}


@app.post("/api/v1/monitor/jobs", status_code=202)
def create_monitor_job(request: MonitorRequest) -> dict[str, Any]:
    key = fingerprint(request)
    with JOB_LOCK:
        prune_jobs_locked()
        existing_id = FINGERPRINTS.get(key)
        if existing_id and existing_id in JOBS and JOBS[existing_id].status in {"queued", "running", "completed"}:
            return job_status(JOBS[existing_id])
        job_id = uuid.uuid4().hex
        JOBS[job_id] = Job(job_id=job_id, request=request, fingerprint=key)
        FINGERPRINTS[key] = job_id
    EXECUTOR.submit(run_job, job_id)
    return job_status(JOBS[job_id])


@app.get("/api/v1/monitor/jobs/{job_id}")
def get_monitor_job(job_id: str) -> dict[str, Any]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Không tìm thấy job.")
    return job_status(job)


@app.get("/api/v1/monitor/jobs/{job_id}/results.geojson")
def get_monitor_result(job_id: str) -> JSONResponse:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Không tìm thấy job.")
    if job.status != "completed" or not job.result:
        raise HTTPException(status_code=409, detail=f"Job chưa hoàn tất: {job.status}.")
    return JSONResponse(content=job.result, media_type="application/geo+json")
