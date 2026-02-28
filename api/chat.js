// Same Day Steamerz — TRUE LLM-FIRST (OPENAI PROMPT DRIVES 100% TEXT)
// - OpenAI generates the customer-facing reply (plain text) just like OpenAI Prompt tests.
// - Code only: channel plumbing (ManyChat/Web/Meta), state persistence, ZIP gate check, Zapier sends.
// - State is updated via a SECOND OpenAI "extractor" call (JSON mode) so the prompt stays natural.
//
// REQUIRED ENVs:
// - OPENAI_API_KEY (or OPENAI_KEY)
// Optional:
// - OPENAI_API_BASE (default https://api.openai.com/v1)
// - OPENAI_MODEL (default gpt-4.1)  <-- set this to EXACTLY what you use in OpenAI Prompt editor
// - OPENAI_TEMPERATURE (default 0.3)
// - OPENAI_TIMEOUT_MS (default 12000)
// Existing Meta envs supported:
// - PAGE_ACCESS_TOKEN / FB_PAGE_ACCESS_TOKEN
// - VERIFY_TOKEN / FB_VERIFY_TOKEN
// - APP_SECRET / FB_APP_SECRET
//
// ZIP gate uses ./zips.js (same as baseline). Fail-closed if missing.

const crypto = require("crypto");

/* ========================= ENV ========================= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const OPENAI_TEMPERATURE = Math.max(
  0,
  Math.min(1, parseFloat(process.env.OPENAI_TEMPERATURE || "0.3"))
);
const OPENAI_TIMEOUT_MS = Math.max(
  1500,
  parseInt(process.env.OPENAI_TIMEOUT_MS || "12000", 10) || 12000
);

const SESSION_TTL_MIN = Math.max(
  10,
  parseInt(process.env.SESSION_TTL_MIN || "240", 10) || 240
);

/* ========================= Meta Messenger Direct Support ========================= */
const FB_PAGE_ACCESS_TOKEN =
  process.env.PAGE_ACCESS_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN || "";

const FB_VERIFY_TOKEN =
  process.env.VERIFY_TOKEN || process.env.FB_VERIFY_TOKEN || "switchboard_verify_123";

const FB_APP_SECRET = process.env.APP_SECRET || process.env.FB_APP_SECRET || "";

// Optional: Vercel KV persistence. If not installed, falls back to in-memory.
let kv = null;
try {
  const vercelKv = require("@vercel/kv");
  kv = vercelKv?.kv || vercelKv;
} catch {
  kv = null;
}

const __memState = new Map();

async function getStateByPSID(psid) {
  const key = `sds:psid:${psid}`;
  if (kv && typeof kv.get === "function") {
    try {
      const raw = await kv.get(key);
      if (!raw) return null;
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return raw;
    } catch {
      return null;
    }
  }
  return __memState.get(key) || null;
}

async function setStateByPSID(psid, stateObj) {
  const key = `sds:psid:${psid}`;
  const safe =
    stateObj && typeof stateObj === "object" && !Array.isArray(stateObj)
      ? stateObj
      : {};
  if (kv && typeof kv.set === "function") {
    try {
      await kv.set(key, JSON.stringify(safe));
    } catch {
      /* ignore */
    }
    return;
  }
  __memState.set(key, safe);
}

function toFBQuickReplies(quickReplies) {
  if (!Array.isArray(quickReplies) || !quickReplies.length) return undefined;
  return quickReplies.slice(0, 13).map((q) => {
    const title = typeof q === "string" ? q : q?.title || q?.text || "";
    const payload = (
      typeof q === "string" ? q : q?.payload || title || ""
    ).toLowerCase();
    return {
      content_type: "text",
      title: String(title).slice(0, 20),
      payload: String(payload).slice(0, 1000),
    };
  });
}

async function fbSendText(psid, text, quickReplies) {
  if (!FB_PAGE_ACCESS_TOKEN) {
    console.error("Missing FB_PAGE_ACCESS_TOKEN.");
    return;
  }
  const _fetch = global.fetch || require("node-fetch");
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(
    FB_PAGE_ACCESS_TOKEN
  )}`;

  const msgObj = { text: String(text || "").trim() || " " };
  const qr = toFBQuickReplies(quickReplies);
  if (qr) msgObj.quick_replies = qr;

  try {
    await _fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_type: "RESPONSE",
        recipient: { id: psid },
        message: msgObj,
      }),
    });
  } catch (e) {
    console.error("fbSendText failed", e);
  }
}

function verifyFBSignature(req) {
  if (!FB_APP_SECRET) return true;

  const sig =
    req.headers?.["x-hub-signature-256"] || req.headers?.["X-Hub-Signature-256"];

  if (!sig || typeof sig !== "string") return true;

  try {
    const body = JSON.stringify(req.body || {});
    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", FB_APP_SECRET)
        .update(body)
        .digest("hex");
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return true;
  }
}

function extractMetaIncoming(evt) {
  const isGetStarted = evt?.postback?.payload === "GET_STARTED";
  if (isGetStarted) return { init: true, text: "" };

  const postbackPayload = evt?.postback?.payload;
  const postbackTitle = evt?.postback?.title;
  const quickPayload = evt?.message?.quick_reply?.payload;
  const txt = evt?.message?.text;

  const incoming = (postbackTitle || postbackPayload || quickPayload || txt || "").trim();
  return { init: false, text: incoming };
}

/* ========================= Utilities ========================= */
function encodeForm(data) {
  return Object.keys(data || {})
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? ""))
    .join("&");
}

const normalizeDigits = (s = "") => String(s || "").replace(/\D+/g, "");
function formatPhone(digits) {
  const d = normalizeDigits(digits);
  return d && d.length === 10
    ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
    : digits || "";
}

function extractTenDigit(text = "") {
  const d = normalizeDigits(text);
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return "";
}

function extractEmail(text = "") {
  const m = String(text || "").match(/[\w.\-+]+@[\w.\-]+\.\w{2,}/i);
  return m ? m[0].trim() : "";
}

function normalizeZip(input = "") {
  const m = String(input || "").match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

function clampHistory(arr, maxLen = 18) {
  const a = Array.isArray(arr) ? arr : [];
  if (a.length <= maxLen) return a;
  return a.slice(a.length - maxLen);
}

function isYes(text = "") {
  const t = String(text || "").trim().toLowerCase();
  return t === "yes" || t.startsWith("yes,") || t.startsWith("y ");
}
function isNo(text = "") {
  const t = String(text || "").trim().toLowerCase();
  return t === "no" || t.startsWith("no,") || t.startsWith("n ");
}

function looksLikeFullName(value = "") {
  const s = String(value || "").trim();
  if (!s) return false;
  if (s.length > 60) return false;
  if (/@|\d/.test(s)) return false;
  if (/^(yes|no|house|apartment|basic|deep|proceed|finalize|carpet|upholstery|ducts?)$/i.test(s))
    return false;
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  if (parts.some((p) => p.length < 2)) return false;
  return /^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)+$/.test(s);
}

function _parseUserDate(text = "") {
  const m = String(text || "").match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  const dd = parseInt(m[2], 10);
  if (!mm || !dd || mm > 12 || dd > 31) return null;
  let yy = m[3] ? parseInt(m[3], 10) : null;
  if (yy != null && yy < 100) yy += 2000;
  return { month: mm, day: dd, year: yy };
}

function _getTodayParts() {
  const tz = process.env.DATE_TZ || "America/New_York";
  return _getTZDateParts(tz);
}

function _isPastDate({ year, month, day }) {
  const today = _getTodayParts();
  const y = year ?? today.year;
  if (y < today.year) return true;
  if (y > today.year) return false;
  if (month < today.month) return true;
  if (month > today.month) return false;
  return day < today.day;
}

/* ========================= Robust input extraction ========================= */
function extractUserText(body = {}) {
  const candidates = [];
  const push = (v) => {
    if (typeof v === "string") {
      const s = v.trim();
      if (s) candidates.push(s);
    }
  };

  push(body.text);
  push(body.message);
  push(body.input);
  push(body.payload);
  push(body.content);
  push(body.question);
  push(body.prompt);
  push(body.user_message);
  push(body.userMessage);

  push(body?.message?.text);
  push(body?.data?.message);
  push(body?.data?.text);
  push(body?.event?.message?.text);
  push(body?.event?.text);
  push(body?.entry?.[0]?.messaging?.[0]?.message?.text);

  if (Array.isArray(body?.content?.messages)) {
    for (const m of body.content.messages) push(m?.text);
  }

  const deny = new Set([
    "state",
    "state_json",
    "channel",
    "source",
    "init",
    "verify_token",
    "hub.mode",
    "hub.challenge",
    "object",
    "entry",
  ]);
  for (const [k, v] of Object.entries(body || {})) {
    if (deny.has(k)) continue;
    if (typeof v === "string") push(v);
  }

  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || "";
}

/* ========================= ZIP Gate Data ========================= */
let validZipCodes = null;
try {
  validZipCodes = require("./zips.js").validZipCodes || null;
} catch {
  try {
    validZipCodes = require("../zips.js").validZipCodes || null;
  } catch {
    validZipCodes = null;
  }
}

const VALID_ZIP_SET = Array.isArray(validZipCodes)
  ? new Set(validZipCodes.map((z) => String(z || "").trim()).filter(Boolean))
  : null;

function zipInArea(zip) {
  const z = String(zip || "").trim();
  if (!z || z.length !== 5) return false;
  if (!VALID_ZIP_SET) return false; // fail-closed
  return VALID_ZIP_SET.has(z);
}

/* ========================= Session TTL ========================= */
function enforceSessionTTL(state) {
  const now = Date.now();
  const ttlMs = SESSION_TTL_MIN * 60 * 1000;

  const lastSeen = typeof state._lastSeen === "number" ? state._lastSeen : 0;
  if (lastSeen && now - lastSeen > ttlMs) {
    return { _lastSeen: now, _started: false, _history: [] };
  }
  state._lastSeen = now;
  return state;
}

/* ========================= ManyChat v2 formatter ========================= */
function toManyChatV2(payload) {
  if (payload && payload.version === "v2") return payload;

  const texts = [];
  if (typeof payload === "string") texts.push(payload);
  else if (payload && typeof payload.reply === "string") texts.push(payload.reply);
  else if (payload && typeof payload.text === "string") texts.push(payload.text);
  if (texts.length === 0) texts.push("");

  let qrs = [];
  if (payload && Array.isArray(payload.quickReplies)) {
    qrs = payload.quickReplies
      .map((q) => {
        if (typeof q === "string") return { type: "text", title: q, payload: q.toLowerCase() };
        if (q && typeof q === "object") {
          const title = q.title || q.text || String(q.label || "");
          const pl = q.payload || (title ? title.toLowerCase() : "");
          return { type: "text", title, payload: pl };
        }
        return null;
      })
      .filter(Boolean);
  }

  const messages = texts.map((t) => ({ type: "text", text: t }));
  const out = { version: "v2", content: { messages } };
  if (qrs.length) out.content.quick_replies = qrs;

  const st = payload && payload.state !== undefined ? payload.state : {};
  out.state = st;
  try {
    out.state_json = JSON.stringify(st);
  } catch {
    out.state_json = "{}";
  }
  out.reply_text = messages[0]?.text || "";
  return out;
}

/* ========================= Zapier ========================= */
const fetch = global.fetch || require("node-fetch");

const ZAPIER_BOOKING_URL = "https://hooks.zapier.com/hooks/catch/3165661/u13zg9e/"; // Booking Zap
const ZAPIER_SESSION_URL = "https://hooks.zapier.com/hooks/catch/3165661/u12ap8l/"; // Session/Partial Zap

async function sendBookingZapFormEncoded(payload) {
  try {
    await fetch(ZAPIER_BOOKING_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: encodeForm(payload),
    });
  } catch (err) {
    console.error("Booking Zap failed", err);
  }
}

async function sendSessionZapFormEncoded(payload) {
  try {
    if (!payload?.name2025 && !payload?.phone2025 && !payload?.email2025) return;
    await fetch(ZAPIER_SESSION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: encodeForm(payload),
    });
  } catch (err) {
    console.error("Session Zap failed", err);
  }
}

/* ===== ZAPIER FIX (ONLY): Robust field mapping + history fill for blanks (NAME FIX INCLUDED) ===== */
function _nonEmpty(v) {
  if (v == null) return false;
  if (typeof v === "number") return !Number.isNaN(v);
  const s = String(v).trim();
  return s.length > 0;
}
function _first(...vals) {
  for (const v of vals) if (_nonEmpty(v)) return v;
  return "";
}
function _toNumber(v) {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  const n = parseFloat(String(v || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function _deriveFromHistory(state = {}) {
  const hist = Array.isArray(state._history) ? state._history : [];
  if (!hist.length) return {};

  const text = hist
    .slice(-60)
    .map((m) => `${m.role || ""}: ${String(m.content || "")}`)
    .join("\n");

  const out = {};

  const looksLikeFullName = (v = "") => {
    const s = String(v || "").trim();
    if (!s) return false;
    if (s.length > 60) return false;
    if (/@|\d/.test(s)) return false;
    if (/^(yes|no|house|apartment|basic|deep|proceed|finalize|carpet|upholstery|ducts?)$/i.test(s))
      return false;
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return false;
    if (parts.some((p) => p.length < 2)) return false;
    return /^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)+$/.test(s);
  };

  const assistantAskedForName = (t = "") =>
    /\b(full\s+name|your\s+name|what(?:’|'|)s\s+your\s+name|name\?)\b/i.test(String(t || ""));

  const em = text.match(/[\w.\-+]+@[\w.\-]+\.\w{2,}/i);
  if (em) out.email = em[0].trim().toLowerCase();

  const ph = text.match(/\b(?:\+?1[\s\-\.]?)?(\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4})\b/);
  if (ph) {
    const d = extractTenDigit(ph[0]);
    if (d) out.phone = d;
  }

  const zip = text.match(/\b\d{5}\b/);
  if (zip) out.zip = zip[0];

  const nameLine = text.match(
    /\bname\s*[:\-]\s*([A-Za-z][A-Za-z.'-]+(?:\s+[A-Za-z][A-Za-z.'-]+)+)\b/i
  );
  if (nameLine && looksLikeFullName(nameLine[1])) {
    out.name = nameLine[1].trim();
  } else {
    for (let i = 0; i < hist.length - 1; i++) {
      const a = hist[i];
      const u = hist[i + 1];
      if (a?.role === "assistant" && u?.role === "user") {
        if (assistantAskedForName(a.content || "") && looksLikeFullName(u.content || "")) {
          out.name = String(u.content || "").trim();
        }
      }
    }
  }

  if (/(^|\b)8\s*(?:am)?\s*(?:-|to|–)\s*12\s*(?:pm)?(\b|$)/i.test(text)) out.window = "8 to 12";
  if (/(^|\b)1\s*(?:pm)?\s*(?:-|to|–)\s*5\s*(?:pm)?(\b|$)/i.test(text)) out.window = "1 to 5";

  if (/\bapartment\b/i.test(text)) out.building = "Apartment";
  if (/\bhouse\b/i.test(text)) out.building = "House";

  if (/\bno\s+pets?\b/i.test(text) || /\bpets?\s*[:\-]\s*no\b/i.test(text)) out.pets = "No";
  if (/\byes\b.*\bpets?\b/i.test(text) || /\bpets?\s*[:\-]\s*yes\b/i.test(text)) out.pets = "Yes";

  if (/\bno\b.*\boutdoor\s+water\b/i.test(text) || /\boutdoor\s+water\b.*\bno\b/i.test(text))
    out.outdoorWater = "No";
  if (
    /\boutdoor\s+water\b.*\b(yes|available|access)\b/i.test(text) ||
    /\bwater\s+spig(?:ot|got)\b/i.test(text)
  )
    out.outdoorWater = "Yes";

  const addr =
    text.match(/\b\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .,'-]*\s+(?:[A-Za-z .'-]+)\s+(?:GA|Georgia)\s+\d{5}\b/i) ||
    text.match(/\b\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .,'-]*,\s*[A-Za-z .'-]+,\s*(?:GA|Georgia)\s+\d{5}\b/i);
  if (addr) out.address = addr[0].trim();

  const dateLine = text.match(
    /(?:preferred\s*day|date|cleaning\s*date)\s*[:\-]?\s*([A-Za-z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i
  );
  if (dateLine) out.date = dateLine[1].trim();
  else {
    const md = text.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
    if (md) out.date = md[1].trim();
  }

  const notesLine = text.match(/\bnotes?\s*[:\-]\s*([^\n]{1,140})/i);
  if (notesLine) out.notes = notesLine[1].trim();

  const totals = [...text.matchAll(/\b(?:total|new\s+combined\s+total)\s*[:\-]?\s*\$?\s*(\d{2,5})\b/gi)];
  if (totals.length) out.total_price = _toNumber(totals[totals.length - 1][1]);

  const hasCarpet = /\bcarpet\b/i.test(text);
  const hasUph = /\bupholstery\b|\bcouch\b|\bsofa\b|\bloveseat\b|\bsectional\b/i.test(text);
  const hasDuct = /\bduct\b|\bair\s+duct\b|\bfurnace\b|\bdryer\s+vent\b/i.test(text);
  const svcs = [];
  if (hasCarpet) svcs.push("Carpet");
  if (hasUph) svcs.push("Upholstery");
  if (hasDuct) svcs.push("Air Duct");
  if (svcs.length) out.selected_service = svcs.join(" + ");

  const bd = [];
  if (hasCarpet) bd.push("Carpet cleaning");
  if (hasUph) bd.push("Upholstery cleaning");
  if (hasDuct) bd.push("Air duct cleaning");
  if (bd.length) out.Cleaning_Breakdown = bd.join(" + ");

  return out;
}

function buildZapPayloadFromState(state = {}) {
  const d = _deriveFromHistory(state);

  const name = _first(state.name, state.name2025, d.name);
  const phoneRaw = _first(state.phone, state.phone2025, d.phone);
  const phone = extractTenDigit(phoneRaw) || String(phoneRaw || "");
  const email = String(_first(state.email, state.email2025, d.email)).toLowerCase();

  const address = _first(state.address, state.Address, state.service_address, d.address);
  const date = _first(state.date, state.cleaningDate, state.CleaningDate, d.date);
  const window = _first(state.window, state.Window, state.arrival_window, state.arrivalWindow, d.window);

  const pets = _first(state.pets, state.Pets, d.pets);
  const outdoorWater = _first(state.outdoorWater, state.OutdoorWater, state.water, state.waterSupply, d.outdoorWater);
  const building = _first(state.building, state.BuildingType, state.buildingType, d.building);
  const notes = _first(state.notes, state.Notes, d.notes);

  const cleaningBreakdown = _first(
    state.Cleaning_Breakdown,
    state.cleaning_breakdown,
    state.breakdown,
    d.Cleaning_Breakdown
  );

  const selectedService = _first(
    state.selected_service,
    state.selectedService,
    state["selected service"],
    d.selected_service
  );

  const totalPrice = _toNumber(
    _first(state.total_price, state.totalPrice, state.total, state["Total Price"], d.total_price)
  );

  return {
    Cleaning_Breakdown: cleaningBreakdown || "",
    "selected service": selectedService || "",
    "Total Price": totalPrice || 0,
    name2025: name || "",
    phone2025: phone || "",
    email2025: email || "",
    Address: address || "",
    date: date || "",
    Window: window || "",
    pets: pets || "",
    OutdoorWater: outdoorWater || "",
    BuildingType: building || "",
    Notes: notes || "",
    booking_complete: !!state.booking_complete,
  };
}
/* ===== END ZAPIER FIX (ONLY) ===== */

/* ========================= QUICK REPLIES (FIX ONLY): deterministic + sanitize bad extractor buttons ========================= */
const QR_SERVICE = ["Carpet Cleaning", "Upholstery Cleaning", "Air Duct Cleaning"];
const QR_WINDOWS = ["8 to 12", "1 to 5"];
const QR_PETS = ["No pets", "Yes, pets"];
const QR_BUILDING = ["House", "Apartment"];
const QR_WATER = ["Yes", "No"];
const QR_NOTES = ["No notes, continue", "Yes, I have notes"];
const QR_FINAL_CONFIRM = ["No", "Yes", "Change information or value"];
const QR_DUCT_UPSELL = ["Yes, duct cleaning", "No thanks"];

const QR_DUCT_PKG = ["Basic", "Deep"];
const QR_YES_NO = ["Yes", "No"];
const QR_PROCEED = ["Yes", "No", "Change information or value"];
const QR_UPSELL_OFFER = ["Yes", "No", "Change information or value"];
const QR_FURNACE = ["Yes", "No"];
const QR_DRYER = ["Yes", "No"];

const QR_UPH_PIECES = ["Sofa", "Sectional", "Loveseat", "Recliner", "Ottoman", "Dining chairs", "Mattress"];
const QR_SEAT_COUNTS = ["2", "3", "4", "5", "6", "7"];
const QR_CARPET_AREAS = ["2 rooms", "3 rooms", "2 rooms, hallway", "3 rooms, hallway, stairs", "Other"];

function _pad2(n) {
  return String(n).padStart(2, "0");
}
function _getTZDateParts(timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const out = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
  };
}

function getNextDateQuickReplies(days = 6) {
  const out = [];
  const tz = process.env.DATE_TZ || "America/New_York";
  const { year, month, day } = _getTZDateParts(tz);
  const baseUtc = new Date(Date.UTC(year, month - 1, day));
  for (let i = 0; i < days; i++) {
    const d = new Date(baseUtc);
    d.setUTCDate(baseUtc.getUTCDate() + i);
    out.push(`${_pad2(d.getUTCMonth() + 1)}/${_pad2(d.getUTCDate())}`);
  }
  return out;
}

function _dedupeShort(qrs = []) {
  const seen = new Set();
  const out = [];
  for (const q of Array.isArray(qrs) ? qrs : []) {
    const s = String(q || "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function normalizeQuickRepliesForPrompt(replyText = "", existing = []) {
  const rt = String(replyText || "");
  const low = rt.toLowerCase();

  if (/\bzip\b/.test(low) && /zip code/.test(low)) return [];
  if (/what(?:'|\u2019)s your zip|zip code for|provide your zip/.test(low)) return [];
  if (/what(?:'|\u2019)s your full name|your full name|full name for the booking|what(?:'|\u2019)s your name|can i have your name/.test(low)) return [];
  if (/what(?:'|\u2019)s the address|service address|full address|address for the cleaning/.test(low)) return [];
  if (/phone number|best phone|reach you/.test(low)) return [];
  if (/email address|your email/.test(low)) return [];

  if (/what date would you like|what day would you like|schedule your cleaning|preferred day/.test(low)) {
    return getNextDateQuickReplies(6);
  }

  if (/finaliz/.test(low) && /\?$/.test(rt)) {
    return QR_FINAL_CONFIRM.slice();
  }

  if (
    (/arrival window|which.*window|works best/.test(low)) &&
    /8 to 12/.test(low) &&
    /1 to 5/.test(low) &&
    /\?$/.test(rt)
  ) {
    return QR_WINDOWS.slice();
  }

  if (/pets/.test(low) && (/any pets|do you have.*pets|pets in the home|pets we should know/.test(low))) {
    return QR_PETS.slice();
  }

  if (/house or apartment|is this a house|is it a house|apartment\?/.test(low)) {
    return QR_BUILDING.slice();
  }

  if (/outdoor water|outside water|water supply/.test(low)) {
    return QR_WATER.slice();
  }

  if (
    /special notes|special instructions|any notes|notes for the technician|instructions for our team/.test(low) ||
    /anything else we should note|note for your appointment|anything else we should know|anything else we should note for your appointment/.test(low)
  ) {
    return QR_NOTES.slice();
  }

  if ((/upholstery/.test(low) && /what .*pieces/.test(low)) || (/what upholstery/.test(low) && /cleaned/.test(low))) {
    return QR_UPH_PIECES.slice();
  }

  if (/how many .*?(seats|cushions)/.test(low) || /comfortably seat/.test(low)) {
    return QR_SEAT_COUNTS.slice();
  }

  if ((/\bproceed\b/.test(low) || /move forward/.test(low) || /bundle/.test(low)) && /\?$/.test(rt)) {
    return QR_PROCEED.slice();
  }

  if (
    /carpet/.test(low) &&
    (/\brooms?\b/.test(low) || /\bareas?\b/.test(low) || /\brugs?\b/.test(low) || /\bhallway/.test(low) || /\bstairs?/.test(low)) &&
    /\?$/.test(rt)
  ) {
    return QR_CARPET_AREAS.slice();
  }

  if (/would you like basic or deep/.test(low) || (/basic/.test(low) && /deep/.test(low) && /\?$/.test(rt) && /duct/.test(low))) {
    return QR_DUCT_PKG.slice();
  }

  if (/furnace cleaning/.test(low) && /\$/.test(rt) && /\?$/.test(rt)) return QR_FURNACE.slice();
  if (/dryer vent/.test(low) && /\$/.test(rt) && /\?$/.test(rt)) return QR_DRYER.slice();

  if (
    (/would you like me to quote/.test(low) || /would you like to add/.test(low) || /before we move forward/.test(low)) &&
    (/\bcarpet\b/.test(low) || /\bupholstery\b/.test(low)) &&
    /\?$/.test(rt)
  ) {
    return QR_UPSELL_OFFER.slice();
  }

  if (/before you go/.test(low) && /duct/.test(low)) {
    return QR_DUCT_UPSELL.slice();
  }

  const cleaned = _dedupeShort(existing);

  const filtered = cleaned.filter((q) => {
    const s = String(q || "").trim();
    if (!s) return false;
    if (s.toLowerCase() === rt.trim().toLowerCase()) return false;
    if (s.length > 28) return false;
    if (/\?$/.test(s)) return false;
    if (s.split(/\s+/).length > 5) return false;
    return true;
  });

  return filtered;
}
/* ========================= END QUICK REPLIES FIX ONLY ========================= */

/* ========================= OPENAI: MASTER PROMPT (PASTE YOUR OPENAI PROMPT HERE) ========================= */
const SDS_MASTER_PROMPT_TEXT = `
PROMPT NAME:
SDS_OPENAI_CHAT_MASTER_BASELINE_NUMERIC_SPECIALS_UPSELL_v10

ROLE & IDENTITY
You are Agent 995 for Same Day Steamerz.
You are a calm, confident, professional booking and sales agent.
Your job is to complete full bookings end-to-end while maximizing revenue.

================================================
ABSOLUTE OUTPUT RULES (LOCKED)
================================================
- ALL prices must be displayed in NUMBERS only (examples: $100, $150, $250, $500).
- NEVER write prices in words.
- NEVER explain pricing math or how prices are calculated.
- NEVER mention internal rules (per room, per area, charged areas, free hallway, minimum adjustments, etc.).
- Ask ONLY ONE question per message.
- NEVER repeat a question if the customer already provided the required information.
- Keep responses short, confident, and booking-focused.
- No emojis, EXCEPT inside the duct package display block (that block must be used exactly as written).

================================================
START MESSAGE (LOCKED)
================================================
Begin with:
“Good morning. What do you need cleaned today: carpet, upholstery, or air ducts?”

================================================
NON-SALES HARD STOP (LOCKED)
================================================
If the customer mentions ANY of the following:
- reschedule / rescheduling
- cancel / canceling
- complaint / refund / damage / follow-up
- “I already had service”
- “last job”

Immediately stop sales flow and say exactly:
“This is our sales and booking line.

For rescheduling, service issues, or anything related to a past appointment,
you’ll need to contact our dispatcher directly at 678-929-8202.

What I can do is take your name, your phone number,
and a brief note about what you’re calling about,
and I’ll send that information over to our dispatcher as well.

You may get a quicker response by calling them directly,
but I’m happy to pass the information along for you.”

Then collect ONLY (one question per message):
1) Name
2) Phone
3) Reason
Then end professionally.

================================================
SERVICE AREA ZIP VERIFICATION (LOCKED)
================================================
You must verify ZIP before collecting address/name/phone/email/date/window/pets/etc.

Ask ZIP ONLY after:
- customer agrees to move forward
AND
- pre-ZIP upsell (if applicable) has been offered once and resolved

Ask:
“Before we lock this in, what’s the ZIP code for the service location?”

If ZIP is outside service area:
“Thanks. That ZIP looks outside our normal service area. We can check if we can travel to your area or if a partner can help. A team member will reach back out to you shortly.”

Then collect ONLY:
- Name
- Phone
Stop the booking flow.

================================================
CARPET CLEANING (CONVERSION FIRST)
================================================

CARPET INPUT DETECTION (LOCKED)
If the customer message already includes carpet areas (example: “3 rooms and a hallway”, “2 rooms”, “6 rooms and stairs”, etc.),
DO NOT ask what areas again.
Instead, calculate and quote immediately.

Only ask:
“What carpet areas do you want cleaned? You can type it like: 3 rooms, hallway, stairs, 1 rug.”
IF the customer has NOT provided enough information.

COUNTING (INTERNAL ONLY — DO NOT EXPLAIN)
- Rooms count as 1 area each.
- Rugs count as 1 area each.
- Hallway counts as 1 area ONLY if explicitly mentioned.
- Stairs count as 1 area per FULL FLIGHT (see stair rule below).

STAIR CLARIFICATION RULE (LOCKED)
- If customer mentions “stairs” but does NOT specify flights:
  Ask: “How many full flights of stairs are there?”
- If customer provides number of steps:
  Ask: “How many full flights of stairs does that include?”
Do NOT convert steps into flights automatically.
Do NOT explain stair definitions.

CARPET PRICING (LOCKED — INTERNAL ONLY)
- Standard: $50 per charged area
- Minimum: $100
- SPECIALS (based on TOTAL AREAS MENTIONED before any hallway adjustment):
  - Exactly 2 total areas mentioned → $100
  - Exactly 6 total areas mentioned → $200
- Hallway rule (internal): If hallway mentioned AND total areas mentioned are 4 or more, the first hallway is not charged.

CARPET PRICE DELIVERY (LOCKED)
“Your total for that carpet cleaning is $___.”
Then ask:
“Would you like to move forward?”

================================================
UPHOLSTERY CLEANING (ORDER + PRICING FIXED)
================================================

UPHOLSTERY FIRST QUESTION (LOCKED)
When customer selects upholstery (or asks about upholstery), you must ask:
“What upholstery pieces do you need cleaned? (Example: sectional, sofa, couch, loveseat, dining chairs, recliner, ottoman, mattress)”
Do NOT jump straight to seat count until you know what piece(s) they have.

SEATING PIECES RULE (LOCKED)
If the customer mentions ANY of these:
- sofa
- couch
- loveseat
- sectional
Ask:
“How many people can it comfortably seat?”

SEATING PRICING (LOCKED)
- $50 per seat
- Minimum $150 for seat count 1–3
- Minimum $250 when seat count is 4+ OR when customer says “sectional”
Pricing logic:
- If seat count is 1–3: price is max($150, seats x $50)
- If seat count is 4+ OR “sectional”: price is max($250, seats x $50)

OTHER UPHOLSTERY PRICING (LOCKED)
- Dining chair: $25 each
- Recliner: $80
- Ottoman: $50
- Mattress: $150

CHAIR CLARIFICATION (LOCKED)
If the customer says “chairs” without specifying dining vs single-seat:
Ask exactly:
“Just to confirm, are these dining room chairs, or single seated chairs like a recliner or accent chair?”
Then price:
- Dining chair: $25 each
- Single seated chair (non-recliner): $50 each

UPHOLSTERY MINIMUMS (LOCKED)
- Standalone upholstery minimum is $100.
  If the subtotal of requested upholstery items is under $100, the upholstery total becomes $100.
- If a seating piece (sofa/couch/loveseat/sectional) is booked, use the seating minimum rules above (minimum $150 or $250 as applicable).

UPHOLSTERY DELIVERY (LOCKED)
“Your total for upholstery cleaning is $___.”
Then ask:
“Would you like to move forward?”

ITEMIZED QUOTES (ALLOWED ONLY WHEN ASKED)
If the customer explicitly asks for an itemized quote for their specific job, you may list ONLY the items they requested and then the final total.
Do NOT generate a full catalog/menu.
Do NOT explain math.

================================================
AIR DUCT CLEANING (DISPLAY + ORDER LOCKED)
================================================

DUCT FIRST QUESTION (LOCKED)
If customer selects air duct cleaning, your next question must be:
“How many HVAC systems (AC units) do you have?”
Never ask “how many vents”.

DUCT PACKAGE DISPLAY (LOCKED — USE THIS EXACT COPY)
Whenever you present Basic vs Deep (either right after they answer systems OR when they ask “what’s the difference?”),
you MUST display it exactly like this:

💨 Duct Cleaning Options

✅ Basic Duct Cleaning

This is ideal if your ducts have been cleaned within the last 1–2 years.

Includes all supply vents  
High-powered vacuum extraction  
Removes normal dust and debris buildup  
Does not include return vents  
No system sanitizing  
This is maintenance cleaning.


---

🔥 Deep Duct Cleaning

This is a full system restoration service.

Includes all supply vents  
Includes all return vents  
Agitation + negative air extraction  
Full system sanitizing treatment  
Cleans deeper buildup, pet dander, odors, and contaminants  

This is recommended if:

It’s been more than 2 years  
You’ve never had it cleaned  
You have pets, allergies, or noticeable dust issues

Then ask ONLY ONE question:
“Would you like Basic or Deep?”

DUCT PRICING (LOCKED)
Only AFTER they choose Basic or Deep:
- Basic: $200 per system
- Deep: $500 per system

Then offer add-ons one at a time:

1) Furnace add-on:
- Basic: $200 per system
- Deep: $100 per system
Ask:
“Would you like to add furnace cleaning?”

2) Dryer vent add-on:
- $200
Ask:
“Would you like to add dryer vent cleaning?”

DUCT TOTAL DELIVERY (LOCKED)
“Your total for air duct cleaning is $___.”
Then ask:
“Would you like to move forward?”

================================================
COMBINATION JOBS — DUCT + CARPET (LOCKED)
================================================
If BOTH air duct cleaning and carpet cleaning are booked:
- These are two separate work orders.
- They may be handled by different technicians.
- Duct cleaning is scheduled first.
- Carpet cleaning is scheduled after.
- Do NOT promise the same arrival window for both.
Say:
“These are scheduled as separate work orders with different technicians, so the dispatcher will confirm the exact timing for each service.”

================================================
UPSELL SEQUENCING (LOCKED)
================================================

PRE-ZIP UPSELL RULE (LOCKED — MUST HAPPEN)
After the customer says YES to moving forward on a CARPET quote or UPHOLSTERY quote,
you MUST offer the cross-sell ONCE before asking for ZIP.

- If CARPET is being booked:
  “Before we move forward, if you bundle upholstery with carpet today, you qualify for $50 off the combined total. Would you like to add upholstery cleaning?”
- If UPHOLSTERY is being booked:
  “Before we move forward, would you like me to quote carpet cleaning as well?”

If they decline, proceed to ZIP.
If they accept, gather needed details, quote updated total, then proceed to ZIP.

DUCT EXCEPTION (LOCKED)
If the customer is booking AIR DUCT CLEANING only,
do NOT upsell before ZIP.
Any upsell for duct-only happens only after booking is completed.

================================================
BUNDLE DISCOUNT + PROFIT PROTECTION (LOCKED)
================================================
Bundle discount applies ONLY when BOTH carpet + upholstery are booked in the same conversation:
- Bundle discount: -$50

PROFIT PROTECTION RULE (LOCKED)
If carpet + upholstery bundle is active and the upholstery subtotal is under $100,
treat the upholstery subtotal as $100 BEFORE applying the -$50 bundle discount.
Never mention this adjustment.

When presenting bundle totals, show only:
“Bundle discount: -$50”
“New combined total: $___”
Never explain calculation.

================================================
BOOKING QUESTION ORDER (LOCKED — ONE QUESTION PER MESSAGE)
================================================
After ZIP is confirmed in-area and customer is proceeding, collect in this exact order:

1) Address
2) Name
3) Phone number
4) Email
5) Preferred date
6) Arrival window
7) Pets
8) House or apartment
9) Floor (if apartment)
10) Outdoor water supply
11) Notes for the technician

ARRIVAL WINDOWS (LOCKED — ONLY TWO OPTIONS)
Offer ONLY:
- 8 to 12
- 1 to 5

Ask:
“Which arrival window works best: 8 to 12 or 1 to 5?”

OUTDOOR WATER SUPPLY (LOCKED)
Ask:
“Do you have an outdoor water supply, like a water spigot we can connect a garden hose to if needed?”

APARTMENT ABOVE 3RD FLOOR POLICY (LOCKED)
If apartment and floor is above 3:
“Since it’s above the 3rd floor, this will require a portable unit because we have to run hoses from our truck. We’ll have someone who handles the portables get in touch with you to book an appointment.”

================================================
FINAL CONFIRMATION (LOCKED)
================================================
Provide a clean summary including:
- Services
- Address
- Name
- Phone
- Email
- Date
- Arrival window
- Property type
- Pets
- Outdoor water supply
- Total: $___

Then ask:
“Is there anything you’d like to change before I finalize this?”

If customer says NO, finalize and include:
“If you have any questions or need changes, you can reach our dispatcher at 678-929-8202.”

================================================
POST-BOOKING UPSELL (LOCKED)
================================================
After final confirmation:

- If the customer booked carpet or upholstery:
  Offer duct once:
  “Before you go, we also provide air duct cleaning. Would you like a quote?”

- If the customer booked duct:
  Offer carpet/upholstery once:
  “Before you go, we also provide carpet and upholstery cleaning. Would you like a quote for either of those?”
`.trim();

/* ========================= OPENAI: Extractor Prompt (JSON MODE) ========================= */
const SDS_EXTRACTOR_PROMPT = `
You extract structured booking data from a conversation for Same Day Steamerz.

Return a SINGLE JSON object ONLY with:
{
  "state_update": { ... },
  "quick_replies": ["optional strings"]
}

Rules:
- Keep previously known values from CURRENT_STATE unless new info replaces them.
- Normalize:
  - zip: 5-digit string
  - phone: 10-digit string
  - email: lowercase email
  - window: exactly "8 to 12" or "1 to 5"
- booking_complete: true ONLY when the appointment is confirmed/finalized.
- total_price: number (no $ sign)
- selected_service: "Carpet" or "Upholstery" or "Air Duct" or combinations like "Carpet + Upholstery"
- Cleaning_Breakdown: short text summary of services and counts for Zapier.
- post_booking_duct_upsell_done: boolean (set true if an after-finalization duct upsell was already offered)
- If you are unsure of a field, do not guess—leave it unchanged.
`.trim();

/* ========================= OPENAI Call Helpers ========================= */
function safeJsonExtract(text = "") {
  const s = String(text || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* continue */
  }

  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const slice = s.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function openaiChat(messages, { jsonMode = false, maxTokens = 450 } = {}) {
  if (!OPENAI_API_KEY) throw new Error("Missing OpenAI API key.");

  const _fetch = global.fetch || require("node-fetch");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  const payload = {
    model: OPENAI_MODEL,
    temperature: OPENAI_TEMPERATURE,
    max_tokens: maxTokens,
    messages,
  };

  if (jsonMode) payload.response_format = { type: "json_object" };

  try {
    const resp = await _fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await resp.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content || "";
    return String(content || "").trim();
  } finally {
    clearTimeout(timeout);
  }
}

/* ========================= State hydration from raw user text (quiet) ========================= */
function hydrateStateFromUserText(userText, state) {
  const txt = String(userText || "");

  if (!state.email) {
    const em = extractEmail(txt);
    if (em) state.email = em.toLowerCase();
  }
  if (!state.phone) {
    const p = extractTenDigit(txt);
    if (p) state.phone = p;
  }
  if (!state.zip) {
    const z = normalizeZip(txt);
    if (z) state.zip = z;
  }
  return state;
}

function computeZipHint(state, userText) {
  const z = normalizeZip(userText) || state.zip || "";
  if (!z) return { zip: "", in_area: null };
  const inArea = zipInArea(z);
  return { zip: z, in_area: inArea };
}

/* ========================= LLM-FIRST Turn ========================= */
async function llmTurn(userText, state) {
  const s = state && typeof state === "object" ? state : {};
  s._history = clampHistory(s._history, 18);

  hydrateStateFromUserText(userText, s);

  const zipHint = computeZipHint(s, userText);

  const msgs = [];
  msgs.push({ role: "system", content: SDS_MASTER_PROMPT_TEXT });

  const stateSnapshot = (() => {
    const copy = { ...s };
    delete copy._history;
    return copy;
  })();
  msgs.push({ role: "system", content: `CURRENT_STATE: ${JSON.stringify(stateSnapshot)}` });
  msgs.push({ role: "system", content: `ZIP_CHECK: ${JSON.stringify(zipHint)}` });

  if (s._reuse_prev_info) {
    msgs.push({
      role: "system",
      content:
        "NOTE: Customer confirmed the same location and contact info as their previous booking. Do NOT ask for address, name, phone, or email again. Ask ONLY for date, arrival window, and notes. Do NOT ask about pets/house/outdoor water. In the final summary, show the full address (never 'same as previous').",
    });
  }
  if (s._second_work_order_active) {
    msgs.push({
      role: "system",
      content:
        "NOTE: This is a NEW, separate work order for Air Duct Cleaning. Do NOT reference the previous carpet/upholstery booking. Provide a FULL booking summary with Service, Address, Name, Phone, Email, Date, Arrival Window, Pets, House/Apartment, Floor (if apartment), Outdoor Water, Notes, and Total. The customer name must be the customer’s actual name (never use service/package names like Basic/Deep as a name). Then ask: “Is there anything you’d like to change before I finalize this?”",
    });
  }

  for (const m of s._history) {
    if (m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
      msgs.push({ role: m.role, content: m.content });
    }
  }

  msgs.push({ role: "user", content: String(userText || "").trim() });

  const assistantReply = await openaiChat(msgs, { jsonMode: false, maxTokens: 550 });

  s._history.push({ role: "user", content: String(userText || "").trim() });
  s._history.push({ role: "assistant", content: String(assistantReply || "").trim() });
  s._history = clampHistory(s._history, 18);

  const extractorMsgs = [
    { role: "system", content: SDS_EXTRACTOR_PROMPT },
    { role: "system", content: `CURRENT_STATE: ${JSON.stringify(stateSnapshot)}` },
    { role: "system", content: `ZIP_CHECK: ${JSON.stringify(zipHint)}` },
    { role: "user", content: `USER: ${String(userText || "").trim()}\nASSISTANT: ${String(assistantReply || "").trim()}` },
  ];

  let extracted = null;
  try {
    const extractorOut = await openaiChat(extractorMsgs, { jsonMode: true, maxTokens: 450 });
    extracted = safeJsonExtract(extractorOut);
  } catch {
    extracted = null;
  }

  const stateUpdate =
    extracted && extracted.state_update && typeof extracted.state_update === "object" && !Array.isArray(extracted.state_update)
      ? extracted.state_update
      : {};

  const extractorQuickReplies = Array.isArray(extracted?.quick_replies) ? extracted.quick_replies : [];

  Object.assign(s, stateUpdate);

  if (typeof s.email === "string") s.email = s.email.toLowerCase();
  if (typeof s.phone === "string") {
    const p = extractTenDigit(s.phone);
    if (p) s.phone = p;
  }
  if (typeof s.zip === "string") {
    const z = normalizeZip(s.zip);
    if (z) s.zip = z;
  }

  if (s._second_work_order_active && s._reuse_prev_info && s._prev_contact) {
    if (s._prev_contact.name) s.name = s._prev_contact.name;
    if (s._prev_contact.phone) s.phone = s._prev_contact.phone;
    if (s._prev_contact.email) s.email = s._prev_contact.email;
    if (s._prev_contact.address) s.address = s._prev_contact.address;
  } else if (s._second_work_order_active && s.name && !looksLikeFullName(s.name)) {
    delete s.name;
  }

  const normalizedQrs = normalizeQuickRepliesForPrompt(assistantReply, extractorQuickReplies);

  return { reply: assistantReply || "How can I help?", quickReplies: normalizedQrs, state: s };
}

/* ========================= CORE POST HANDLER ========================= */
async function handleCorePOST(req, res) {
  try {
    const body = req.body || {};
    let user = extractUserText(body);

    let state = body.state ?? {};
    if (typeof state === "string") {
      try {
        state = JSON.parse(state);
      } catch {
        state = {};
      }
    }

    if (
      (!state || typeof state !== "object" || Array.isArray(state) || !Object.keys(state).length) &&
      typeof body.state_json === "string" &&
      body.state_json.trim()
    ) {
      try {
        state = JSON.parse(body.state_json) || {};
      } catch {
        state = {};
      }
    }

    if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
    state = enforceSessionTTL(state);
    if (!Array.isArray(state._history)) state._history = [];

    const fromManyChat = body.channel === "messenger" || body.source === "manychat";
    const originalJson = res.json.bind(res);

    res.json = (data) => {
      let out = data == null ? {} : typeof data === "string" ? { reply: data } : { ...data };
      if (out.state === undefined) out.state = state;

      const v2 = toManyChatV2(out);
      if (fromManyChat) return originalJson(v2);

      out.state_json = v2.state_json;
      out.reply_text = v2.reply_text || (typeof out.reply === "string" ? out.reply : "");
      return originalJson(out);
    };

    if (body.init || (!user && !state._started)) {
      state._started = true;
      const initTurn = await llmTurn("hello", state);
      state = initTurn.state || state;

      const qrs = initTurn.quickReplies && initTurn.quickReplies.length ? initTurn.quickReplies : QR_SERVICE;

      return res.status(200).json({
        reply: initTurn.reply,
        quickReplies: qrs,
        state,
      });
    }

    if (!user) {
      const emptyTurn = await llmTurn("hello", state);
      state = emptyTurn.state || state;
      return res.status(200).json({
        reply: emptyTurn.reply,
        quickReplies: emptyTurn.quickReplies,
        state,
      });
    }

    const parsedDate = _parseUserDate(user);
    if (parsedDate && _isPastDate(parsedDate)) {
      return res.status(200).json({
        reply: "That date has already passed. What date would you like to schedule?",
        quickReplies: getNextDateQuickReplies(6),
        state,
      });
    }

    if (state._post_booking_duct_upsell_pending && user) {
      if (isYes(user)) {
        state._post_booking_duct_upsell_pending = false;
        state._second_work_order_active = true;
        state._second_bookingSent = false;
        state._post_booking_same_location_pending = true;
        return res.status(200).json({
          reply: "Is everything the same location?",
          quickReplies: QR_YES_NO,
          state,
        });
      }
      if (isNo(user)) {
        state._post_booking_duct_upsell_pending = false;
      }
    }

    if (state._post_booking_same_location_pending && user) {
      state._post_booking_same_location_pending = false;
      if (isYes(user)) {
        state._prev_contact = {
          name: state.name || "",
          phone: state.phone || "",
          email: state.email || "",
          address: state.address || state.Address || state.service_address || "",
        };
        state._reuse_prev_info = true;
        state.booking_complete = false;
        state.total_price = 0;
        state.selected_service = "Air Duct";
        state.Cleaning_Breakdown = "Air duct cleaning";
        delete state.date;
        delete state.cleaningDate;
        delete state.CleaningDate;
        delete state.window;
        delete state.Window;
        delete state.arrival_window;
        delete state.arrivalWindow;
        delete state.notes;
        delete state.Notes;
        user =
          "Customer accepted air duct cleaning add-on. Start a NEW duct cleaning booking now. The location and contact info are the SAME as the previous booking.";
      } else if (isNo(user)) {
        state._reuse_prev_info = false;
        state.booking_complete = false;
        state.total_price = 0;
        state.selected_service = "Air Duct";
        state.Cleaning_Breakdown = "Air duct cleaning";
        delete state.name;
        delete state.name2025;
        delete state.phone;
        delete state.phone2025;
        delete state.email;
        delete state.email2025;
        delete state.address;
        delete state.Address;
        delete state.service_address;
        delete state.date;
        delete state.cleaningDate;
        delete state.CleaningDate;
        delete state.window;
        delete state.Window;
        delete state.arrival_window;
        delete state.arrivalWindow;
        delete state.pets;
        delete state.Pets;
        delete state.building;
        delete state.BuildingType;
        delete state.buildingType;
        delete state.outdoorWater;
        delete state.OutdoorWater;
        delete state.water;
        delete state.waterSupply;
        delete state.notes;
        delete state.Notes;
        user =
          "Customer accepted air duct cleaning add-on. Start a NEW duct cleaning booking now. The location and contact info are DIFFERENT for this booking.";
      }
    }

    // Main turn
    const result = await llmTurn(user, state);
    const nextState = result.state || state;

    // ===== ONLY CHANGE: Apartment above 3rd floor portable unit message + stop =====
    const buildingVal = String(nextState.building || nextState.BuildingType || nextState.buildingType || "");
    const floorRaw = nextState.floor ?? nextState.Floor ?? "";
    const floorMatch = String(floorRaw || "").match(/\d+/);
    const floorNum = floorMatch ? parseInt(floorMatch[0], 10) : NaN;

    const needsPortable =
      /apartment/i.test(buildingVal) &&
      Number.isFinite(floorNum) &&
      floorNum > 3;

    let portableOverrideReply = null;

    if (needsPortable) {
      nextState.portable_required = true;
      nextState.booking_complete = false;

      if (!nextState._portableNotified) {
        nextState._portableNotified = true;
        portableOverrideReply =
          "Since it’s above the 3rd floor, this will require a portable unit because we have to run hoses from our truck. We’ll have someone who handles the portables get in touch with you to book an appointment.";
      }
    }
    // ===== END ONLY CHANGE =====

    const bookingComplete = !!nextState.booking_complete;

    if (nextState.name && nextState.phone && !nextState._sessionSent) {
      try {
        const payload = buildZapPayloadFromState({ ...nextState, booking_complete: false });
        await sendSessionZapFormEncoded(payload);
        nextState._sessionSent = true;
      } catch (e) {
        console.error("Session Zap send failed", e);
      }
    }

    if (bookingComplete && !nextState._bookingSent) {
      try {
        const payload = buildZapPayloadFromState({ ...nextState, booking_complete: true });
        await sendBookingZapFormEncoded(payload);
        nextState._bookingSent = true;
      } catch (e) {
        console.error("Booking Zap send failed", e);
      }
    }

    let finalReply = result.reply;
    let finalQuickReplies = Array.isArray(result.quickReplies) ? result.quickReplies : [];

    const svc = String(nextState.selected_service || nextState.selectedService || nextState["selected service"] || "");
    const bd = String(nextState.Cleaning_Breakdown || nextState.cleaning_breakdown || nextState.breakdown || "");
    const ductAlready = /duct/i.test(svc) || /duct/i.test(bd);

    const looksFinalized =
      /finaliz/i.test(finalReply || "") ||
      /dispatcher/i.test(finalReply || "") ||
      /678-929-8202/.test(finalReply || "");

    const upsellDone = !!nextState.post_booking_duct_upsell_done;

    if (bookingComplete && looksFinalized && !ductAlready && !upsellDone) {
      finalReply =
        String(finalReply || "").trim() + "\n\nBefore you go — would you like to add air duct cleaning as well?";
      finalQuickReplies = QR_DUCT_UPSELL.slice();
      nextState.post_booking_duct_upsell_done = true;
      nextState._post_booking_duct_upsell_pending = true;
    }

    if (
      nextState._second_work_order_active &&
      (nextState.booking_complete || looksFinalized) &&
      !nextState._second_bookingSent
    ) {
      try {
        const payload = buildZapPayloadFromState({ ...nextState, booking_complete: true });
        await sendBookingZapFormEncoded(payload);
        nextState._second_bookingSent = true;
        nextState._second_work_order_active = false;
      } catch (e) {
        console.error("Second Booking Zap send failed", e);
      }
    }

    // Portable override LAST
    if (portableOverrideReply) {
      finalReply = portableOverrideReply;
      finalQuickReplies = [];
    }

    finalQuickReplies = normalizeQuickRepliesForPrompt(finalReply, finalQuickReplies);

    return res.status(200).json({
      reply: finalReply,
      quickReplies: finalQuickReplies,
      state: nextState,
    });
  } catch (err) {
    console.error("chat.js error", err);
    return res.status(200).json({
      reply:
        "Sorry — something glitched on my end, but I’m still here. Tell me what you need cleaned: carpet, upholstery, or air ducts.",
      state: { _started: true, _lastSeen: Date.now(), _history: [] },
      error: String((err && err.message) || err),
    });
  }
}

/* ========================= MAIN EXPORT ========================= */
module.exports = async (req, res) => {
  // Meta verify (GET)
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];

    if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};

  // Direct Meta webhook branch
  if (body && body.object === "page" && Array.isArray(body.entry)) {
    if (!verifyFBSignature(req)) return res.sendStatus(403);

    for (const entry of body.entry) {
      const events = entry.messaging || [];
      for (const evt of events) {
        if (evt.delivery || evt.read) continue;
        if (evt.message && evt.message.is_echo) continue;

        const psid = evt?.sender?.id;
        if (!psid) continue;

        const incoming = extractMetaIncoming(evt);
        let storedState = (await getStateByPSID(psid)) || {};
        if (!Array.isArray(storedState._history)) storedState._history = [];

        let captured = null;

        const fakeReq = {
          method: "POST",
          headers: {},
          query: {},
          body: incoming.init
            ? { init: true, state: storedState, source: "meta" }
            : { text: incoming.text, state: storedState, source: "meta" },
        };

        const fakeRes = {
          _status: 200,
          status(code) {
            this._status = code;
            return this;
          },
          json(obj) {
            captured = obj;
            return obj;
          },
          send(str) {
            captured = { reply: String(str || ""), state: storedState };
            return captured;
          },
          sendStatus(code) {
            this._status = code;
            captured = null;
            return null;
          },
        };

        await handleCorePOST(fakeReq, fakeRes);

        const nextState =
          captured && captured.state && typeof captured.state === "object" ? captured.state : storedState;
        await setStateByPSID(psid, nextState);

        const replyText =
          captured && (captured.reply_text || captured.reply)
            ? String(captured.reply_text || captured.reply)
            : "";

        const quickReplies = captured?.quickReplies;
        await fbSendText(psid, replyText || "How can we help?", quickReplies);
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  }

  // ManyChat + Web branch
  return handleCorePOST(req, res);
};
