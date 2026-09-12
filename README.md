# Vietflex Map · Giám sát rừng

WebGIS tĩnh tái tạo luồng giao diện của [gsrvn.ifee.edu.vn/country](https://gsrvn.ifee.edu.vn/country/) và tối ưu lại cho màn hình máy tính, máy tính bảng và điện thoại.

## Đã triển khai

- Bộ lọc địa bàn ba cấp: tỉnh/thành phố → quận/huyện/thị xã → xã/phường/thị trấn.
- Chọn Sentinel‑2 hoặc Landsat 9, loại biến động tăng/giảm.
- Hai khoảng thời gian `dd/mm/yyyy`, kiểm tra ngày không hợp lệ, ngày tương lai và khoảng chồng lấn.
- Lọc diện tích nhỏ nhất/lớn nhất theo ha.
- Bản đồ Leaflet với nền sáng, nền tối, ảnh vệ tinh, ranh giới, lưới tọa độ và vùng biến động.
- Bảng kết quả gồm số vùng, tổng diện tích, vùng lớn nhất, độ tin cậy trung bình và danh sách có thể phóng đến từng vùng.
- Tải kết quả GeoJSON và CSV; popup hiển thị thuộc tính từng vùng.
- Giao diện responsive, keyboard shortcut `Ctrl/⌘ + K`, định vị, toàn màn hình và hướng dẫn nhanh.

## Chạy cục bộ

Mở `index.html` bằng một web server tĩnh để trình duyệt tải đúng các module và tile bản đồ:

```bash
python3 -m http.server 8080
```

Sau đó truy cập `http://localhost:8080`.

## Chế độ dữ liệu

Repository này là front-end static-first. Khi chưa cấu hình API, nút **Tính toán** dùng một bộ dữ liệu minh họa được tạo cố định theo bộ lọc; mục đích là kiểm tra đầy đủ UX/UI, popup, thống kê và chức năng tải xuống. Đây không phải kết quả phân tích Sentinel‑2 thực.

Để nối hệ thống xử lý ảnh thật, thêm cấu hình trước `assets/app.js` hoặc ngay trước thẻ script của file này:

```html
<script>
  window.GIAM_SAT_CONFIG = {
    apiBase: "https://api.example.vn",
    apiPath: "/api/monitor",
    demoMode: false
  };
</script>
```

Client gửi `POST /api/monitor` với JSON:

```json
{
  "province_code": "1",
  "district_code": "",
  "commune_code": "",
  "satellite": "s2",
  "monitor_type": "-",
  "start_dk": "11/03/2026",
  "end_dk": "11/06/2026",
  "start_ck": "12/06/2026",
  "end_ck": "12/09/2026",
  "min_area": 0.1,
  "max_area": null
}
```

API cần trả về GeoJSON `FeatureCollection`. Các thuộc tính tối thiểu của mỗi feature:

```json
{
  "type": "Feature",
  "properties": {
    "id": "GS-001",
    "name": "Vùng 01",
    "locality": "Huyện Ba Vì",
    "area_ha": 1.42,
    "confidence": 91,
    "monitor_type": "-",
    "monitor_label": "Biến động giảm",
    "satellite": "Sentinel 2",
    "period": "12/06/2026 — 12/09/2026",
    "centroid": "21.15200, 105.42400"
  },
  "geometry": { "type": "Polygon", "coordinates": [] }
}
```

Backend production nên chịu trách nhiệm cho STAC/Earth Engine, lọc mây, đồng chuẩn hóa ảnh, tính chỉ số (ví dụ NDVI/NBR), phát hiện thay đổi, khử nhiễu theo diện tích, chuyển polygon về CRS đo diện tích phù hợp và ghi nhận nguồn ảnh/thời điểm xử lý. Front-end chỉ hiển thị kết quả GeoJSON đã được kiểm tra.

## Đối chiếu source gốc

Source gốc sử dụng Alpine.js, HTMX, Choice.js và Flatpickr; form gọi các endpoint `/map_and_subunits/`, `/initial/1` và `/deforest_country_watch/`. Bản này giữ lại cấu trúc nghiệp vụ chính nhưng chuyển phần vỏ sang static WebGIS để có thể chạy độc lập trên GitHub Pages. Khi có backend mới, chỉ cần thay `GIAM_SAT_CONFIG` và danh mục địa giới bằng dữ liệu API chính thức.

## Bản quyền dữ liệu nền

Nền sáng/tối dùng OpenStreetMap/CARTO; nền ảnh vệ tinh dùng Esri World Imagery. Hãy giữ attribution và kiểm tra điều khoản dịch vụ trước khi triển khai thương mại.

Thiết kế: **Long Ngo · Vietflex Map**.

## Bật GitHub Pages

Workflow triển khai được đặt tại `.github/workflows/pages.yml` và đang để chế độ chạy thủ công để tránh lỗi khi Pages chưa được bật. Vào `Settings → Pages`, chọn `Source: GitHub Actions`, sau đó vào tab `Actions` và chạy `Deploy Vietflex Map WebGIS`. Những lần cập nhật sau có thể đổi trigger sang `push` trên nhánh `main` nếu muốn tự động triển khai.
