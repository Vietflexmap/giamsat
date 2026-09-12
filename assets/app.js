/*
 * Vietflex Map — Giám sát rừng
 * A static-first WebGIS interface. Set window.GIAM_SAT_CONFIG.apiBase to connect
 * an image-processing service; without it the application uses deterministic
 * browser-side sample features so the UX remains testable on GitHub Pages.
 */
(function () {
  "use strict";

  const CONFIG = Object.assign({
    apiBase: "",
    demoMode: true,
    apiPath: "/api/monitor"
  }, window.GIAM_SAT_CONFIG || {});

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const PROVINCES = [
    ["1", "Thành phố Hà Nội"], ["2", "Tỉnh Hà Giang"], ["4", "Tỉnh Cao Bằng"],
    ["6", "Tỉnh Bắc Kạn"], ["8", "Tỉnh Tuyên Quang"], ["10", "Tỉnh Lào Cai"],
    ["11", "Tỉnh Điện Biên"], ["12", "Tỉnh Lai Châu"], ["14", "Tỉnh Sơn La"],
    ["15", "Tỉnh Yên Bái"], ["17", "Tỉnh Hoà Bình"], ["19", "Tỉnh Thái Nguyên"],
    ["20", "Tỉnh Lạng Sơn"], ["22", "Tỉnh Quảng Ninh"], ["24", "Tỉnh Bắc Giang"],
    ["25", "Tỉnh Phú Thọ"], ["26", "Tỉnh Vĩnh Phúc"], ["27", "Tỉnh Bắc Ninh"],
    ["30", "Tỉnh Hải Dương"], ["31", "Thành phố Hải Phòng"], ["33", "Tỉnh Hưng Yên"],
    ["34", "Tỉnh Thái Bình"], ["35", "Tỉnh Hà Nam"], ["36", "Tỉnh Nam Định"],
    ["37", "Tỉnh Ninh Bình"], ["38", "Tỉnh Thanh Hóa"], ["40", "Tỉnh Nghệ An"],
    ["42", "Tỉnh Hà Tĩnh"], ["44", "Tỉnh Quảng Bình"], ["45", "Tỉnh Quảng Trị"],
    ["46", "Tỉnh Thừa Thiên Huế"], ["48", "Thành phố Đà Nẵng"], ["49", "Tỉnh Quảng Nam"],
    ["51", "Tỉnh Quảng Ngãi"], ["52", "Tỉnh Bình Định"], ["54", "Tỉnh Phú Yên"],
    ["56", "Tỉnh Khánh Hòa"], ["58", "Tỉnh Ninh Thuận"], ["60", "Tỉnh Bình Thuận"],
    ["62", "Tỉnh Kon Tum"], ["64", "Tỉnh Gia Lai"], ["66", "Tỉnh Đắk Lắk"],
    ["67", "Tỉnh Đắk Nông"], ["68", "Tỉnh Lâm Đồng"], ["70", "Tỉnh Bình Phước"],
    ["72", "Tỉnh Tây Ninh"], ["74", "Tỉnh Bình Dương"], ["75", "Tỉnh Đồng Nai"],
    ["77", "Tỉnh Bà Rịa - Vũng Tàu"], ["79", "Thành phố Hồ Chí Minh"], ["80", "Tỉnh Long An"],
    ["82", "Tỉnh Tiền Giang"], ["83", "Tỉnh Bến Tre"], ["84", "Tỉnh Trà Vinh"],
    ["86", "Tỉnh Vĩnh Long"], ["87", "Tỉnh Đồng Tháp"], ["89", "Tỉnh An Giang"],
    ["91", "Tỉnh Kiên Giang"], ["92", "Thành phố Cần Thơ"], ["93", "Tỉnh Hậu Giang"],
    ["94", "Tỉnh Sóc Trăng"], ["95", "Tỉnh Bạc Liêu"], ["96", "Tỉnh Cà Mau"]
  ];

  const DISTRICTS = {
    "1": [
      ["1", "Quận Ba Đình"], ["2", "Quận Hoàn Kiếm"], ["3", "Quận Tây Hồ"],
      ["4", "Quận Long Biên"], ["5", "Quận Cầu Giấy"], ["6", "Quận Đống Đa"],
      ["7", "Quận Hai Bà Trưng"], ["8", "Quận Hoàng Mai"], ["9", "Quận Thanh Xuân"],
      ["16", "Huyện Sóc Sơn"], ["17", "Huyện Đông Anh"], ["18", "Huyện Gia Lâm"],
      ["19", "Quận Nam Từ Liêm"], ["20", "Huyện Thanh Trì"], ["21", "Quận Bắc Từ Liêm"],
      ["250", "Huyện Mê Linh"], ["268", "Quận Hà Đông"], ["269", "Thị xã Sơn Tây"],
      ["271", "Huyện Ba Vì"], ["272", "Huyện Phúc Thọ"], ["273", "Huyện Đan Phượng"],
      ["274", "Huyện Hoài Đức"], ["275", "Huyện Quốc Oai"], ["276", "Huyện Thạch Thất"],
      ["277", "Huyện Chương Mỹ"], ["278", "Huyện Thanh Oai"], ["279", "Huyện Thường Tín"],
      ["280", "Huyện Phú Xuyên"], ["281", "Huyện Ứng Hoà"], ["282", "Huyện Mỹ Đức"]
    ],
    "79": [
      ["760", "Quận 1"], ["761", "Quận 3"], ["762", "Quận 4"], ["763", "Quận 5"],
      ["764", "Quận 6"], ["765", "Quận 7"], ["766", "Quận 8"], ["767", "Quận 10"],
      ["768", "Quận 11"], ["769", "Quận 12"], ["770", "Quận Bình Thạnh"], ["771", "Quận Tân Bình"],
      ["772", "Quận Tân Phú"], ["773", "Quận Phú Nhuận"], ["774", "Thành phố Thủ Đức"],
      ["775", "Quận Gò Vấp"], ["776", "Quận Bình Tân"]
    ],
    "83": [
      ["831", "Thành phố Bến Tre"], ["832", "Huyện Châu Thành"], ["833", "Huyện Giồng Trôm"],
      ["834", "Huyện Ba Tri"], ["835", "Huyện Bình Đại"], ["836", "Huyện Mỏ Cày Bắc"],
      ["837", "Huyện Mỏ Cày Nam"], ["838", "Huyện Thạnh Phú"], ["839", "Huyện Chợ Lách"]
    ],
    "92": [
      ["916", "Quận Ninh Kiều"], ["917", "Quận Bình Thủy"], ["918", "Quận Cái Răng"],
      ["919", "Quận Ô Môn"], ["923", "Huyện Phong Điền"], ["924", "Huyện Cờ Đỏ"],
      ["925", "Huyện Vĩnh Thạnh"], ["926", "Huyện Thới Lai"]
    ]
  };

  const COMMUNES = {
    "1-1": [["001", "Phường Phúc Xá"], ["002", "Phường Trúc Bạch"], ["003", "Phường Vĩnh Phúc"], ["004", "Phường Cống Vị"], ["005", "Phường Liễu Giai"], ["006", "Phường Nguyễn Trung Trực"]],
    "1-2": [["007", "Phường Hàng Mã"], ["008", "Phường Hàng Buồm"], ["009", "Phường Hàng Đào"], ["010", "Phường Hàng Bạc"], ["011", "Phường Cửa Đông"]],
    "1-3": [["013", "Phường Phú Thượng"], ["014", "Phường Nhật Tân"], ["015", "Phường Tứ Liên"], ["016", "Phường Quảng An"], ["017", "Phường Xuân La"]],
    "1-4": [["019", "Phường Ngọc Lâm"], ["020", "Phường Bồ Đề"], ["021", "Phường Gia Thụy"], ["022", "Phường Ngọc Thụy"], ["023", "Phường Thượng Thanh"]],
    "1-5": [["025", "Phường Nghĩa Đô"], ["026", "Phường Nghĩa Tân"], ["027", "Phường Mai Dịch"], ["028", "Phường Dịch Vọng"], ["029", "Phường Quan Hoa"]],
    "1-6": [["031", "Phường Văn Miếu"], ["032", "Phường Quốc Tử Giám"], ["033", "Phường Láng Thượng"], ["034", "Phường Ô Chợ Dừa"], ["035", "Phường Trung Liệt"]],
    "1-7": [["037", "Phường Nguyễn Du"], ["038", "Phường Bùi Thị Xuân"], ["039", "Phường Ngô Thì Nhậm"], ["040", "Phường Lê Đại Hành"], ["041", "Phường Phố Huế"]],
    "1-8": [["043", "Phường Thanh Trì"], ["044", "Phường Vĩnh Hưng"], ["045", "Phường Định Công"], ["046", "Phường Đại Kim"], ["047", "Phường Hoàng Văn Thụ"]],
    "1-9": [["049", "Phường Nhân Chính"], ["050", "Phường Thượng Đình"], ["051", "Phường Khương Trung"], ["052", "Phường Khương Mai"], ["053", "Phường Thanh Xuân Bắc"]],
    "1-16": [["101", "Thị trấn Sóc Sơn"], ["102", "Xã Bắc Sơn"], ["103", "Xã Minh Trí"], ["104", "Xã Nam Sơn"], ["105", "Xã Phù Linh"]],
    "1-17": [["107", "Thị trấn Đông Anh"], ["108", "Xã Bắc Hồng"], ["109", "Xã Cổ Loa"], ["110", "Xã Hải Bối"], ["111", "Xã Kim Chung"]],
    "1-18": [["113", "Thị trấn Trâu Quỳ"], ["114", "Xã Bát Tràng"], ["115", "Xã Đa Tốn"], ["116", "Xã Dương Xá"], ["117", "Xã Ninh Hiệp"]],
    "1-19": [["119", "Phường Cầu Diễn"], ["120", "Phường Mỹ Đình 1"], ["121", "Phường Mỹ Đình 2"], ["122", "Phường Mễ Trì"], ["123", "Phường Phú Đô"]],
    "1-20": [["125", "Thị trấn Văn Điển"], ["126", "Xã Đại Áng"], ["127", "Xã Đông Mỹ"], ["128", "Xã Hữu Hòa"], ["129", "Xã Liên Ninh"]],
    "1-21": [["131", "Phường Cổ Nhuế 1"], ["132", "Phường Cổ Nhuế 2"], ["133", "Phường Đông Ngạc"], ["134", "Phường Đức Thắng"], ["135", "Phường Xuân Đỉnh"]],
    "1-268": [["137", "Phường Nguyễn Trãi"], ["138", "Phường Mộ Lao"], ["139", "Phường Văn Quán"], ["140", "Phường Yết Kiêu"], ["141", "Phường Dương Nội"]],
    "1-269": [["143", "Phường Lê Lợi"], ["144", "Phường Ngô Quyền"], ["145", "Phường Sơn Lộc"], ["146", "Xã Cổ Đông"], ["147", "Xã Đường Lâm"]],
    "1-271": [["149", "Thị trấn Tây Đằng"], ["150", "Xã Ba Trại"], ["151", "Xã Ba Vì"], ["152", "Xã Cẩm Lĩnh"], ["153", "Xã Minh Quang"]],
    "1-272": [["155", "Thị trấn Phúc Thọ"], ["156", "Xã Hát Môn"], ["157", "Xã Hiệp Thuận"], ["158", "Xã Long Xuyên"], ["159", "Xã Phụng Thượng"]],
    "1-273": [["161", "Thị trấn Phùng"], ["162", "Xã Đan Phượng"], ["163", "Xã Đồng Tháp"], ["164", "Xã Hạ Mỗ"], ["165", "Xã Liên Hà"]],
    "1-274": [["167", "Thị trấn Trạm Trôi"], ["168", "Xã An Khánh"], ["169", "Xã Cát Quế"], ["170", "Xã La Phù"], ["171", "Xã Vân Canh"]],
    "1-275": [["173", "Thị trấn Quốc Oai"], ["174", "Xã Cấn Hữu"], ["175", "Xã Đông Yên"], ["176", "Xã Hòa Thạch"], ["177", "Xã Phú Mãn"]],
    "1-276": [["179", "Thị trấn Liên Quan"], ["180", "Xã Bình Yên"], ["181", "Xã Cẩm Yên"], ["182", "Xã Hạ Bằng"], ["183", "Xã Yên Bình"]],
    "1-277": [["185", "Thị trấn Chúc Sơn"], ["186", "Thị trấn Xuân Mai"], ["187", "Xã Đông Phương Yên"], ["188", "Xã Hòa Chính"], ["189", "Xã Phú Nam An"]],
    "1-278": [["191", "Thị trấn Kim Bài"], ["192", "Xã Cao Dương"], ["193", "Xã Hồng Dương"], ["194", "Xã Mỹ Hưng"], ["195", "Xã Tam Hưng"]],
    "1-279": [["197", "Thị trấn Thường Tín"], ["198", "Xã Chương Dương"], ["199", "Xã Duyên Thái"], ["200", "Xã Hà Hồi"], ["201", "Xã Vạn Điểm"]],
    "1-280": [["203", "Thị trấn Phú Xuyên"], ["204", "Xã Châu Can"], ["205", "Xã Đại Thắng"], ["206", "Xã Phú Túc"], ["207", "Xã Tri Trung"]],
    "1-281": [["209", "Thị trấn Vân Đình"], ["210", "Xã Đại Cường"], ["211", "Xã Hòa Lâm"], ["212", "Xã Liên Bạt"], ["213", "Xã Trường Thịnh"]],
    "1-282": [["215", "Thị trấn Đại Nghĩa"], ["216", "Xã An Phú"], ["217", "Xã Hợp Tiến"], ["218", "Xã Hương Sơn"], ["219", "Xã Phù Lưu Tế"]]
  };

  const CENTERS = {
    "1": [21.0285, 105.8542], "79": [10.7769, 106.7009], "83": [10.2415, 106.3758],
    "92": [10.0452, 105.7469], "48": [16.0544, 108.2022], "31": [20.8449, 106.6881],
    "14": [21.3270, 103.9144], "64": [13.9833, 108.0000], "68": [11.9404, 108.4583],
    "91": [9.8240, 105.1259], "96": [9.1769, 105.1520]
  };

  const DISTRICT_CENTERS = {
    "1-1": [21.033, 105.819], "1-2": [21.028, 105.851], "1-3": [21.064, 105.810],
    "1-4": [21.047, 105.893], "1-5": [21.036, 105.793], "1-6": [21.017, 105.831],
    "1-7": [21.005, 105.850], "1-8": [20.980, 105.860], "1-9": [20.998, 105.815],
    "1-16": [21.260, 105.850], "1-17": [21.140, 105.846], "1-18": [21.013, 105.943],
    "1-19": [21.021, 105.765], "1-20": [20.940, 105.850], "1-21": [21.070, 105.770],
    "1-250": [21.185, 105.715], "1-268": [20.973, 105.780], "1-269": [21.140, 105.506],
    "1-271": [21.198, 105.424], "1-272": [21.110, 105.550], "1-273": [21.090, 105.670],
    "1-274": [21.020, 105.710], "1-275": [20.990, 105.650], "1-276": [21.030, 105.590],
    "1-277": [20.900, 105.680], "1-278": [20.860, 105.770], "1-279": [20.840, 105.860],
    "1-280": [20.730, 105.910], "1-281": [20.720, 105.770], "1-282": [20.670, 105.690]
  };

  const DEFAULT_VIEW = { center: [21.0285, 105.8542], zoom: 10 };
  const HANOI_BOUNDS = [[20.72, 105.38], [21.45, 106.05]];
  const HANOI_BOUNDARY = {
    type: "Feature",
    properties: { name: "Thành phố Hà Nội", area_km2: 3359 },
    geometry: { type: "Polygon", coordinates: [[
      [105.38, 21.22], [105.47, 21.40], [105.67, 21.46], [105.96, 21.43],
      [106.05, 21.25], [105.98, 20.98], [105.91, 20.79], [105.67, 20.72],
      [105.48, 20.79], [105.38, 21.02], [105.38, 21.22]
    ]]}
  };

  const state = {
    resultCollection: null,
    resultLayer: null,
    boundaryLayer: null,
    gridLayer: null,
    baseLayer: null,
    map: null,
    lastParams: null,
    panelOpen: window.innerWidth > 700,
    activeBase: "light"
  };

  function pad(value) { return String(value).padStart(2, "0"); }

  function formatDate(date) {
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
  }

  function addMonths(date, months) {
    const next = new Date(date);
    next.setDate(1);
    next.setMonth(next.getMonth() + months);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(date.getDate(), lastDay));
    return next;
  }

  function parseVNDate(value) {
    const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;
    const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
    if (date.getFullYear() !== Number(match[3]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[1])) return null;
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function formatArea(value, digits = 1) {
    return Number(value || 0).toLocaleString("vi-VN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
  }

  function setOptions(select, items, placeholder) {
    select.innerHTML = "";
    const first = document.createElement("option");
    first.value = "";
    first.textContent = placeholder;
    first.disabled = false;
    first.selected = true;
    select.appendChild(first);
    items.forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    });
  }

  function initializeLocations() {
    const province = $("#province");
    const district = $("#district");
    const commune = $("#commune");
    setOptions(province, PROVINCES, "-- Chọn tỉnh / thành phố --");
    province.value = "1";
    setOptions(district, DISTRICTS["1"], "-- Quận/Huyện/Thị Xã --");
    setOptions(commune, [], "-- Xã/Phường/Thị Trấn --");

    province.addEventListener("change", () => {
      const items = DISTRICTS[province.value] || [];
      setOptions(district, items, "-- Quận/Huyện/Thị Xã --");
      setOptions(commune, [], "-- Xã/Phường/Thị Trấn --");
      updateContext();
      updateBoundary();
      zoomToProvince(province.value);
    });

    district.addEventListener("change", () => {
      const items = COMMUNES[`${province.value}-${district.value}`] || [];
      setOptions(commune, items, "-- Xã/Phường/Thị Trấn --");
      updateContext();
      updateBoundary();
      zoomToSelection();
    });

    commune.addEventListener("change", () => {
      updateContext();
      updateBoundary();
      zoomToSelection();
    });
  }

  function getLocationLabels() {
    const province = $("#province");
    const district = $("#district");
    const commune = $("#commune");
    return {
      provinceCode: province.value,
      provinceLabel: province.options[province.selectedIndex]?.text || "",
      districtCode: district.value,
      districtLabel: district.value ? district.options[district.selectedIndex]?.text || "" : "",
      communeCode: commune.value,
      communeLabel: commune.value ? commune.options[commune.selectedIndex]?.text || "" : ""
    };
  }

  function getDateDefaults() {
    const startCK = addMonths(today, -3);
    const endDK = new Date(startCK);
    endDK.setDate(endDK.getDate() - 1);
    const startDK = addMonths(endDK, -3);
    return { startDK, endDK, startCK, endCK: new Date(today) };
  }

  function initializeDates() {
    const defaults = getDateDefaults();
    $("#start_dk").value = formatDate(defaults.startDK);
    $("#end_dk").value = formatDate(defaults.endDK);
    $("#start_ck").value = formatDate(defaults.startCK);
    $("#end_ck").value = formatDate(defaults.endCK);
    ["start_dk", "end_dk", "start_ck", "end_ck"].forEach(id => {
      const input = $(`#${id}`);
      input.addEventListener("blur", () => {
        const parsed = parseVNDate(input.value);
        if (parsed) input.value = formatDate(parsed);
        validateForm(false);
      });
      input.addEventListener("input", () => validateForm(true));
    });
  }

  function setError(id, message, fieldIds = []) {
    const node = $(`#${id}`);
    if (node) node.textContent = message || "";
    fieldIds.forEach(fieldId => {
      const field = $(`#${fieldId}`);
      if (field) field.classList.toggle("input-error", Boolean(message));
    });
  }

  function validateForm(showErrors = true) {
    const fields = {
      startDK: $("#start_dk").value,
      endDK: $("#end_dk").value,
      startCK: $("#start_ck").value,
      endCK: $("#end_ck").value,
      minArea: $("#min_area").value,
      maxArea: $("#max_area").value
    };
    const dates = {
      startDK: parseVNDate(fields.startDK), endDK: parseVNDate(fields.endDK),
      startCK: parseVNDate(fields.startCK), endCK: parseVNDate(fields.endCK)
    };
    let valid = true;
    let dkError = "";
    let ckError = "";
    let overlapError = "";
    let areaError = "";

    if (!dates.startDK || !dates.endDK || (dates.startDK && dates.startDK >= today) || (dates.endDK && dates.endDK > today)) {
      dkError = "Nhập đúng ngày đầu kỳ và không vượt quá hôm nay.";
      valid = false;
    } else if (dates.startDK >= dates.endDK) {
      dkError = "Ngày bắt đầu phải trước ngày kết thúc.";
      valid = false;
    }
    if (!dates.startCK || !dates.endCK || (dates.startCK && dates.startCK >= today) || (dates.endCK && dates.endCK > today)) {
      ckError = "Nhập đúng ngày cuối kỳ và không vượt quá hôm nay.";
      valid = false;
    } else if (dates.startCK >= dates.endCK) {
      ckError = "Ngày bắt đầu phải trước ngày kết thúc.";
      valid = false;
    }
    if (dates.endDK && dates.startCK && dates.endDK >= dates.startCK) {
      overlapError = "Ngày kết thúc đầu kỳ phải trước ngày bắt đầu cuối kỳ.";
      valid = false;
    }

    const minArea = fields.minArea === "" ? null : Number(fields.minArea);
    const maxArea = fields.maxArea === "" ? null : Number(fields.maxArea);
    if ((minArea !== null && (!Number.isFinite(minArea) || minArea < 0)) || (maxArea !== null && (!Number.isFinite(maxArea) || maxArea < 0))) {
      areaError = "Diện tích không được âm hoặc không hợp lệ.";
      valid = false;
    } else if (minArea !== null && maxArea !== null && minArea >= maxArea) {
      areaError = "Diện tích nhỏ nhất phải nhỏ hơn lớn nhất.";
      valid = false;
    }

    if (showErrors) {
      setError("date-dk-error", dkError, ["start_dk", "end_dk"]);
      setError("date-ck-error", ckError, ["start_ck", "end_ck"]);
      setError("date-overlap-error", overlapError, ["end_dk", "start_ck"]);
      setError("area-error", areaError, ["min_area", "max_area"]);
    }
    return { valid, dates, minArea, maxArea };
  }

  function getParams() {
    const location = getLocationLabels();
    const values = validateForm(true);
    return Object.assign({}, location, {
      satellite: $("#satellite").value,
      satelliteLabel: $("#satellite").options[$("#satellite").selectedIndex]?.text || "Sentinel 2",
      monitorType: $("#monitor_type").value,
      monitorLabel: $("#monitor_type").options[$("#monitor_type").selectedIndex]?.text || "Biến động giảm",
      startDK: $("#start_dk").value,
      endDK: $("#end_dk").value,
      startCK: $("#start_ck").value,
      endCK: $("#end_ck").value,
      minArea: values.minArea == null ? 0 : values.minArea,
      maxArea: values.maxArea,
      minAreaLabel: values.minArea == null ? "0" : String(values.minArea),
      maxAreaLabel: values.maxArea == null ? "Không giới hạn" : String(values.maxArea)
    });
  }

  function updateContext() {
    const labels = getLocationLabels();
    const title = labels.communeLabel || labels.districtLabel || labels.provinceLabel || "Thành phố Hà Nội";
    const subtitle = labels.communeLabel ? `${labels.districtLabel} · ${labels.provinceLabel}` : labels.districtLabel ? `${labels.provinceLabel} · khu vực cấp huyện` : `${labels.provinceLabel} · 3.359 km²`;
    $("#map-context-title").textContent = title;
    $("#map-context-subtitle").textContent = subtitle;
    $("#context-baseline").textContent = `${$("#start_dk").value} — ${$("#end_dk").value}`;
    $("#context-comparison").textContent = `${$("#start_ck").value} — ${$("#end_ck").value}`;
  }

  function initMap() {
    state.map = L.map("map", { zoomControl: false, minZoom: 5, maxZoom: 18, preferCanvas: true }).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
    L.control.zoom({ position: "topleft" }).addTo(state.map);
    L.control.scale({ position: "bottomleft", imperial: false, maxWidth: 90 }).addTo(state.map);

    const light = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 20, subdomains: "abcd", attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    });
    const dark = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 20, subdomains: "abcd", attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    });
    const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19, attribution: "Tiles &copy; Esri"
    });
    state.baseLayer = light;
    state.baseLayer.addTo(state.map);
    state.baseLayers = { light, dark, satellite };

    state.boundaryLayer = L.geoJSON(HANOI_BOUNDARY, {
      style: { color: "#536d7b", weight: 1.4, dashArray: "6 5", fillColor: "#d4e6e3", fillOpacity: .09 }
    }).addTo(state.map);
    state.gridLayer = createGridLayer();
    state.resultLayer = L.geoJSON(null, { style: featureStyle, onEachFeature: bindFeature }).addTo(state.map);
    state.map.fitBounds(HANOI_BOUNDS, { padding: [24, 24] });
  }

  function createGridLayer() {
    const layer = L.layerGroup();
    for (let longitude = 105.4; longitude <= 106.0; longitude += .1) {
      layer.addLayer(L.polyline([[20.72, longitude], [21.46, longitude]], { color: "#6e8290", weight: .55, opacity: .32, dashArray: "2 5", interactive: false }));
    }
    for (let latitude = 20.75; latitude <= 21.45; latitude += .1) {
      layer.addLayer(L.polyline([[latitude, 105.38], [latitude, 106.05]], { color: "#6e8290", weight: .55, opacity: .32, dashArray: "2 5", interactive: false }));
    }
    return layer;
  }

  function getCenter(params) {
    if (params.provinceCode && CENTERS[params.provinceCode]) return CENTERS[params.provinceCode];
    return DEFAULT_VIEW.center;
  }

  function getSelectionCenter(params) {
    const districtKey = `${params.provinceCode || ""}-${params.districtCode || ""}`;
    return DISTRICT_CENTERS[districtKey] || getCenter(params);
  }

  function updateBoundary(params = getLocationLabels()) {
    if (!state.boundaryLayer) return;
    const center = getSelectionCenter(params);
    if (params.provinceCode === "1" && !params.districtCode) {
      state.boundaryLayer.clearLayers();
      state.boundaryLayer.addData(HANOI_BOUNDARY);
      return;
    }
    const latitudeSpan = params.communeCode ? .035 : params.districtCode ? .075 : .22;
    const longitudeSpan = params.communeCode ? .045 : params.districtCode ? .095 : .28;
    const [latitude, longitude] = center;
    const feature = {
      type: "Feature",
      properties: { name: params.communeLabel || params.districtLabel || params.provinceLabel || "Khu vực phân tích" },
      geometry: { type: "Polygon", coordinates: [[
        [longitude - longitudeSpan, latitude - latitudeSpan], [longitude - longitudeSpan * .72, latitude + latitudeSpan],
        [longitude + longitudeSpan, latitude + latitudeSpan * .82], [longitude + longitudeSpan * .85, latitude - latitudeSpan],
        [longitude - longitudeSpan, latitude - latitudeSpan]
      ]] }
    };
    state.boundaryLayer.clearLayers();
    state.boundaryLayer.addData(feature);
  }

  function zoomToProvince(provinceCode) {
    if (!state.map) return;
    if (provinceCode === "1") state.map.fitBounds(HANOI_BOUNDS, { padding: [28, 28], animate: true });
    else state.map.setView(CENTERS[provinceCode] || DEFAULT_VIEW.center, 9, { animate: true });
  }

  function zoomToSelection() {
    if (!state.map) return;
    const labels = getLocationLabels();
    const center = getSelectionCenter(labels);
    const offset = labels.districtCode ? 0.04 : 0;
    state.map.setView([center[0] + offset, center[1] + offset], labels.communeCode ? 13 : labels.districtCode ? 11 : 10, { animate: true });
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash >>> 0);
  }

  function randomFrom(seed) {
    let value = seed % 2147483647;
    if (value <= 0) value += 2147483646;
    return function () {
      value = value * 16807 % 2147483647;
      return (value - 1) / 2147483646;
    };
  }

  function buildDemoCollection(params) {
    const seed = hashString([params.provinceCode, params.districtCode, params.communeCode, params.startDK, params.endCK, params.monitorType, params.satellite].join("|"));
    const random = randomFrom(seed || 37);
    const center = getSelectionCenter(params);
    const featureCount = 14;
    const features = [];
    for (let index = 0; index < featureCount; index += 1) {
      const angle = (Math.PI * 2 * index / featureCount) + random() * .35;
      const radius = .035 + random() * .28;
      const lat = center[0] + Math.sin(angle) * radius;
      const lon = center[1] + Math.cos(angle) * radius * 1.32;
      const width = .009 + random() * .018;
      const height = .007 + random() * .014;
      const area = Math.max(.12, Number((.22 + random() * 5.8).toFixed(2)));
      const confidence = Math.round(76 + random() * 21);
      const shape = [
        [lon - width, lat - height * .35], [lon - width * .38, lat - height],
        [lon + width, lat - height * .64], [lon + width * .86, lat + height * .45],
        [lon - width * .22, lat + height], [lon - width, lat - height * .35]
      ];
      const label = params.communeLabel || params.districtLabel || params.provinceLabel || "Hà Nội";
      features.push({
        type: "Feature",
        properties: {
          id: `GS-${String(index + 1).padStart(3, "0")}`,
          name: `Vùng ${String(index + 1).padStart(2, "0")}`,
          locality: label,
          area_ha: area,
          confidence,
          monitor_type: params.monitorType,
          monitor_label: params.monitorLabel,
          satellite: params.satelliteLabel,
          period: `${params.startCK} — ${params.endCK}`,
          centroid: `${lat.toFixed(5)}, ${lon.toFixed(5)}`
        },
        geometry: { type: "Polygon", coordinates: [shape.map(([x, y]) => [x, y])] }
      });
    }
    const filtered = features.filter(feature => feature.properties.area_ha >= Number(params.minArea || 0) && (params.maxArea == null || feature.properties.area_ha <= Number(params.maxArea)));
    return {
      type: "FeatureCollection",
      features: filtered,
      metadata: {
        source: "browser-demo",
        generated_at: new Date().toISOString(),
        query: params
      }
    };
  }

  function featureStyle(feature) {
    const increase = feature.properties?.monitor_type === "+";
    return {
      color: increase ? "#0d8f80" : "#c75548",
      weight: 1.2,
      opacity: .95,
      fillColor: increase ? "#31b9a5" : "#e77e6c",
      fillOpacity: .52
    };
  }

  function bindFeature(feature, layer) {
    layer.on({
      mouseover: event => event.target.setStyle(Object.assign({}, featureStyle(feature), { weight: 2.6, fillOpacity: .72 })),
      mouseout: event => state.resultLayer.resetStyle(event.target),
      click: event => {
        state.map.fitBounds(event.target.getBounds(), { maxZoom: 14, padding: [100, 100], animate: true });
        event.target.openPopup();
      }
    });
    layer.bindPopup(createPopup(feature.properties), { closeButton: true, offset: [0, -2] });
  }

  function createPopup(properties) {
    const increase = properties.monitor_type === "+";
    const badgeClass = increase ? "increase" : "decrease";
    return `<div class="result-popup"><div class="popup-kicker">${escapeHTML(properties.id)} · ĐIỂM PHÁT HIỆN</div><h3>${escapeHTML(properties.name)}</h3><span class="popup-badge ${badgeClass}"><span class="status-dot ${increase ? "" : "amber"}"></span>${escapeHTML(properties.monitor_label)}</span><div class="popup-grid"><div><span>Diện tích</span><strong>${formatArea(properties.area_ha, 2)} ha</strong></div><div><span>Độ tin cậy</span><strong>${properties.confidence}%</strong></div><div><span>Địa bàn</span><strong>${escapeHTML(properties.locality)}</strong></div><div><span>Tâm vùng</span><strong>${escapeHTML(properties.centroid)}</strong></div></div></div>`;
  }

  function renderCollection(collection, params) {
    state.resultCollection = collection;
    state.lastParams = params;
    state.resultLayer.clearLayers();
    state.resultLayer.addData(collection);
    updateBoundary(params);
    if (collection.features.length) {
      const bounds = state.resultLayer.getBounds();
      if (bounds.isValid()) state.map.fitBounds(bounds, { padding: [80, 80], maxZoom: 12, animate: true });
    }
    updateStats(collection, params);
    updateContext();
    $("#results-drawer").hidden = false;
    $("#results-title").textContent = `${collection.features.length ? "Đã phát hiện biến động" : "Không có vùng phù hợp"}`;
  }

  function updateStats(collection) {
    const features = collection.features || [];
    const total = features.reduce((sum, feature) => sum + Number(feature.properties?.area_ha || 0), 0);
    const max = features.reduce((value, feature) => Math.max(value, Number(feature.properties?.area_ha || 0)), 0);
    const confidence = features.length ? features.reduce((sum, feature) => sum + Number(feature.properties?.confidence || 0), 0) / features.length : 0;
    $("#stat-count").textContent = features.length.toLocaleString("vi-VN");
    $("#stat-area").textContent = formatArea(total, 1);
    $("#stat-max").textContent = formatArea(max, 1);
    $("#stat-confidence").textContent = features.length ? Math.round(confidence).toLocaleString("vi-VN") : "—";
    $("#results-count-label").textContent = `${features.length.toLocaleString("vi-VN")} vùng`;
    const list = $("#results-list");
    list.innerHTML = features.length ? features.map(feature => {
      const item = feature.properties;
      const color = item.monitor_type === "+" ? "#1ab8a0" : "#eb6d5b";
      return `<div class="result-row"><div class="result-name"><span class="result-color" style="background:${color}"></span><span>${escapeHTML(item.id)} · ${escapeHTML(item.locality)}</span></div><span>${formatArea(item.area_ha, 2)} ha</span><span>${item.confidence}%</span><button type="button" data-focus-result="${escapeHTML(item.id)}">Xem</button></div>`;
    }).join("") : `<div class="empty-results"><span>Không có vùng nào vượt ngưỡng diện tích đã chọn.</span></div>`;
    $$('[data-focus-result]', list).forEach(button => button.addEventListener("click", () => focusResult(button.dataset.focusResult)));
  }

  function focusResult(id) {
    const feature = state.resultCollection?.features.find(item => item.properties?.id === id);
    if (!feature) return;
    state.resultLayer.eachLayer(layer => {
      if (layer.feature?.properties?.id === id) {
        state.map.fitBounds(layer.getBounds(), { maxZoom: 14, padding: [100, 100], animate: true });
        layer.openPopup();
        layer.setStyle(Object.assign({}, featureStyle(feature), { weight: 2.8, fillOpacity: .74 }));
        window.setTimeout(() => state.resultLayer.resetStyle(layer), 1100);
      }
    });
  }

  function wait(milliseconds) {
    return new Promise(resolve => window.setTimeout(resolve, milliseconds));
  }

  async function calculate(params) {
    if (CONFIG.apiBase && !CONFIG.demoMode) {
      const response = await fetch(`${String(CONFIG.apiBase).replace(/\/$/, "")}${CONFIG.apiPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/geo+json, application/json" },
        body: JSON.stringify({
          province_code: params.provinceCode, district_code: params.districtCode, commune_code: params.communeCode,
          satellite: params.satellite, monitor_type: params.monitorType,
          start_dk: params.startDK, end_dk: params.endDK, start_ck: params.startCK, end_ck: params.endCK,
          min_area: params.minArea, max_area: params.maxArea
        })
      });
      if (!response.ok) throw new Error(`API trả về HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.type !== "FeatureCollection" || !Array.isArray(payload.features)) throw new Error("API chưa trả về GeoJSON FeatureCollection hợp lệ.");
      return payload;
    }
    await wait(420);
    return buildDemoCollection(params);
  }

  function setLoading(loading) {
    const button = $("#calculate-button");
    const loadingBox = $("#map-loading");
    button.disabled = loading;
    button.classList.toggle("is-loading", loading);
    button.querySelector(".button-label").textContent = loading ? "Đang tính" : "Tính toán";
    loadingBox.hidden = !loading;
  }

  function updateSystemMode() {
    const mode = $("#system-mode");
    if (!mode) return;
    mode.textContent = CONFIG.apiBase && !CONFIG.demoMode ? "Đang dùng API xử lý ảnh" : "Bản mẫu tĩnh · sẵn sàng nối API";
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const validation = validateForm(true);
    if (!validation.valid) {
      showToast("Vui lòng kiểm tra lại các trường được đánh dấu.", "error");
      const firstInvalid = $(".input-error");
      if (firstInvalid) firstInvalid.focus();
      return;
    }
    const params = getParams();
    setLoading(true);
    const steps = ["Đọc bộ lọc không gian…", "Chuẩn hóa khoảng thời gian…", `Đang phân tích ${params.satelliteLabel}…`, "Tổng hợp vùng biến động…"];
    try {
      for (let index = 0; index < steps.length - 1; index += 1) {
        $("#loading-step").textContent = steps[index];
        await wait(220);
      }
      $("#loading-step").textContent = steps[steps.length - 1];
      const collection = await calculate(params);
      renderCollection(collection, params);
      showToast(collection.features.length ? `Đã phát hiện ${collection.features.length} vùng biến động.` : "Không có vùng nào phù hợp với bộ lọc.", collection.features.length ? "success" : "warning");
    } catch (error) {
      showToast(error.message || "Không thể tính toán. Vui lòng thử lại.", "error");
    } finally {
      setLoading(false);
    }
  }

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function dateStamp() {
    return `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
  }

  function downloadGeoJSON() {
    if (!state.resultCollection) {
      showToast("Hãy tính toán trước khi tải bản đồ.", "warning");
      return;
    }
    downloadBlob(JSON.stringify(state.resultCollection, null, 2), `vietflex-giamsat-${dateStamp()}.geojson`, "application/geo+json;charset=utf-8");
    showToast("Đã tải lớp kết quả GeoJSON.", "success");
  }

  function downloadCSV() {
    const features = state.resultCollection?.features || [];
    if (!features.length) {
      showToast("Chưa có dữ liệu kết quả để tải.", "warning");
      return;
    }
    const header = ["id", "dia_ban", "dien_tich_ha", "do_tin_cay_pct", "loai_giam_sat", "ve_tinh", "tam_vung"];
    const rows = features.map(feature => {
      const item = feature.properties;
      return [item.id, item.locality, item.area_ha, item.confidence, item.monitor_label, item.satellite, item.centroid].map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",");
    });
    downloadBlob(`\ufeff${header.join(",")}\n${rows.join("\n")}`, `vietflex-giamsat-${dateStamp()}.csv`, "text/csv;charset=utf-8");
    showToast("Đã tải bảng kết quả CSV.", "success");
  }

  function setBaseMap(name) {
    const layer = state.baseLayers?.[name];
    if (!layer || !state.map) return;
    if (state.baseLayer) state.map.removeLayer(state.baseLayer);
    layer.addTo(state.map);
    state.baseLayer = layer;
    state.activeBase = name;
    $$("[data-basemap]").forEach(button => button.classList.toggle("active", button.dataset.basemap === name));
  }

  function showToast(message, type = "success") {
    const region = $("#toast-region");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    const icon = type === "success" ? "M5 12.5 9.2 17 19 7" : type === "warning" ? "M12 4 21 20H3L12 4Zm0 6v4M12 17h.01" : "M7 7l10 10M17 7 7 17";
    toast.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icon}"/></svg><span>${escapeHTML(message)}</span>`;
    region.appendChild(toast);
    window.setTimeout(() => { toast.style.opacity = "0"; toast.style.transform = "translateY(-5px)"; window.setTimeout(() => toast.remove(), 220); }, 3300);
  }

  function toggleLayers() {
    const popover = $("#layer-popover");
    popover.hidden = !popover.hidden;
  }

  function setupUI() {
    initializeLocations();
    initializeDates();
    initMap();
    updateContext();
    updateSystemMode();

    $("#monitor-form").addEventListener("submit", handleSubmit);
    $("#download-map").addEventListener("click", downloadGeoJSON);
    $("#download-csv").addEventListener("click", downloadCSV);
    $("#close-results").addEventListener("click", () => { $("#results-drawer").hidden = true; });
    $("#toggle-layers").addEventListener("click", toggleLayers);
    $("#layer-results").addEventListener("change", event => {
      if (event.target.checked) state.resultLayer.addTo(state.map); else state.map.removeLayer(state.resultLayer);
    });
    $("#layer-boundary").addEventListener("change", event => {
      if (event.target.checked) state.boundaryLayer.addTo(state.map); else state.map.removeLayer(state.boundaryLayer);
    });
    $("#layer-grid").addEventListener("change", event => {
      if (event.target.checked) state.gridLayer.addTo(state.map); else state.map.removeLayer(state.gridLayer);
    });
    $$("[data-basemap]").forEach(button => button.addEventListener("click", () => setBaseMap(button.dataset.basemap)));
    $("#reset-view").addEventListener("click", () => state.map.fitBounds(HANOI_BOUNDS, { padding: [24, 24], animate: true }));
    $("#locate-me").addEventListener("click", () => {
      if (!navigator.geolocation) return showToast("Trình duyệt không hỗ trợ định vị.", "warning");
      navigator.geolocation.getCurrentPosition(position => state.map.setView([position.coords.latitude, position.coords.longitude], 14), () => showToast("Không thể lấy vị trí hiện tại.", "warning"), { enableHighAccuracy: true, timeout: 7000 });
    });
    $("#fullscreen-button").addEventListener("click", () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.();
    });
    $("#mobile-menu").addEventListener("click", () => setPanel(!$("#control-panel").classList.contains("is-open")));
    $("#panel-close").addEventListener("click", () => setPanel(false));
    $("#help-button").addEventListener("click", () => $("#help-dialog").showModal());
    $("#close-help").addEventListener("click", () => $("#help-dialog").close());
    $("#help-dialog").addEventListener("click", event => { if (event.target === $("#help-dialog")) $("#help-dialog").close(); });
    $("#location-search").addEventListener("keydown", handleSearch);
    document.addEventListener("click", event => {
      if (!event.target.closest("#layer-popover") && !event.target.closest("#toggle-layers")) $("#layer-popover").hidden = true;
      if (window.innerWidth <= 700 && event.target.closest(".map-stage")) setPanel(false);
    });
    document.addEventListener("keydown", event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#location-search").focus(); }
      if (event.key === "Escape") { $("#layer-popover").hidden = true; if (window.innerWidth <= 700) setPanel(false); }
    });
    window.addEventListener("resize", () => { state.map.invalidateSize(); });
  }

  function setPanel(open) {
    state.panelOpen = open;
    $("#control-panel").classList.toggle("is-open", open);
    $("#mobile-menu").setAttribute("aria-expanded", String(open));
  }

  function handleSearch(event) {
    if (event.key !== "Enter") return;
    const query = event.currentTarget.value.trim().toLocaleLowerCase("vi");
    if (!query) return;
    const province = PROVINCES.find(([, label]) => label.toLocaleLowerCase("vi").includes(query));
    const district = Object.values(DISTRICTS).flat().find(([, label]) => label.toLocaleLowerCase("vi").includes(query));
    if (province) {
      $("#province").value = province[0];
      $("#province").dispatchEvent(new Event("change"));
      showToast(`Đã định vị ${province[1]}.`, "success");
      return;
    }
    if (district) {
      const provinceCode = Object.keys(DISTRICTS).find(code => DISTRICTS[code].some(([value]) => value === district[0]));
      if (provinceCode) {
        $("#province").value = provinceCode;
        $("#province").dispatchEvent(new Event("change"));
        $("#district").value = district[0];
        $("#district").dispatchEvent(new Event("change"));
        showToast(`Đã định vị ${district[1]}.`, "success");
      }
      return;
    }
    showToast("Chưa tìm thấy địa danh trong danh mục hiện tại.", "warning");
  }

  document.addEventListener("DOMContentLoaded", setupUI);
})();
