# Backend cắt ảnh theo ranh giới

Backend ưu tiên mã nguồn mở cho WebGIS Vietflex: nhận ZIP Shapefile hoặc
GeoJSON, kiểm tra hình học/CRS, tìm ảnh và DEM mở qua STAC, rồi cắt server-side
bằng Rasterio. Earth Engine chỉ còn là phần tùy chọn cho route giám sát biến
động cũ.

## Luồng cắt ảnh

```text
ZIP (.shp + .shx + .dbf + .prj)
  → giải nén an toàn
  → đọc CRS + make_valid + dissolve
  → STAC search Sentinel-2 L2A / Landsat 9 C2 L2
  → đọc COG qua HTTP range
  → rasterio.mask.mask(AOI, crop=True)
  → masked GeoTIFF/COG + RGBA PNG + AOI GeoJSON
```

## Luồng DEM/DSM

```text
admin_code hoặc ZIP Shapefile
  → geometry chuẩn + make_valid + dissolve
  → STAC search tile Copernicus DEM/NASADEM/ALOS
  → mosaic COG → CRS phẳng UTM cục bộ
  → geometry_mask(AOI, all_touched=false) → crop + kiểm tra ngoài AOI
  → DEM COG + hillshade/slope + contour GeoPackage
  → preview PNG + bản đồ xuất bản PNG/PDF
```

Các nguồn global được khai báo là **DSM/DSM-like**, không tự đổi thành DTM.
`resolution_m` không được nhỏ hơn độ phân giải tile nguồn để tránh quảng bá
nội suy thành độ phân giải thực. `output_crs=auto` chọn UTM cục bộ theo AOI
để slope và khoảng cách contour có đơn vị mét.

API chính:

```text
POST /api/v1/clip/jobs                 multipart/form-data
GET  /api/v1/clip/jobs/{job_id}
GET  /api/v1/clip/jobs/{job_id}/results.geojson
GET  /api/v1/files/{job_id}/clip.tif
GET  /api/v1/files/{job_id}/clip.png
```

API DEM:

```text
POST /api/v1/elevation/jobs
GET  /api/v1/elevation/jobs/{job_id}
GET  /api/v1/elevation/jobs/{job_id}/results.geojson
GET  /api/v1/files/{job_id}/dem.tif
GET  /api/v1/files/{job_id}/preview.png
GET  /api/v1/files/{job_id}/map.pdf
```

Ví dụ trường multipart:

```text
boundary_file = ranh_gioi.zip
satellite     = s2                 # s2 | landsat9
start_date    = 12/06/2026
end_date      = 12/09/2026
cloud_max     = 80
output        = geotiff,png,geojson
render_mode   = true_color
```

## Shapefile đầu vào

Không tải `.shp` đơn lẻ. Một Shapefile đầy đủ tối thiểu phải có các file cùng
tên:

```text
ranh_gioi.shp
ranh_gioi.shx
ranh_gioi.dbf
ranh_gioi.prj
```

Backend từ chối archive có đường dẫn nguy hiểm, nhiều lớp `.shp`, thiếu `.prj`,
CRS không xác định, hình học rỗng hoặc hình học không phải Polygon/
MultiPolygon. Hình học lỗi được sửa bằng `shapely.make_valid`, sau đó dissolve
thành một AOI. Diện tích được tính trong `EPSG:6933`; tọa độ ảnh/GeoJSON giữ
theo CRS nguồn raster hoặc WGS84 tương ứng.

## Ảnh mở và STAC

Mặc định dùng Microsoft Planetary Computer STAC:

- Sentinel-2 L2A: collection `sentinel-2-l2a`, band B04/B03/B02.
- Landsat 9 Collection 2 Level-2: collection `landsat-c2-l2`, lọc
  `platform=landsat-9`, band red/green/blue.
- Chọn cảnh giao AOI có mây dưới `cloud_max`, ưu tiên cảnh ít mây nhất.
- Asset COG được đọc theo HTTP range; Planetary Computer được ký URL tự động
  khi `STAC_SIGN_ASSETS=true`.

Đây là chế độ cắt ảnh một cảnh ít mây, không phải composite thay đổi đa thời
gian. Route `/api/v1/monitor/jobs` vẫn giữ pipeline Earth Engine NBR cũ và
cần cài thêm `requirements-ee.txt` cùng cấu hình asset/credentials.

### Cấu hình ranh giới theo mã

`admin.json` và PMTiles của frontend chỉ phục vụ tra cứu/hiển thị. Để gọi
DEM bằng dropdown tỉnh/xã, đặt một GeoPackage, GeoJSON hoặc Shapefile có đúng
một Polygon/MultiPolygon cho mỗi mã:

```text
ADMIN_BOUNDARIES_PATH=./data/vn_admin_boundaries.gpkg
ADMIN_CODE_FIELD=code
DEM_STAC_API_URL=https://planetarycomputer.microsoft.com/api/stac/v1
DEM_COP_COLLECTION=cop-dem-glo-30
DEM_NASA_COLLECTION=nasadem
DEM_ALOS_COLLECTION=alos-dem
```

Nếu chưa cấu hình dataset máy chủ, tải ZIP gồm `.shp`, `.shx`, `.dbf`, `.prj`
trên giao diện. Backend từ chối ghép tên/centroid vì đó không phải geometry
đủ chính xác để cắt ảnh.

## Chạy local

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app:app --host 0.0.0.0 --port 8080
```

Frontend cần trỏ tới API thật:

```html
<script>
  window.GIAM_SAT_CONFIG = {
    apiBase: "https://api.example.vn",
    clipPath: "/api/v1/clip/jobs",
    elevationPath: "/api/v1/elevation/jobs",
    demoMode: false
  };
</script>
```

## Kiểm tra đầu ra

Job chỉ đặt `clip_verified=true` sau khi:

1. Shapefile có CRS và hình học Polygon hợp lệ;
2. các band được đọc trên cùng lưới pixel;
3. `rasterio.mask.mask` dùng chính AOI đã dissolve;
4. pixel hợp lệ ngoài AOI bằng 0;
5. GeoTIFF có `nodata=-9999` và dataset mask, PNG có alpha bằng 0 ngoài AOI.

GeoTIFF vẫn có khung pixel chữ nhật theo quy luật raster; phần ngoài polygon
là NoData/mask, không phải hình ảnh chữ nhật còn dữ liệu ngoài ranh giới.

Với DEM, job còn kiểm tra tile cùng CRS, chuyển sang CRS phẳng theo mét,
không dùng `all_touched=true`, ghi `outside_valid_pixel_count=0` và xuất
metadata về nguồn, vertical datum, độ phân giải nguồn/thực tế, NoData và số
pixel hợp lệ. Bản đồ PNG/PDF có viền AOI hai lớp (halo trắng + nét tối) để
không bị lem trên nền hillshade; đây chỉ là bố cục bản đồ, không thay đổi dữ
liệu raster.

## Triển khai

Docker mặc định chạy route STAC mở, không cần API key Earth Engine. Dữ liệu
đầu ra đang lưu trên local disk và job store trong RAM để dễ chạy thử. Khi
triển khai nhiều instance, thay bằng Redis/PostgreSQL + hàng đợi và Cloud
Storage/S3 cho COG; đặt TTL để xóa file ranh giới và ảnh tạm. Cần đặt
`MPLBACKEND=Agg` trong môi trường headless để xuất PNG/PDF ổn định.

Không ghi service-account JSON, token STAC, API key hay dữ liệu Shapefile của
người dùng vào log hoặc repository. Giới hạn upload, CORS theo đúng domain
GitHub Pages và bật HTTPS.
