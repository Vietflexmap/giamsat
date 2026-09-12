# Backend clip AOI

`app.py` là service tham chiếu FastAPI cho Cloud Run hoặc máy chủ Python có HTTPS.

## Chuẩn bị Earth Engine asset

Tạo một `ee.FeatureCollection` cấp quyền truy cập cho runtime, gồm một feature cho mỗi mã ĐVHC trong snapshot giao diện:

```text
code: string, unique
level: "province" | "commune"
name: string
province_code: string
```

`EE_ADMIN_CODE_FIELD` phải trỏ vào trường `code`. Không lấy geometry do browser gửi lên làm nguồn sự thật. Nếu cần đưa bộ địa giới vào Earth Engine, hãy dùng quy trình ETL có kiểm tra số dòng, mã trùng, hình học hợp lệ, CRS và phiên bản nguồn trước khi upload.

## Credentials

Local development dùng `gcloud auth application-default login` hoặc service account được mount ngoài repository. Cloud Run nên dùng Workload Identity/service account gắn với Earth Engine project. Không đặt private key trong `.env`, log hoặc phản hồi API.

## Chạy

```bash
cp .env.example .env
uvicorn app:app --host 0.0.0.0 --port 8080
```

API trả job bất đồng bộ vì composite/vector hóa có thể lâu. Bản mẫu lưu job trong RAM; production cần queue + Redis/Postgres, idempotency key và Cloud Storage cho COG/GeoJSON lớn.

## Kiểm tra clip

Job chỉ báo hoàn tất sau khi:

1. `admin_code` khớp đúng một feature trong asset;
2. composite và change mask đã gọi `.clip(AOI)`;
3. `reduceToVectors` nhận `geometry=AOI`;
4. thumbnail/GeoTIFF nhận `region=AOI`;
5. response có `clip_verified: true` và `admin_code` tương ứng.

`EPSG:4326` chỉ dùng cho GeoJSON/web display. Hectare tính theo `EPSG:6933`, không tính trực tiếp từ độ kinh/vĩ.
