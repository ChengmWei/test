/**
 * 金邊鍋貼 GOLDEN EDGE － 線上點餐後端（Google Apps Script + Google Sheets）
 *
 * 功能
 *  - doPost：接收網站送出的訂單 → 驗證 → 以「商品」表價格重新計算金額 → 寫入「訂單」「訂單明細」
 *  - doGet ：健康檢查（?action=ping）、訂單狀態查詢（?action=status&id=訂單編號&phone=手機）
 *  - 每日流水號訂單編號：GE-YYYYMMDD-001
 *  - 防重複送出（clientOrderId）、同一手機 30 秒內限送一次、機器人誘餌欄位
 *  - 新訂單 Email 通知（指令碼屬性 NOTIFY_EMAIL）
 *  - 試算表選單「金邊鍋貼」：初始化工作表、更新每日統計、建立測試訂單、設定每日自動統計
 *
 * 部署步驟請見 gas/README.md
 */

// ============================== 設定 ==============================
const CONFIG = {
  TIMEZONE: "Asia/Taipei",
  ORDER_PREFIX: "GE",
  SHEETS: {
    ORDERS: "訂單",
    ITEMS: "訂單明細",
    PRODUCTS: "商品",
    DAILY: "每日統計",
  },
  ORDER_TYPES: ["內用", "外帶", "宅配"],
  STATUSES: ["新訂單", "製作中", "可取餐", "配送中", "已完成", "已取消"],
  MAX_QTY_PER_ITEM: 99,
  MAX_ITEMS: 30,
  RATE_LIMIT_SECONDS: 30,
  DEDUPE_SECONDS: 600,
};

const ORDER_HEADERS = [
  "訂單編號", "建立時間", "狀態", "服務方式", "姓名", "手機", "地址", "備註",
  "品項摘要", "商品數量", "商品合計", "來源", "前端訂單ID",
];
const ITEM_HEADERS = ["訂單編號", "建立時間", "商品ID", "品名", "單價", "數量", "小計"];
const PRODUCT_HEADERS = ["商品ID", "品名", "分類", "單價", "單位", "上架"];
const DAILY_HEADERS = ["日期", "訂單數", "已取消", "有效營收", "內用", "外帶", "宅配", "平均客單價"];

// 初始商品資料（與網站 index.html 的 products 相同）；之後以「商品」工作表為準
const DEFAULT_PRODUCTS = [
  ["p1", "經典鮮肉鍋貼", "potsticker", 75, "10顆", true],
  ["p2", "韭菜鮮肉鍋貼", "potsticker", 80, "10顆", true],
  ["p3", "香辣鮮肉鍋貼", "potsticker", 85, "10顆", true],
  ["p4", "鮮蝦高麗菜水餃", "dumpling", 110, "10顆", true],
  ["p5", "手工韭菜水餃", "dumpling", 80, "10顆", true],
  ["p6", "玉米鮮肉水餃", "dumpling", 85, "10顆", true],
  ["p7", "經典酸辣湯", "soup", 45, "1碗", true],
  ["p8", "鮮菇蔬菜湯", "soup", 45, "1碗", true],
  ["p9", "香濃無糖豆漿", "soup", 30, "1杯", true],
  ["p10", "黃金泡菜", "side", 45, "1份", true],
  ["p11", "涼拌小黃瓜", "side", 40, "1份", true],
  ["p12", "手工滷豆干", "side", 40, "1份", true],
  ["gift1", "金邊經典家庭禮盒", "gift", 399, "50入", true],
  ["gift2", "金邊招財雙拼禮盒", "gift", 499, "60入", true],
];

// ============================== Web App 入口 ==============================
function doPost(e) {
  try {
    const body = parseBody_(e);
    const result = createOrder_(body);
    return json_(result);
  } catch (err) {
    return json_(errorResult_(err));
  }
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === "status") return json_(getOrderStatus_(p.id, p.phone));
    return json_({ ok: true, service: "golden-edge-orders", time: now_().toISOString() });
  } catch (err) {
    return json_(errorResult_(err));
  }
}

// ============================== 建立訂單 ==============================
function createOrder_(body) {
  // 機器人誘餌欄位：真人看不到，有填就當作成功但不寫入
  if (body.website) return { ok: true, orderId: "GE-IGNORED", total: 0 };

  const order = validateOrder_(body);
  const cache = CacheService.getScriptCache();

  // 防重複：同一個前端訂單 ID 重送時，回傳第一次的結果
  const dedupeKey = "dedupe:" + order.clientOrderId;
  const cached = order.clientOrderId && cache.get(dedupeKey);
  if (cached) return JSON.parse(cached);

  // 洗單防護：同一手機短時間內只能送一次
  const rateKey = "rate:" + order.phone;
  if (cache.get(rateKey)) {
    throw userError_("RATE_LIMIT", "送出太頻繁，請稍候 " + CONFIG.RATE_LIMIT_SECONDS + " 秒再試。");
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw userError_("BUSY", "系統忙碌中，請稍後再試。");
  try {
    // 取得鎖之後再檢查一次，避免兩個重送請求同時通過
    const again = order.clientOrderId && cache.get(dedupeKey);
    if (again) return JSON.parse(again);

    const ss = getSpreadsheet_();
    ensureSheets_(ss);
    const priced = priceItems_(ss, order.items);
    const created = now_();
    const orderId = nextOrderId_(created);
    const summary = priced.lines.map((l) => l.name + "×" + l.qty).join("、");

    ss.getSheetByName(CONFIG.SHEETS.ORDERS).appendRow([
      orderId, created, "新訂單", order.orderType, order.name, "'" + order.phone,
      order.address, order.note, summary, priced.count, priced.total,
      order.source, order.clientOrderId,
    ]);
    const itemRows = priced.lines.map((l) => [orderId, created, l.id, l.name, l.price, l.qty, l.subtotal]);
    const itemSheet = ss.getSheetByName(CONFIG.SHEETS.ITEMS);
    itemSheet.getRange(itemSheet.getLastRow() + 1, 1, itemRows.length, ITEM_HEADERS.length).setValues(itemRows);
    SpreadsheetApp.flush();

    const result = {
      ok: true,
      orderId: orderId,
      total: priced.total,
      count: priced.count,
      lines: priced.lines.map((l) => ({ name: l.name, qty: l.qty, subtotal: l.subtotal })),
      createdAt: Utilities.formatDate(created, CONFIG.TIMEZONE, "yyyy/MM/dd HH:mm"),
    };
    if (order.clientOrderId) cache.put(dedupeKey, JSON.stringify(result), CONFIG.DEDUPE_SECONDS);
    cache.put(rateKey, "1", CONFIG.RATE_LIMIT_SECONDS);

    notify_(result, order);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function validateOrder_(b) {
  const str = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  const order = {
    orderType: str(b.orderType, 10),
    name: str(b.name, 40),
    phone: str(b.phone, 20).replace(/[\s-]/g, ""),
    address: str(b.address, 120),
    note: str(b.note, 200),
    source: str(b.source, 40) || "web",
    clientOrderId: str(b.clientOrderId, 64).replace(/[^\w-]/g, ""),
    items: Array.isArray(b.items) ? b.items : [],
  };
  if (CONFIG.ORDER_TYPES.indexOf(order.orderType) < 0) throw userError_("INVALID", "請選擇取餐 / 配送方式。");
  if (!order.name) throw userError_("INVALID", "請填寫聯絡姓名。");
  if (!/^09\d{8}$/.test(order.phone)) throw userError_("INVALID", "請輸入 09 開頭的 10 位手機號碼。");
  if (order.orderType === "宅配" && order.address.length < 5) throw userError_("INVALID", "宅配請填寫完整配送地址。");
  if (order.orderType !== "宅配") order.address = "";
  if (!order.items.length) throw userError_("INVALID", "購物車沒有商品。");
  if (order.items.length > CONFIG.MAX_ITEMS) throw userError_("INVALID", "品項數量過多。");
  // 防止試算表公式注入
  ["name", "address", "note"].forEach((k) => { if (/^[=+\-@]/.test(order[k])) order[k] = "'" + order[k]; });
  return order;
}

/** 以「商品」工作表的價格計算，不信任前端送來的金額 */
function priceItems_(ss, items) {
  const rows = ss.getSheetByName(CONFIG.SHEETS.PRODUCTS).getDataRange().getValues().slice(1);
  const catalog = {};
  rows.forEach((r) => {
    const id = String(r[0]).trim();
    if (id) catalog[id] = { id: id, name: String(r[1]), price: Number(r[3]), active: r[5] === true || String(r[5]).toUpperCase() === "TRUE" };
  });

  const merged = {};
  items.forEach((it) => {
    const id = String((it && it.id) || "").trim();
    const qty = Math.floor(Number(it && it.qty));
    if (!id || !(qty > 0)) throw userError_("INVALID", "商品數量不正確。");
    merged[id] = (merged[id] || 0) + qty;
  });

  const lines = Object.keys(merged).map((id) => {
    const p = catalog[id];
    if (!p) throw userError_("ITEM_UNAVAILABLE", "有商品已不存在，請重新整理頁面後再試。");
    if (!p.active) throw userError_("ITEM_UNAVAILABLE", "「" + p.name + "」目前暫停供應，請從購物車移除後再試。");
    if (!(p.price >= 0)) throw new Error("商品價格設定錯誤：" + id);
    const qty = merged[id];
    if (qty > CONFIG.MAX_QTY_PER_ITEM) throw userError_("INVALID", "「" + p.name + "」單項最多 " + CONFIG.MAX_QTY_PER_ITEM + " 份。");
    return { id: id, name: p.name, price: p.price, qty: qty, subtotal: p.price * qty };
  });

  return {
    lines: lines,
    count: lines.reduce((s, l) => s + l.qty, 0),
    total: lines.reduce((s, l) => s + l.subtotal, 0),
  };
}

/** 每日流水號：GE-20261116-001（需在鎖內呼叫） */
function nextOrderId_(date) {
  const day = Utilities.formatDate(date, CONFIG.TIMEZONE, "yyyyMMdd");
  const props = PropertiesService.getScriptProperties();
  const key = "seq_" + day;
  const seq = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(seq));
  return CONFIG.ORDER_PREFIX + "-" + day + "-" + ("00" + seq).slice(-Math.max(3, String(seq).length));
}

// ============================== 訂單查詢 ==============================
function getOrderStatus_(id, phone) {
  id = String(id || "").trim();
  phone = String(phone || "").replace(/[\s-]/g, "");
  if (!id || !/^09\d{8}$/.test(phone)) throw userError_("INVALID", "請提供訂單編號與手機號碼。");
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEETS.ORDERS);
  if (!sheet || sheet.getLastRow() < 2) throw userError_("NOT_FOUND", "查無此訂單。");
  const found = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
  if (!found) throw userError_("NOT_FOUND", "查無此訂單。");
  const row = sheet.getRange(found.getRow(), 1, 1, ORDER_HEADERS.length).getValues()[0];
  if (String(row[5]).replace(/^'/, "") !== phone) throw userError_("NOT_FOUND", "查無此訂單。");
  return {
    ok: true,
    orderId: row[0],
    status: row[2],
    orderType: row[3],
    summary: row[8],
    total: row[10],
    createdAt: Utilities.formatDate(new Date(row[1]), CONFIG.TIMEZONE, "yyyy/MM/dd HH:mm"),
  };
}

// ============================== 通知 ==============================
function notify_(result, order) {
  const to = PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAIL");
  if (!to) return;
  try {
    const lines = result.lines.map((l) => "・" + l.name + " × " + l.qty + "　NT$ " + l.subtotal).join("\n");
    MailApp.sendEmail({
      to: to,
      subject: "【金邊鍋貼】新訂單 " + result.orderId + "（" + order.orderType + "，NT$ " + result.total + "）",
      body: [
        "訂單編號：" + result.orderId,
        "建立時間：" + result.createdAt,
        "服務方式：" + order.orderType,
        "姓名：" + order.name,
        "手機：" + order.phone,
        order.address ? "地址：" + order.address : "",
        order.note ? "備註：" + order.note : "",
        "",
        lines,
        "",
        "商品合計：NT$ " + result.total,
        "",
        "訂單試算表：" + getSpreadsheet_().getUrl(),
      ].filter((s, i, a) => s !== "" || a[i - 1] !== "").join("\n"),
    });
  } catch (err) {
    console.warn("通知寄送失敗", err); // 通知失敗不影響建單
  }
}

// ============================== 試算表選單與維護工具 ==============================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("金邊鍋貼")
    .addItem("① 初始化工作表", "setup")
    .addItem("更新每日統計", "updateDailySummary")
    .addItem("建立一筆測試訂單", "createTestOrder")
    .addSeparator()
    .addItem("設定每日自動統計（每晚 23 點）", "installDailyTrigger")
    .addToUi();
}

/** 建立／補齊所有工作表、表頭、狀態下拉選單與顏色 */
function setup() {
  const ss = getSpreadsheet_();
  ensureSheets_(ss);
  PropertiesService.getScriptProperties().setProperty("SPREADSHEET_ID", ss.getId());
  try {
    SpreadsheetApp.getUi().alert("初始化完成！\n\n接著請依 README 部署為「網頁應用程式」，並把網址貼到網站的 ORDER_API_URL。");
  } catch (e) { /* 從編輯器執行時沒有 UI */ }
}

function ensureSheets_(ss) {
  const S = CONFIG.SHEETS;
  const orders = ensureSheet_(ss, S.ORDERS, ORDER_HEADERS);
  ensureSheet_(ss, S.ITEMS, ITEM_HEADERS);
  ensureSheet_(ss, S.DAILY, DAILY_HEADERS);
  const products = ensureSheet_(ss, S.PRODUCTS, PRODUCT_HEADERS);
  if (products.getLastRow() < 2) {
    products.getRange(2, 1, DEFAULT_PRODUCTS.length, PRODUCT_HEADERS.length).setValues(DEFAULT_PRODUCTS);
    products.getRange(2, 6, DEFAULT_PRODUCTS.length, 1).insertCheckboxes();
  }

  if (!orders.getRange("C2").getDataValidation()) {
    const statusRange = orders.getRange("C2:C");
    statusRange.setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(CONFIG.STATUSES, true).setAllowInvalid(false).build()
    );
    const colors = { "新訂單": "#fde2c4", "製作中": "#fff2b3", "可取餐": "#d6ecff", "配送中": "#e5dbff", "已完成": "#d9f2d9", "已取消": "#eeeeee" };
    const rules = Object.keys(colors).map((s) =>
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(s).setBackground(colors[s]).setRanges([statusRange]).build()
    );
    orders.setConditionalFormatRules(rules);
    orders.getRange("B2:B").setNumberFormat("yyyy/MM/dd HH:mm");
    orders.getRange("K2:K").setNumberFormat("#,##0");
    ss.getSheetByName(S.ITEMS).getRange("B2:B").setNumberFormat("yyyy/MM/dd HH:mm");
  }
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight("bold").setBackground("#34251e").setFontColor("#ffffff");
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 依「訂單」重算「每日統計」（已取消不計營收） */
function updateDailySummary() {
  const ss = getSpreadsheet_();
  ensureSheets_(ss);
  const rows = ss.getSheetByName(CONFIG.SHEETS.ORDERS).getDataRange().getValues().slice(1);
  const days = {};
  rows.forEach((r) => {
    if (!r[0] || !r[1]) return;
    const day = Utilities.formatDate(new Date(r[1]), CONFIG.TIMEZONE, "yyyy/MM/dd");
    const d = days[day] || (days[day] = { count: 0, cancelled: 0, revenue: 0, "內用": 0, "外帶": 0, "宅配": 0 });
    d.count++;
    if (r[2] === "已取消") { d.cancelled++; return; }
    d.revenue += Number(r[10]) || 0;
    if (d[r[3]] != null) d[r[3]]++;
  });
  const out = Object.keys(days).sort().reverse().map((day) => {
    const d = days[day];
    const valid = d.count - d.cancelled;
    return [day, d.count, d.cancelled, d.revenue, d["內用"], d["外帶"], d["宅配"], valid ? Math.round(d.revenue / valid) : 0];
  });
  const sh = ss.getSheetByName(CONFIG.SHEETS.DAILY);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, DAILY_HEADERS.length).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, DAILY_HEADERS.length).setValues(out);
}

function installDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "updateDailySummary")
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("updateDailySummary").timeBased().everyDays(1).atHour(23).inTimezone(CONFIG.TIMEZONE).create();
  try { SpreadsheetApp.getUi().alert("已設定：每天晚上 23 點自動更新每日統計。"); } catch (e) { /* no UI */ }
}

/** 從選單建立一筆測試訂單，確認寫入流程正常 */
function createTestOrder() {
  const r = createOrder_({
    orderType: "外帶", name: "測試訂單", phone: "0900000000", note: "這是測試訂單，可刪除",
    items: [{ id: "p1", qty: 2 }, { id: "p7", qty: 1 }], source: "test",
    clientOrderId: "test-" + Date.now(),
  });
  try { SpreadsheetApp.getUi().alert("測試訂單已建立：" + r.orderId + "（NT$ " + r.total + "）"); } catch (e) { console.log(r); }
}

// ============================== 工具函式 ==============================
function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error("找不到試算表：請在試算表中開啟此指令碼並執行一次 setup()。");
  return active;
}

function parseBody_(e) {
  const raw = e && e.postData && e.postData.contents;
  if (!raw) throw userError_("INVALID", "沒有收到訂單資料。");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw userError_("INVALID", "訂單資料格式錯誤。");
  }
}

function userError_(code, message) {
  const err = new Error(message);
  err.userCode = code;
  return err;
}

function errorResult_(err) {
  if (err && err.userCode) return { ok: false, code: err.userCode, message: err.message };
  console.error(err);
  return { ok: false, code: "SERVER_ERROR", message: "系統暫時無法處理訂單，請稍後再試或直接致電門市。" };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function now_() {
  return new Date();
}
