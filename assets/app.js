/*
 * Vietflex Map — Giám sát biến động theo ranh giới hành chính
 *
 * The browser owns interaction, administrative lookup and visualization.
 * Image analysis is deliberately kept behind a server API: the API receives
 * an administrative code, resolves its authoritative geometry, clips the
 * imagery server-side and returns GeoJSON plus short-lived image URLs.
 */
(function () {
  "use strict";

  const V = window.Vietflex;
  const CONFIG = Object.assign({
    apiBase: "",
    demoMode: true,
    monitorPath: "/api/v1/monitor/jobs",
    adminDataUrl: "https://raw.githubusercontent.com/Vietflexmap/sapnhap/908cbf40d3dab31bf4deb16bc49dba17cd88bafb/data/admin.json",
    boundaryHtmlUrls: [
      "https://cdn.jsdelivr.net/gh/Vietflexmap/anhmap@e80f4ee9f1e167817e4a9af8402c0bca4052573e/index.html"
    ],
    useLegacyGoogleTiles: true,
    googleApiKey: "",
    boundaryMinZoom: 4,
    boundaryMaxZoom: 18,
    boundaryNativeMaxZoom: 9
  }, window.GIAM_SAT_CONFIG || {});

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const DEFAULT_VIEW = { center: [21.0285, 105.8542], zoom: 10 };
  const VIETNAM_VIEW = { center: [16.1, 106.4], zoom: 5 };
  const EXPECTED_ADMIN = { provinces: 34, units: 3321, "phường": 697, "xã": 2611, "đặc khu": 13 };
  const BOUNDARY_SOURCE = "Vietflexmap/anhmap@e80f4ee9f1e167817e4a9af8402c0bca4052573e";

  const state = {
    data: null,
    provinces: [],
    units: [],
    provinceByValue: new Map(),
    unitByCode: new Map(),
    selectedProvince: null,
    selectedUnit: null,
    selectedBoundary: null,
    boundaryRecords: [],
    boundaryByCode: new Map(),
    boundaryByProvince: new Map(),
    boundaryForUnit: new Map(),
    unitByBoundaryId: new Map(),
    boundaryLayer: null,
    resultLayer: null,
    gridLayer: null,
    baseLayer: null,
    baseLayers: {},
    map: null,
    resultCollection: null,
    lastParams: null,
    activeBase: "roadmap",
    panelOpen: window.innerWidth > 700,
    job: null
  };

  function normalize(value = "") {
    return String(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function normalizeAdminType(value = "") {
    const text = normalize(value);
    if (text.includes("phuong")) return "phường";
    if (text.includes("dac khu")) return "đặc khu";
    if (text === "xa" || text.includes(" xa")) return "xã";
    return String(value || "").toLowerCase();
  }

  function stripAdminPrefix(value = "") {
    return normalize(value).replace(/^(tinh|thanh pho|thu do|phuong|xa|dac khu|thi tran)\s+/, "");
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    }[character]));
  }

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

  function number(value, fallback = null) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function optionValue(item) {
    return String(item?.id || item?.order || item?.code || "");
  }

  function setOptions(select, items, placeholder, labeler, valueOf) {
    if (!select) return;
    select.innerHTML = "";
    const first = document.createElement("option");
    first.value = "";
    first.textContent = placeholder;
    select.appendChild(first);
    items.forEach(item => {
      const option = document.createElement("option");
      option.value = valueOf(item);
      option.textContent = labeler(item);
      select.appendChild(option);
    });
  }

  function validateAdminPayload(payload) {
    if (!payload || !Array.isArray(payload.provinces) || !Array.isArray(payload.units)) {
      throw new Error("Bộ dữ liệu hành chính không đúng schema provinces/units.");
    }
    const counts = {
      provinces: payload.provinces.length,
      units: payload.units.length,
      "phường": payload.units.filter(item => normalizeAdminType(item.type) === "phường").length,
      "xã": payload.units.filter(item => normalizeAdminType(item.type) === "xã").length,
      "đặc khu": payload.units.filter(item => normalizeAdminType(item.type) === "đặc khu").length
    };
    for (const [key, expected] of Object.entries(EXPECTED_ADMIN)) {
      if (counts[key] !== expected) throw new Error(`Kiểm tra ${key}: cần ${expected}, nhận ${counts[key]}.`);
    }
    if (new Set(payload.units.map(item => String(item.code))).size !== EXPECTED_ADMIN.units) {
      throw new Error("Mã ĐVHC cấp xã bị trùng.");
    }
    return Object.assign(payload, { validation: counts });
  }

  async function loadAdminData() {
    const response = await fetch(CONFIG.adminDataUrl, { cache: "force-cache" });
    if (!response.ok) throw new Error(`Không tải được admin.json (HTTP ${response.status}).`);
    const payload = validateAdminPayload(await response.json());
    state.data = payload;
    state.provinces = payload.provinces.slice().sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    state.units = payload.units.slice().sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    state.provinceByValue.clear();
    state.unitByCode.clear();
    state.provinces.forEach(item => state.provinceByValue.set(optionValue(item), item));
    state.units.forEach(item => state.unitByCode.set(String(item.code), item));
    populateLocationControls();
    updateSystemMode();
  }

  function populateLocationControls() {
    const provinceSelect = $("#province");
    const typeSelect = $("#unit-type");
    const unitSelect = $("#commune");
    setOptions(
      provinceSelect,
      state.provinces,
      "-- Chọn tỉnh / thành phố --",
      item => `${String(item.order).padStart(2, "0")} · ${item.full_name || item.name}`,
      optionValue
    );
    const hanoi = state.provinces.find(item => stripAdminPrefix(item.name) === "ha noi" || stripAdminPrefix(item.full_name) === "ha noi");
    if (hanoi) provinceSelect.value = optionValue(hanoi);
    state.selectedProvince = state.provinceByValue.get(provinceSelect.value) || null;
    if (typeSelect) typeSelect.value = "";
    populateUnitOptions();

    provinceSelect.addEventListener("change", () => {
      state.selectedProvince = state.provinceByValue.get(provinceSelect.value) || null;
      state.selectedUnit = null;
      populateUnitOptions();
      updateSelection();
      zoomToSelection();
    });
    typeSelect.addEventListener("change", () => {
      if (state.selectedUnit && normalizeAdminType(state.selectedUnit.type) !== typeSelect.value) state.selectedUnit = null;
      populateUnitOptions();
      updateSelection();
    });
    unitSelect.addEventListener("change", () => {
      state.selectedUnit = state.unitByCode.get(String(unitSelect.value)) || null;
      updateSelection();
      zoomToSelection();
    });
  }

  function populateUnitOptions() {
    const select = $("#commune");
    if (!select) return;
    const province = state.selectedProvince;
    const type = $("#unit-type")?.value || "";
    const units = province
      ? state.units.filter(item => Number(item.province_order) === Number(province.order) && (!type || normalizeAdminType(item.type) === type))
      : [];
    setOptions(
      select,
      units,
      province ? `Tất cả ${units.length.toLocaleString("vi-VN")} đơn vị trong tỉnh/thành` : "Chọn tỉnh/thành trước",
      item => `${item.full_name || `${item.type} ${item.name}`} · ${item.code}`,
      item => String(item.code)
    );
    if (state.selectedUnit && units.some(item => String(item.code) === String(state.selectedUnit.code))) select.value = String(state.selectedUnit.code);
    else state.selectedUnit = null;
  }

  function getLocation() {
    const province = state.selectedProvince || state.provinceByValue.get($("#province")?.value);
    const unit = state.selectedUnit;
    const type = $("#unit-type")?.value || "";
    const adminCode = String(unit?.code || province?.code || "");
    const adminName = unit?.full_name || province?.full_name || "";
    return {
      provinceCode: String(province?.code || ""),
      provinceOrder: Number(province?.order || 0) || null,
      provinceLabel: province?.full_name || province?.name || "",
      unitType: unit ? normalizeAdminType(unit.type) : type,
      unitCode: String(unit?.code || ""),
      unitLabel: unit?.full_name || "",
      adminCode,
      adminLevel: unit ? "commune" : "province",
      adminName
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
        updateContext();
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
    const location = getLocation();
    const values = validateForm(true);
    const satellite = $("#satellite");
    const monitorType = $("#monitor_type");
    return Object.assign({}, location, {
      satellite: satellite.value,
      satelliteLabel: satellite.options[satellite.selectedIndex]?.text || "Sentinel 2",
      monitorType: monitorType.value,
      monitorLabel: monitorType.options[monitorType.selectedIndex]?.text || "Biến động giảm",
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

  function parseBBox(value) {
    let bbox = value;
    if (typeof bbox === "string") {
      try { bbox = JSON.parse(bbox); } catch { bbox = bbox.split(",").map(Number); }
    }
    if (!Array.isArray(bbox)) return null;
    let bounds;
    if (bbox.length === 2 && Array.isArray(bbox[0]) && Array.isArray(bbox[1])) {
      bounds = [[Number(bbox[0][1]), Number(bbox[0][0])], [Number(bbox[1][1]), Number(bbox[1][0])]];
    } else if (bbox.length >= 4 && bbox.slice(0, 4).every(Number.isFinite)) {
      bounds = [[Number(bbox[1]), Number(bbox[0])], [Number(bbox[3]), Number(bbox[2])]];
    }
    if (!bounds) return null;
    const latitudeSpan = Math.abs(bounds[1][0] - bounds[0][0]);
    const longitudeSpan = Math.abs(bounds[1][1] - bounds[0][1]);
    return latitudeSpan <= 5 && longitudeSpan <= 5 ? bounds : null;
  }

  function selectedBoundaryBounds() {
    const records = Array.isArray(state.selectedBoundary) ? state.selectedBoundary : state.selectedBoundary ? [state.selectedBoundary] : [];
    const bounds = records.map(record => parseBBox(record.bbox)).filter(Boolean);
    if (!bounds.length) return null;
    return [[
      Math.min(...bounds.map(item => item[0][0])),
      Math.min(...bounds.map(item => item[0][1]))
    ], [
      Math.max(...bounds.map(item => item[1][0])),
      Math.max(...bounds.map(item => item[1][1]))
    ]];
  }

  function selectionCenter() {
    const boundaryBounds = selectedBoundaryBounds();
    const records = Array.isArray(state.selectedBoundary) ? state.selectedBoundary : state.selectedBoundary ? [state.selectedBoundary] : [];
    const boundaryCentroids = records.map(record => Array.isArray(record.centroid) ? [Number(record.centroid[1]), Number(record.centroid[0])] : null).filter(Boolean);
    if (boundaryCentroids.length) return [
      boundaryCentroids.reduce((sum, point) => sum + point[0], 0) / boundaryCentroids.length,
      boundaryCentroids.reduce((sum, point) => sum + point[1], 0) / boundaryCentroids.length
    ];
    if (boundaryBounds) return [(boundaryBounds[0][0] + boundaryBounds[1][0]) / 2, (boundaryBounds[0][1] + boundaryBounds[1][1]) / 2];
    const item = state.selectedUnit || state.selectedProvince;
    const lat = number(item?.centroid_lat);
    const lon = number(item?.centroid_lon);
    if (lat !== null && lon !== null) return [lat, lon];
    const bounds = parseBBox(item?.bbox);
    if (bounds) return [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2];
    return DEFAULT_VIEW.center;
  }

  function updateContext() {
    const location = getLocation();
    const item = state.selectedUnit || state.selectedProvince;
    const area = number(item?.area_km2);
    $("#map-context-title").textContent = location.adminName || "Chưa chọn địa bàn";
    $("#map-context-subtitle").textContent = item
      ? `${item.type || "Đơn vị hành chính"} · Mã ${location.adminCode}${area === null ? "" : ` · ${formatArea(area, 2)} km²`}`
      : "Đang nạp bộ đơn vị hành chính…";
    $("#context-baseline").textContent = `${$("#start_dk").value} — ${$("#end_dk").value}`;
    $("#context-comparison").textContent = `${$("#start_ck").value} — ${$("#end_ck").value}`;
    updateExternalLinks();
  }

  function updateExternalLinks() {
    const [lat, lon] = selectionCenter();
    const query = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    const earthUrl = `https://earth.google.com/web/@${lat.toFixed(6)},${lon.toFixed(6)},25000a,35000d,35y,0h,0t,0r`;
    const mapsLink = $("#open-google-maps");
    const earthLink = $("#open-google-earth");
    const topEarthLink = $("#open-earth");
    if (mapsLink) mapsLink.href = mapsUrl;
    if (earthLink) earthLink.href = earthUrl;
    if (topEarthLink) topEarthLink.href = earthUrl;
  }

  function setMapStatus(message, kind = "") {
    const node = $("#boundary-status");
    if (!node) return;
    node.classList.toggle("is-error", kind === "error");
    node.innerHTML = `<span class="inline-status-dot ${kind}"></span>${escapeHTML(message)}`;
  }

  function createGridLayer() {
    const layer = new V.LayerGroup();
    for (let longitude = 102; longitude <= 110; longitude += 1) {
      layer.addLayer(new V.Polyline([[8, longitude], [24, longitude]], { color: "#6e8290", weight: .55, opacity: .28, dashArray: "2 5", interactive: false }));
    }
    for (let latitude = 9; latitude <= 24; latitude += 1) {
      layer.addLayer(new V.Polyline([[latitude, 102], [latitude, 110]], { color: "#6e8290", weight: .55, opacity: .28, dashArray: "2 5", interactive: false }));
    }
    return layer;
  }

  function createGoogleLayer(mapType) {
    if (CONFIG.googleApiKey && typeof V.googleMapTiles === "function") {
      return V.googleMapTiles(CONFIG.googleApiKey, { mapType });
    }
    if (CONFIG.useLegacyGoogleTiles && typeof V.legacyGoogleTiles === "function") {
      return V.legacyGoogleTiles({ mapType });
    }
    return new V.TileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors"
    });
  }

  function initMap() {
    if (!V || typeof V.vietflexMap !== "function") throw new Error("Vietflex core chưa được nạp.");
    state.map = V.vietflexMap("map", {
      googleMaps: false,
      zoomControl: false,
      attributionControl: false,
      center: DEFAULT_VIEW.center,
      zoom: DEFAULT_VIEW.zoom,
      minZoom: 4,
      maxZoom: 18
    });
    new V.ZoomControl({ position: "topright" }).addTo(state.map);
    if (V.ScaleControl) new V.ScaleControl({ position: "bottomleft", imperial: false, maxWidth: 90 }).addTo(state.map);
    new V.AttributionControl({ position: "bottomright" }).addTo(state.map);

    state.baseLayers = {
      roadmap: createGoogleLayer("roadmap"),
      satellite: createGoogleLayer("satellite"),
      hybrid: createGoogleLayer("hybrid"),
      terrain: createGoogleLayer("terrain")
    };
    state.baseLayer = state.baseLayers.roadmap.addTo(state.map);
    state.gridLayer = createGridLayer();
    state.resultLayer = new V.GeoJSON(null, { style: featureStyle, onEachFeature: bindFeature }).addTo(state.map);
    updateExternalLinks();
    state.map.on("click", handleMapClick);
  }

  function featureId(record) { return record?.id == null ? "" : String(record.id); }

  function boundaryRecordCode(record) {
    return String(record?.code ?? record?.ma ?? record?.admin_code ?? record?.properties?.code ?? "");
  }

  function boundaryRecordName(record) {
    return record?.name || record?.ten || record?.full_name || record?.properties?.name || "";
  }

  function nameVariants(value) {
    const base = stripAdminPrefix(value);
    const variants = new Set([base]);
    if (base.startsWith("la ")) variants.add(`ia ${base.slice(3)}`);
    if (base.startsWith("ia ")) variants.add(`la ${base.slice(3)}`);
    variants.add(base.replace(/^ai\s+/, "al "));
    variants.add(base.replace(/^al\s+/, "ai "));
    return variants;
  }

  function namesEquivalent(left, right) {
    const rightVariants = nameVariants(right);
    return [...nameVariants(left)].some(value => rightVariants.has(value));
  }

  function coordinateDistance(unit, record) {
    const lon = number(unit?.centroid_lon);
    const lat = number(unit?.centroid_lat);
    const centroid = Array.isArray(record?.centroid) ? [Number(record.centroid[0]), Number(record.centroid[1])] : null;
    if (lon === null || lat === null || !centroid || !Number.isFinite(centroid[0]) || !Number.isFinite(centroid[1])) return Infinity;
    return Math.hypot(lon - centroid[0], lat - centroid[1]);
  }

  function buildBoundaryMatchIndex() {
    state.boundaryForUnit.clear();
    state.unitByBoundaryId.clear();
    state.boundaryByProvince.clear();
    for (const record of state.boundaryRecords) {
      const province = stripAdminPrefix(record.province || record.province_name || "");
      if (!state.boundaryByProvince.has(province)) state.boundaryByProvince.set(province, []);
      state.boundaryByProvince.get(province).push(record);
    }
    for (const unit of state.units) {
      const provinceName = stripAdminPrefix(unit.province_name || unit.province_full_name || "");
      const provinceRecords = state.boundaryByProvince.get(provinceName) || [];
      const named = provinceRecords.filter(record => namesEquivalent(unit.name || unit.full_name, boundaryRecordName(record)));
      const pool = named.length ? named : provinceRecords;
      const ranked = pool.slice().sort((left, right) => {
        const leftType = normalizeAdminType(left.type || left.properties?.type || "") === normalizeAdminType(unit.type) ? 0 : 1;
        const rightType = normalizeAdminType(right.type || right.properties?.type || "") === normalizeAdminType(unit.type) ? 0 : 1;
        return leftType - rightType || coordinateDistance(unit, left) - coordinateDistance(unit, right);
      });
      const best = ranked[0];
      // Name variants cover known Ia/La and Ai/Al spelling differences in
      // the two public snapshots. A centroid guard prevents a wrong same-name
      // unit from becoming the clip/display target.
      if (best && (named.length || coordinateDistance(unit, best) <= 0.2)) {
        state.boundaryForUnit.set(String(unit.code), best);
        state.unitByBoundaryId.set(featureId(best), unit);
      }
    }
  }

  function unitFromBoundary(record) {
    if (!record) return null;
    const indexed = state.unitByBoundaryId.get(featureId(record));
    if (indexed) return indexed;
    const recordName = stripAdminPrefix(boundaryRecordName(record));
    const recordType = normalizeAdminType(record.type || record.properties?.type || "");
    const recordProvince = stripAdminPrefix(record.province || record.province_name || record.properties?.province || "");
    return state.units.find(item => {
      const unitName = stripAdminPrefix(item.name || item.full_name);
      const unitType = normalizeAdminType(item.type);
      const unitProvince = stripAdminPrefix(item.province_name || item.province_full_name || "");
      return unitName === recordName && (!recordType || unitType === recordType) && (!recordProvince || unitProvince === recordProvince);
    }) || null;
  }

  function findBoundaryRecords(location) {
    const item = state.selectedUnit || state.selectedProvince;
    if (!item) return [];
    const provinceName = stripAdminPrefix(state.selectedProvince?.name || state.selectedProvince?.full_name);
    if (state.selectedUnit) {
      const match = state.boundaryForUnit.get(String(item.code));
      return match ? [match] : [];
    }
    return state.boundaryByProvince.get(provinceName) || [];
  }

  function updateSelection() {
    const location = getLocation();
    const records = findBoundaryRecords(location);
    state.selectedBoundary = records;
    if (state.boundaryLayer) state.boundaryLayer.setSelected(records.map(featureId));
    const item = state.selectedUnit || state.selectedProvince;
    if (records.length) {
      setMapStatus(`Đã chọn ${location.adminName}. Ranh giới PMTiles sẵn sàng để clip ảnh.`, "");
    } else if (item) {
      setMapStatus(`Đã chọn ${location.adminName}; đang chờ khớp bản ghi ranh giới.`, "error");
    } else {
      setMapStatus("Ranh giới sẽ được lấy từ snapshot Vietflexmap/anhmap.", "");
    }
    updateContext();
  }

  function zoomToSelection() {
    if (!state.map) return;
    const item = state.selectedUnit || state.selectedProvince;
    const bounds = selectedBoundaryBounds() || parseBBox(item?.bbox);
    if (bounds) {
      state.map.fitBounds(bounds, { padding: [35, 35], maxZoom: state.selectedUnit ? 13 : 9, animate: true });
    } else {
      state.map.setView(selectionCenter(), state.selectedUnit ? 12 : 8, { animate: true });
    }
    updateExternalLinks();
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
    const seed = hashString([params.adminCode, params.startDK, params.endCK, params.monitorType, params.satellite].join("|"));
    const random = randomFrom(seed || 37);
    const center = selectionCenter();
    const features = [];
    for (let index = 0; index < 12; index += 1) {
      const angle = (Math.PI * 2 * index / 12) + random() * .35;
      const radius = .008 + random() * (params.adminLevel === "commune" ? .035 : .22);
      const lat = center[0] + Math.sin(angle) * radius;
      const lon = center[1] + Math.cos(angle) * radius * 1.32;
      const width = .004 + random() * .012;
      const height = .003 + random() * .010;
      const area = Math.max(.12, Number((.22 + random() * 5.8).toFixed(2)));
      const confidence = Math.round(76 + random() * 21);
      const shape = [
        [lon - width, lat - height * .35], [lon - width * .38, lat - height],
        [lon + width, lat - height * .64], [lon + width * .86, lat + height * .45],
        [lon - width * .22, lat + height], [lon - width, lat - height * .35]
      ];
      features.push({
        type: "Feature",
        properties: {
          id: `GS-${String(index + 1).padStart(3, "0")}`,
          name: `Vùng ${String(index + 1).padStart(2, "0")}`,
          locality: params.adminName,
          area_ha: area,
          confidence,
          monitor_type: params.monitorType,
          monitor_label: params.monitorLabel,
          satellite: params.satelliteLabel,
          period: `${params.startCK} — ${params.endCK}`,
          centroid: `${lat.toFixed(5)}, ${lon.toFixed(5)}`
        },
        geometry: { type: "Polygon", coordinates: [shape] }
      });
    }
    const filtered = features.filter(feature => feature.properties.area_ha >= Number(params.minArea || 0) && (params.maxArea == null || feature.properties.area_ha <= Number(params.maxArea)));
    return {
      type: "FeatureCollection",
      features: filtered,
      metadata: {
        source: "browser-demo",
        generated_at: new Date().toISOString(),
        admin_code: params.adminCode,
        clip_verified: false,
        note: "Vị trí minh họa; cần API backend để cắt ảnh thật theo ranh giới hành chính."
      }
    };
  }

  function featureStyle(feature) {
    const increase = feature.properties?.monitor_type === "+" || feature.properties?.change_type === "increase";
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
        event.originalEvent?.stopPropagation();
        state.map.fitBounds(event.target.getBounds(), { maxZoom: 14, padding: [100, 100], animate: true });
        event.target.openPopup();
      }
    });
    layer.bindPopup(createPopup(feature.properties), { closeButton: true, offset: [0, -2] });
  }

  function createPopup(properties = {}) {
    const increase = properties.monitor_type === "+" || properties.change_type === "increase";
    const badgeClass = increase ? "increase" : "decrease";
    return `<div class="result-popup"><div class="popup-kicker">${escapeHTML(properties.id || "VÙNG")} · ĐIỂM PHÁT HIỆN</div><h3>${escapeHTML(properties.name || "Vùng biến động")}</h3><span class="popup-badge ${badgeClass}"><span class="status-dot ${increase ? "" : "amber"}"></span>${escapeHTML(properties.monitor_label || (increase ? "Biến động tăng" : "Biến động giảm"))}</span><div class="popup-grid"><div><span>Diện tích</span><strong>${formatArea(properties.area_ha, 2)} ha</strong></div><div><span>Độ tin cậy</span><strong>${number(properties.confidence, 0) ?? "—"}%</strong></div><div><span>Địa bàn</span><strong>${escapeHTML(properties.locality || "—")}</strong></div><div><span>Tâm vùng</span><strong>${escapeHTML(properties.centroid || "—")}</strong></div></div></div>`;
  }

  function normalizeCollection(payload, params) {
    const collection = payload?.type === "FeatureCollection" ? payload : payload?.result;
    if (!collection || collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
      throw new Error("API chưa trả về GeoJSON FeatureCollection hợp lệ.");
    }
    const metadata = Object.assign({}, collection.metadata || payload.metadata || {}, {
      admin_code: collection.metadata?.admin_code || payload.metadata?.admin_code || params.adminCode,
      clip_verified: collection.metadata?.clip_verified === true,
      sensor: collection.metadata?.sensor || params.satellite,
      query: params
    });
    if (metadata.admin_code && String(metadata.admin_code) !== String(params.adminCode)) {
      throw new Error("API trả về AOI khác với ranh giới đang chọn.");
    }
    return Object.assign(collection, { metadata });
  }

  function apiUrl(path) { return `${String(CONFIG.apiBase).replace(/\/$/, "")}${path}`; }

  async function readJSON(response) {
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.detail || payload?.message || `API trả về HTTP ${response.status}.`);
    return payload;
  }

  async function pollJob(job) {
    const statusUrl = job.status_url ? new URL(job.status_url, CONFIG.apiBase).href : apiUrl(`${CONFIG.monitorPath.replace(/\/$/, "")}/${encodeURIComponent(job.job_id)}`);
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await wait(1000);
      const payload = await readJSON(await fetch(statusUrl, { headers: { Accept: "application/json" } }));
      const status = String(payload.status || payload.state || "").toLowerCase();
      if (["failed", "error", "cancelled"].includes(status)) throw new Error(payload.error || "Job phân tích thất bại.");
      if (["completed", "complete", "done", "success"].includes(status)) {
        if (payload.result?.type === "FeatureCollection") return payload.result;
        const resultUrl = payload.result_url || payload.geojson_url;
        if (!resultUrl) throw new Error("Job hoàn tất nhưng thiếu result_url.");
        return readJSON(await fetch(new URL(resultUrl, CONFIG.apiBase), { headers: { Accept: "application/geo+json, application/json" } }));
      }
      $("#loading-step").textContent = payload.message || `Đang xử lý job… (${attempt + 1}/90)`;
    }
    throw new Error("Job quá thời gian chờ ở giao diện. Có thể kiểm tra lại bằng mã job.");
  }

  async function calculate(params) {
    if (!CONFIG.apiBase || CONFIG.demoMode) {
      await wait(420);
      return buildDemoCollection(params);
    }
    const response = await fetch(apiUrl(CONFIG.monitorPath), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, application/geo+json" },
      body: JSON.stringify({
        admin_code: params.adminCode,
        admin_level: params.adminLevel,
        province_code: params.provinceCode,
        unit_code: params.unitCode || null,
        satellite: params.satellite,
        monitor_type: params.monitorType,
        start_dk: params.startDK,
        end_dk: params.endDK,
        start_ck: params.startCK,
        end_ck: params.endCK,
        min_area: params.minArea,
        max_area: params.maxArea,
        clip_to_admin_boundary: true,
        output: ["geojson", "geotiff", "png"]
      })
    });
    const payload = await readJSON(response);
    const collection = payload.type === "FeatureCollection" ? payload : payload.job_id ? await pollJob(payload) : payload;
    state.job = payload.job_id ? payload : null;
    return normalizeCollection(collection, params);
  }

  function renderCollection(collection, params) {
    state.resultCollection = collection;
    state.lastParams = params;
    state.resultLayer.clearLayers();
    state.resultLayer.addData(collection);
    updateStats(collection);
    $("#results-drawer").hidden = false;
    $("#results-title").textContent = collection.features.length ? "Đã phát hiện biến động" : "Không có vùng phù hợp";
    const metadata = collection.metadata || {};
    const verified = metadata.clip_verified === true;
    $("#results-disclaimer").innerHTML = verified
      ? `<span class="status-dot"></span> Kết quả đã được backend xác nhận clip theo AOI <code>${escapeHTML(metadata.admin_code || params.adminCode)}</code>. Ảnh tải xuống dùng cùng geometry.`
      : `<span class="status-dot amber"></span> Chế độ minh họa phía trình duyệt; chưa phải kết quả ảnh vệ tinh và chưa xác nhận clip hình học.`;
    $("#map-attribution").innerHTML = `${escapeHTML(params.satelliteLabel)} · Copernicus/USGS <span>•</span> Vietflex Map <span>•</span> AOI ${escapeHTML(params.adminCode)}`;
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
      const item = feature.properties || {};
      const color = item.monitor_type === "+" || item.change_type === "increase" ? "#1ab8a0" : "#eb6d5b";
      return `<div class="result-row"><div class="result-name"><span class="result-color" style="background:${color}"></span><span>${escapeHTML(item.id || "Vùng")} · ${escapeHTML(item.locality || "")}</span></div><span>${formatArea(item.area_ha, 2)} ha</span><span>${number(item.confidence, 0) ?? "—"}%</span><button type="button" data-focus-result="${escapeHTML(item.id || "")}">Xem</button></div>`;
    }).join("") : `<div class="empty-results"><span>Không có vùng nào vượt ngưỡng diện tích đã chọn.</span></div>`;
    $$('[data-focus-result]', list).forEach(button => button.addEventListener("click", () => focusResult(button.dataset.focusResult)));
  }

  function focusResult(id) {
    const feature = state.resultCollection?.features.find(item => String(item.properties?.id) === String(id));
    if (!feature) return;
    state.resultLayer.eachLayer(layer => {
      if (String(layer.feature?.properties?.id) === String(id)) {
        state.map.fitBounds(layer.getBounds(), { maxZoom: 14, padding: [100, 100], animate: true });
        layer.openPopup();
        layer.setStyle(Object.assign({}, featureStyle(feature), { weight: 2.8, fillOpacity: .74 }));
        window.setTimeout(() => state.resultLayer.resetStyle(layer), 1100);
      }
    });
  }

  function wait(milliseconds) { return new Promise(resolve => window.setTimeout(resolve, milliseconds)); }

  function setLoading(loading) {
    const button = $("#calculate-button");
    button.disabled = loading;
    button.classList.toggle("is-loading", loading);
    button.querySelector(".button-label").textContent = loading ? "Đang tính" : "Tính toán";
    $("#map-loading").hidden = !loading;
  }

  function updateSystemMode() {
    const mode = $("#system-mode");
    if (!mode) return;
    mode.textContent = CONFIG.apiBase && !CONFIG.demoMode
      ? "Backend clip AOI · job API"
      : `Demo UI · ${EXPECTED_ADMIN.units.toLocaleString("vi-VN")} đơn vị hành chính`;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const validation = validateForm(true);
    const location = getLocation();
    if (!location.adminCode) {
      showToast("Chưa có mã ranh giới hành chính để phân tích.", "error");
      return;
    }
    if (!validation.valid) {
      showToast("Vui lòng kiểm tra lại các trường được đánh dấu.", "error");
      $(".input-error")?.focus();
      return;
    }
    const params = getParams();
    setLoading(true);
    const steps = ["Đọc mã AOI hành chính…", "Kiểm tra khoảng thời gian…", `Đang phân tích ${params.satelliteLabel}…`, "Clip và tổng hợp vùng biến động…"];
    try {
      for (let index = 0; index < steps.length - 1; index += 1) {
        $("#loading-step").textContent = steps[index];
        await wait(180);
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

  function dateStamp() { return `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`; }

  function downloadGeoJSON() {
    if (!state.resultCollection) return showToast("Hãy tính toán trước khi tải bản đồ.", "warning");
    downloadBlob(JSON.stringify(state.resultCollection, null, 2), `vietflex-giamsat-${dateStamp()}.geojson`, "application/geo+json;charset=utf-8");
    showToast("Đã tải lớp kết quả GeoJSON.", "success");
  }

  function downloadImage() {
    const metadata = state.resultCollection?.metadata || {};
    const url = metadata.geotiff_url || metadata.image_url || metadata.download_url;
    if (!url) return showToast("API chưa trả về URL ảnh đã clip. Demo chỉ tải được GeoJSON/CSV.", "warning");
    const anchor = document.createElement("a");
    anchor.href = new URL(url, CONFIG.apiBase || window.location.href).href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.click();
  }

  function downloadCSV() {
    const features = state.resultCollection?.features || [];
    if (!features.length) return showToast("Chưa có dữ liệu kết quả để tải.", "warning");
    const header = ["id", "dia_ban", "dien_tich_ha", "do_tin_cay_pct", "loai_giam_sat", "ve_tinh", "tam_vung"];
    const rows = features.map(feature => {
      const item = feature.properties || {};
      return [item.id, item.locality, item.area_ha, item.confidence, item.monitor_label, item.satellite, item.centroid].map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",");
    });
    downloadBlob(`\ufeff${header.join(",")}\n${rows.join("\n")}`, `vietflex-giamsat-${dateStamp()}.csv`, "text/csv;charset=utf-8");
    showToast("Đã tải bảng kết quả CSV.", "success");
  }

  function setBaseMap(name) {
    const layer = state.baseLayers[name];
    if (!layer || !state.map) return;
    if (state.baseLayer) state.map.removeLayer(state.baseLayer);
    layer.addTo(state.map);
    state.baseLayer = layer;
    state.activeBase = name;
    $$('[data-basemap]').forEach(button => button.classList.toggle("active", button.dataset.basemap === name));
    $("#map-attribution").innerHTML = `${name === "satellite" || name === "hybrid" ? "Google imagery" : "Google Maps"} <span>•</span> Vietflex Map <span>•</span> Ranh giới Vietflexmap/anhmap`;
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

  function toggleLayers() { $("#layer-popover").hidden = !$("#layer-popover").hidden; }

  function setPanel(open) {
    state.panelOpen = open;
    $("#control-panel").classList.toggle("is-open", open);
    $("#mobile-menu").setAttribute("aria-expanded", String(open));
  }

  function findSearchMatch(query) {
    const text = normalize(query);
    if (!text) return null;
    const exactCode = state.unitByCode.get(String(query).trim());
    if (exactCode) return { type: "unit", item: exactCode };
    const unit = state.units.find(item => normalize(`${item.full_name} ${item.name} ${item.province_name || ""} ${item.code}`).includes(text));
    if (unit) return { type: "unit", item: unit };
    const province = state.provinces.find(item => normalize(`${item.full_name} ${item.name} ${item.code}`).includes(text));
    return province ? { type: "province", item: province } : null;
  }

  function handleSearch(event) {
    if (event.key !== "Enter") return;
    const match = findSearchMatch(event.currentTarget.value);
    if (!match) return showToast("Chưa tìm thấy địa danh trong snapshot 34 tỉnh/thành.", "warning");
    if (match.type === "province") {
      $("#province").value = optionValue(match.item);
      $("#province").dispatchEvent(new Event("change"));
      showToast(`Đã định vị ${match.item.full_name || match.item.name}.`, "success");
      return;
    }
    $("#province").value = optionValue(state.provinces.find(item => Number(item.order) === Number(match.item.province_order)));
    $("#province").dispatchEvent(new Event("change"));
    $("#unit-type").value = normalizeAdminType(match.item.type);
    $("#unit-type").dispatchEvent(new Event("change"));
    $("#commune").value = String(match.item.code);
    $("#commune").dispatchEvent(new Event("change"));
    showToast(`Đã định vị ${match.item.full_name || match.item.name}.`, "success");
  }

  async function handleMapClick(event) {
    if (!state.boundaryLayer) return;
    try {
      const feature = await state.boundaryLayer.featureAt(event.latlng, state.map.getZoom(), state.map);
      if (!feature) return;
      const id = String(feature.properties?.id ?? "");
      const record = state.boundaryRecords.find(item => featureId(item) === id);
      const code = boundaryRecordCode(record || feature.properties);
      const unit = state.unitByCode.get(code) || unitFromBoundary(record || feature.properties);
      if (unit) {
        $("#province").value = optionValue(state.provinces.find(item => Number(item.order) === Number(unit.province_order)));
        $("#province").dispatchEvent(new Event("change"));
        $("#unit-type").value = normalizeAdminType(unit.type);
        $("#unit-type").dispatchEvent(new Event("change"));
        $("#commune").value = String(unit.code);
        $("#commune").dispatchEvent(new Event("change"));
      } else if (record || feature.properties?.level === "province") {
        const provinceName = boundaryRecordName(record || feature.properties);
        const province = state.provinces.find(item => stripAdminPrefix(item.name || item.full_name) === stripAdminPrefix(provinceName));
        if (province) {
          $("#province").value = optionValue(province);
          $("#province").dispatchEvent(new Event("change"));
        }
      }
    } catch (error) {
      console.warn("Boundary click failed", error);
    }
  }

  async function loadBoundary() {
    if (!window.PROMISE_BOUNDARY_IMPORT) {
      window.PROMISE_BOUNDARY_IMPORT = Promise.all([
        import("https://cdn.jsdelivr.net/npm/pmtiles@4.4.1/+esm"),
        import("https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.4/+esm"),
        import("https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm")
      ]);
    }
    const [pmtilesModule, vectorTileModule, pbfModule] = await window.PROMISE_BOUNDARY_IMPORT;
    const PMTiles = pmtilesModule.PMTiles;
    const VectorTile = vectorTileModule.VectorTile;
    const Pbf = pbfModule.default || pbfModule.Pbf;
    let lastError = null;
    for (const url of CONFIG.boundaryHtmlUrls) {
      try {
        const response = await fetch(url, { cache: "force-cache" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const documentText = await response.text();
        const doc = new DOMParser().parseFromString(documentText, "text/html");
        const pmtilesNode = doc.getElementById("pmtilesData");
        const adminNode = doc.getElementById("adminData");
        if (!pmtilesNode || !adminNode) throw new Error("Thiếu pmtilesData/adminData.");
        const boundaryPayload = JSON.parse(adminNode.textContent);
        state.boundaryRecords = boundaryPayload.records || [];
        state.boundaryByCode.clear();
        state.boundaryRecords.forEach(record => {
          const code = boundaryRecordCode(record);
          if (code) state.boundaryByCode.set(code, record);
        });
        buildBoundaryMatchIndex();
        const archive = new PMTiles(new MemorySource(decodeBase64(pmtilesNode.textContent)));
        state.boundaryLayer = new BoundaryTileLayer(archive, VectorTile, Pbf, { attribution: `Ranh giới: ${BOUNDARY_SOURCE}` }).addTo(state.map);
        updateSelection();
        setMapStatus(`Ranh giới PMTiles sẵn sàng · ${state.boundaryRecords.length.toLocaleString("vi-VN")} bản ghi.`, "");
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Không tải được PMTiles ranh giới.");
  }

  class MemorySource {
    constructor(bytes) { this.bytes = bytes; this.key = `memory://vietflex-admin-boundary-${bytes.byteLength}`; }
    getKey() { return this.key; }
    async getBytes(offset, length) {
      const view = this.bytes.subarray(offset, offset + length);
      return { data: view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) };
    }
  }

  function decodeBase64(value) {
    const binary = atob(String(value).replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function pointInRing(x, y, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const current = ring[index];
      const last = ring[previous];
      if (((current.y > y) !== (last.y > y)) && x < (last.x - current.x) * (y - current.y) / ((last.y - current.y) || Number.EPSILON) + current.x) inside = !inside;
    }
    return inside;
  }

  function pointInGeometry(x, y, geometry) {
    let inside = false;
    for (const ring of geometry || []) if (ring.length > 2 && pointInRing(x, y, ring)) inside = !inside;
    return inside;
  }

  class BoundaryTileLayer extends V.GridLayer {
    initialize(archive, VectorTile, Pbf, options = {}) {
      super.initialize(Object.assign({
        tileSize: 256,
        minZoom: CONFIG.boundaryMinZoom,
        maxZoom: CONFIG.boundaryMaxZoom,
        minNativeZoom: CONFIG.boundaryMinZoom,
        maxNativeZoom: CONFIG.boundaryNativeMaxZoom,
        noWrap: true,
        updateWhenIdle: false,
        keepBuffer: 2,
        className: "boundary-canvas"
      }, options));
      this.archive = archive;
      this.VectorTile = VectorTile;
      this.Pbf = Pbf;
      this.decoded = new Map();
      this.selectedIds = new Set();
    }

    async getDecodedTile(z, x, y) {
      const key = `${z}/${x}/${y}`;
      if (!this.decoded.has(key)) {
        this.decoded.set(key, this.archive.getZxy(z, x, y).then(result => {
          if (!result) return [];
          const vectorTile = new this.VectorTile(new this.Pbf(new Uint8Array(result.data)));
          const layer = vectorTile.layers.admin;
          if (!layer) return [];
          const features = [];
          for (let index = 0; index < layer.length; index += 1) {
            const feature = layer.feature(index);
            if (feature.type !== 3) continue;
            features.push({ properties: feature.properties || {}, geometry: feature.loadGeometry(), extent: layer.extent || 4096 });
          }
          return features;
        }));
      }
      return this.decoded.get(key);
    }

    createTile(coords, done) {
      const tile = document.createElement("canvas");
      const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      tile.width = 256 * ratio;
      tile.height = 256 * ratio;
      tile.style.width = "256px";
      tile.style.height = "256px";
      const context = tile.getContext("2d");
      context.scale(ratio, ratio);
      const sourceZoom = Math.min(CONFIG.boundaryNativeMaxZoom, coords.z);
      const factor = 2 ** (coords.z - sourceZoom);
      const sourceX = Math.floor(coords.x / factor);
      const sourceY = Math.floor(coords.y / factor);
      const offsetX = (coords.x - sourceX * factor) * 256 / factor;
      const offsetY = (coords.y - sourceY * factor) * 256 / factor;
      this.getDecodedTile(sourceZoom, sourceX, sourceY)
        .then(features => {
          this.paint(context, features, { factor, offsetX, offsetY });
          done(null, tile);
        })
        .catch(error => done(error, tile));
      return tile;
    }

    paint(context, features, { factor = 1, offsetX = 0, offsetY = 0 } = {}) {
      context.save();
      context.lineJoin = "round";
      context.lineCap = "round";
      for (const feature of features) {
        const properties = feature.properties || {};
        const id = String(properties.id ?? "");
        const selected = this.selectedIds.has(id);
        context.beginPath();
        for (const ring of feature.geometry || []) {
          if (!ring.length) continue;
          ring.forEach((point, index) => {
            const x = (point.x / feature.extent * 256 - offsetX) * factor;
            const y = (point.y / feature.extent * 256 - offsetY) * factor;
            index ? context.lineTo(x, y) : context.moveTo(x, y);
          });
          context.closePath();
        }
        const province = properties.level === "province";
        context.fillStyle = selected ? "rgba(255, 220, 80, .34)" : province ? "rgba(190, 35, 51, .025)" : "rgba(140, 38, 53, .025)";
        context.fill("evenodd");
        context.strokeStyle = selected ? "#d71920" : province ? "#641622" : "#8c2635";
        context.setLineDash(selected ? [] : province ? [9, 5] : [5, 4]);
        context.lineWidth = selected ? 2.4 : province ? 1.65 : 1.05;
        context.globalAlpha = selected ? 1 : .9;
        context.stroke();
        context.globalAlpha = 1;
      }
      context.restore();
    }

    setSelected(ids = []) {
      this.selectedIds = new Set(ids.map(String));
      this.redraw();
    }

    async featureAt(latlng, mapZoom, map) {
      const zoom = Math.min(CONFIG.boundaryNativeMaxZoom, Math.max(CONFIG.boundaryMinZoom, Math.round(mapZoom)));
      const projected = map.project(latlng, zoom);
      const tileX = Math.floor(projected.x / 256);
      const tileY = Math.floor(projected.y / 256);
      const features = await this.getDecodedTile(zoom, tileX, tileY);
      if (!features.length) return null;
      const localX = (projected.x - tileX * 256) / 256 * features[0].extent;
      const localY = (projected.y - tileY * 256) / 256 * features[0].extent;
      for (let index = features.length - 1; index >= 0; index -= 1) {
        if (pointInGeometry(localX, localY, features[index].geometry)) return features[index];
      }
      return null;
    }
  }

  function setupUI() {
    initializeDates();
    initMap();
    updateSystemMode();
    $("#monitor-form").addEventListener("submit", handleSubmit);
    $("#download-map").addEventListener("click", downloadGeoJSON);
    $("#download-image").addEventListener("click", downloadImage);
    $("#download-csv").addEventListener("click", downloadCSV);
    $("#close-results").addEventListener("click", () => { $("#results-drawer").hidden = true; });
    $("#toggle-layers").addEventListener("click", toggleLayers);
    $("#layer-results").addEventListener("change", event => { if (event.target.checked) state.resultLayer.addTo(state.map); else state.map.removeLayer(state.resultLayer); });
    $("#layer-boundary").addEventListener("change", event => { if (event.target.checked && state.boundaryLayer) state.boundaryLayer.addTo(state.map); else if (state.boundaryLayer) state.map.removeLayer(state.boundaryLayer); });
    $("#layer-grid").addEventListener("change", event => { if (event.target.checked) state.gridLayer.addTo(state.map); else state.map.removeLayer(state.gridLayer); });
    $$('[data-basemap]').forEach(button => button.addEventListener("click", () => setBaseMap(button.dataset.basemap)));
    $("#reset-view").addEventListener("click", () => state.selectedProvince ? zoomToSelection() : state.map.setView(VIETNAM_VIEW.center, VIETNAM_VIEW.zoom, { animate: true }));
    $("#locate-me").addEventListener("click", () => {
      if (!navigator.geolocation) return showToast("Trình duyệt không hỗ trợ định vị.", "warning");
      navigator.geolocation.getCurrentPosition(position => state.map.setView([position.coords.latitude, position.coords.longitude], 14), () => showToast("Không thể lấy vị trí hiện tại.", "warning"), { enableHighAccuracy: true, timeout: 7000 });
    });
    $("#fullscreen-button").addEventListener("click", () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.(); });
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
    window.addEventListener("resize", () => state.map.invalidateSize());

    loadAdminData()
      .then(() => loadBoundary())
      .then(() => {
        updateSelection();
        zoomToSelection();
      })
      .catch(error => {
        console.error("Administrative data/boundary error", error);
        setMapStatus(error.message || "Không tải được dữ liệu địa giới.", "error");
        showToast("Không thể nạp snapshot địa giới; kiểm tra kết nối rồi tải lại trang.", "error");
      });
  }

  document.addEventListener("DOMContentLoaded", setupUI);
})();
