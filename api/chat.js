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
const OPENAI_TIMEOUT_MS = Math.max(1500, parseInt(process.env.OPENAI_TIMEOUT_MS || "12000", 10) || 12000);

const SESSION_TTL_MIN = Math.max(10, parseInt(process.env.SESSION_TTL_MIN || "240", 10) || 240);

/* ========================= Meta Messenger Direct Support ========================= */
const FB_PAGE_ACCESS_TOKEN =
  process.env.PAGE_ACCESS_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN || "";

const FB_VERIFY_TOKEN =
  process.env.VERIFY_TOKEN || process.env.FB_VERIFY_TOKEN || "switchboard_verify_123";

const FB_APP_SECRET =
  process.env.APP_SECRET || process.env.FB_APP_SECRET || "";

// Optional: Vercel KV persistence. If not installed, falls back to in-memory.
let kv = null;
try {
  const vercelKv = require("@vercel/kv");
  kv = vercelKv?.kv || vercelKv;
} catch { kv = null; }

const __memState = new Map();

async function getStateByPSID(psid) {
  const key = `sds:psid:${psid}`;
  if (kv && typeof kv.get === "function") {
    try {
      const raw = await kv.get(key);
      if (!raw) return null;
      if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    } catch { return null; }
  }
  return __memState.get(key) || null;
}

async function setStateByPSID(psid, stateObj) {
  const key = `sds:psid:${psid}`;
  const safe = (stateObj && typeof stateObj === "object" && !Array.isArray(stateObj)) ? stateObj : {};
  if (kv && typeof kv.set === "function") {
    try { await kv.set(key, JSON.stringify(safe)); } catch { /* ignore */ }
    return;
  }
  __memState.set(key, safe);
}

function toFBQuickReplies(quickReplies) {
  if (!Array.isArray(quickReplies) || !quickReplies.length) return undefined;
  return quickReplies.slice(0, 13).map(q => {
    const title = typeof q === "string" ? q : (q?.title || q?.text || "");
    const payload = (typeof q === "string" ? q : (q?.payload || title || "")).toLowerCase();
    return {
      content_type: "text",
      title: String(title).slice(0, 20),
      payload: String(payload).slice(0, 1000)
    };
  });
}

async function fbSendText(psid, text, quickReplies) {
  if (!FB_PAGE_ACCESS_TOKEN) {
    console.error("Missing FB_PAGE_ACCESS_TOKEN.");
    return;
  }
  const _fetch = global.fetch || require("node-fetch");
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(FB_PAGE_ACCESS_TOKEN)}`;

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
        message: msgObj
      })
    });
  } catch (e) {
    console.error("fbSendText failed", e);
  }
}

function verifyFBSignature(req) {
  if (!FB_APP_SECRET) return true;

  const sig =
    req.headers?.["x-hub-signature-256"] ||
    req.headers?.["X-Hub-Signature-256"];

  if (!sig || typeof sig !== "string") return true;

  try {
    const body = JSON.stringify(req.body || {});
    const expected = "sha256=" + crypto.createHmac("sha256", FB_APP_SECRET).update(body).digest("hex");
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
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? ""))
    .join("&");
}

const normalizeDigits = (s = "") => String(s || "").replace(/\D+/g, "");
function formatPhone(digits) {
  const d = normalizeDigits(digits);
  return (d && d.length === 10)
    ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
    : (digits || "");
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

/* ===== SURGICAL NAME FIX (ONLY) ===== */
function looksLikeFullName(text = "") {
  const v = String(text || "").trim();
  if (!v) return false;
  if (v.length > 60) return false;
  if (/@|\d/.test(v)) return false;
  if (/^(yes|no|house|apartment|basic|deep|proceed|finalize|carpet|upholstery|ducts?)$/i.test(v)) return false;
  const parts = v.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  if (parts.some(p => p.length < 2)) return false;
  return /^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)+$/.test(v);
}

function prevAssistantAskedForName(prevAssistant = "") {
  const t = String(prevAssistant || "");
  return /\b(full\s+name|your\s+name|what(?:’|'|)s\s+your\s+name|name\?)\b/i.test(t);
}
/* ===== END SURGICAL NAME FIX (ONLY) ===== */

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
    "state", "state_json", "channel", "source", "init",
    "verify_token", "hub.mode", "hub.challenge",
    "object", "entry"
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
try { validZipCodes = require("./zips.js").validZipCodes || null; }
catch {
  try { validZipCodes = require("../zips.js").validZipCodes || null; }
  catch { validZipCodes = null; }
}

const VALID_ZIP_SET =
  Array.isArray(validZipCodes)
    ? new Set(validZipCodes.map(z => String(z || "").trim()).filter(Boolean))
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
      .map(q => {
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

  const messages = texts.map(t => ({ type: "text", text: t }));
  const out = { version: "v2", content: { messages } };
  if (qrs.length) out.content.quick_replies = qrs;

  const st = (payload && payload.state !== undefined) ? payload.state : {};
  out.state = st;
  try { out.state_json = JSON.stringify(st); } catch { out.state_json = "{}"; }
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
      body: encodeForm(payload)
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
      body: encodeForm(payload)
    });
  } catch (err) {
    console.error("Session Zap failed", err);
  }
}

/* ===== ZAPIER FIX (ONLY): Robust field mapping + history fill for blanks ===== */
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
    .slice(-40)
    .map(m => `${m.role || ""}: ${String(m.content || "")}`)
    .join("\n");

  const out = {};

  const em = text.match(/[\w.\-+]+@[\w.\-]+\.\w{2,}/i);
  if (em) out.email = em[0].trim().toLowerCase();

  const ph = text.match(/\b(?:\+?1[\s\-\.]?)?(\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4})\b/);
  if (ph) {
    const d = extractTenDigit(ph[0]);
    if (d) out.phone = d;
  }

  const zip = text.match(/\b\d{5}\b/);
  if (zip) out.zip = zip[0];

  if (/(^|\b)8\s*(?:am)?\s*(?:-|to|–)\s*12\s*(?:pm)?(\b|$)/i.test(text)) out.window = "8 to 12";
  if (/(^|\b)1\s*(?:pm)?\s*(?:-|to|–)\s*5\s*(?:pm)?(\b|$)/i.test(text)) out.window = "1 to 5";

  if (/\bapartment\b/i.test(text)) out.building = "Apartment";
  if (/\bhouse\b/i.test(text)) out.building = "House";

  if (/\bno\s+pets?\b/i.test(text) || /\bpets?\s*[:\-]\s*no\b/i.test(text)) out.pets = "No";
  if (/\byes\b.*\bpets?\b/i.test(text) || /\bpets?\s*[:\-]\s*yes\b/i.test(text)) out.pets = "Yes";

  if (/\bno\b.*\boutdoor\s+water\b/i.test(text) || /\boutdoor\s+water\b.*\bno\b/i.test(text)) out.outdoorWater = "No";
  if (/\boutdoor\s+water\b.*\b(yes|available|access)\b/i.test(text) || /\bwater\s+spig(?:ot|got)\b/i.test(text)) out.outdoorWater = "Yes";

  const addr =
    text.match(/\b\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .,'-]*\s+(?:[A-Za-z .'-]+)\s+(?:GA|Georgia)\s+\d{5}\b/i) ||
    text.match(/\b\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .,'-]*,\s*[A-Za-z .'-]+,\s*(?:GA|Georgia)\s+\d{5}\b/i);
  if (addr) out.address = addr[0].trim();

  const dateLine = text.match(/(?:preferred\s*day|date|cleaning\s*date)\s*[:\-]?\s*([A-Za-z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
  if (dateLine) out.date = dateLine[1].trim();
  else {
    const md = text.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
    if (md) out.date = md[1].trim();
  }

  const notesLine = text.match(/\bnotes?\s*[:\-]\s*([^\n]{1,140})/i);
  if (notesLine) out.notes = notesLine[1].trim();

  const totals = [...text.matchAll(/\b(?:total|new\s+combined\s+total)\s*[:\-]?\s*\$?\s*(\d{2,5})\b/ig)];
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

  const name = _first(state.name, state.name2025);
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

  const totalPrice = _toNumber(_first(state.total_price, state.totalPrice, state.total, state["Total Price"], d.total_price));

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
    booking_complete: !!state.booking_complete
  };
}
/* ===== END ZAPIER FIX (ONLY) ===== */

/* ========================= OPENAI: MASTER PROMPT (PASTE YOUR OPENAI PROMPT HERE) ========================= */
const SDS_MASTER_PROMPT_TEXT = `...`.trim();

/* ========================= OPENAI: Extractor Prompt (JSON MODE) ========================= */
const SDS_EXTRACTOR_PROMPT = `...`.trim();

/* ========================= OPENAI Call Helpers ========================= */
function safeJsonExtract(text = "") {
  const s = String(text || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* continue */ }

  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const slice = s.slice(first, last + 1);
    try { return JSON.parse(slice); } catch { /* ignore */ }
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
    messages
  };

  if (jsonMode) payload.response_format = { type: "json_object" };

  try {
    const resp = await _fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
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

  // ✅ SURGICAL: capture name only when previous assistant asked for it
  if (!s.name) {
    const prevAssistant =
      [...s._history].reverse().find(m => m && m.role === "assistant" && typeof m.content === "string")?.content || "";
    if (prevAssistantAskedForName(prevAssistant) && looksLikeFullName(userText)) {
      s.name = String(userText || "").trim();
    }
  }

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
    { role: "user", content: `USER: ${String(userText || "").trim()}\nASSISTANT: ${String(assistantReply || "").trim()}` }
  ];

  let extracted = null;
  try {
    const extractorOut = await openaiChat(extractorMsgs, { jsonMode: true, maxTokens: 450 });
    extracted = safeJsonExtract(extractorOut);
  } catch {
    extracted = null;
  }

  const stateUpdate = (extracted && extracted.state_update && typeof extracted.state_update === "object" && !Array.isArray(extracted.state_update))
    ? extracted.state_update
    : {};

  const quickReplies = Array.isArray(extracted?.quick_replies) ? extracted.quick_replies : [];

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

  return { reply: assistantReply || "How can I help?", quickReplies, state: s };
}

/* ========================= CORE POST HANDLER ========================= */
async function handleCorePOST(req, res) {
  try {
    const body = req.body || {};
    const user = extractUserText(body);

    let state = body.state ?? {};
    if (typeof state === "string") {
      try { state = JSON.parse(state); } catch { state = {}; }
    }

    if (
      (!state || typeof state !== "object" || Array.isArray(state) || !Object.keys(state).length) &&
      typeof body.state_json === "string" &&
      body.state_json.trim()
    ) {
      try { state = JSON.parse(body.state_json) || {}; } catch { state = {}; }
    }

    if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
    state = enforceSessionTTL(state);
    if (!Array.isArray(state._history)) state._history = [];

    const fromManyChat = (body.channel === "messenger") || (body.source === "manychat");
    const originalJson = res.json.bind(res);

    res.json = (data) => {
      let out = (data == null) ? {} : (typeof data === "string" ? { reply: data } : { ...data });
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
      return res.status(200).json({
        reply: initTurn.reply,
        quickReplies: initTurn.quickReplies,
        state
      });
    }

    if (!user) {
      const emptyTurn = await llmTurn("hello", state);
      state = emptyTurn.state || state;
      return res.status(200).json({
        reply: emptyTurn.reply,
        quickReplies: emptyTurn.quickReplies,
        state
      });
    }

    const result = await llmTurn(user, state);
    const nextState = result.state || state;

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

    return res.status(200).json({
      reply: result.reply,
      quickReplies: result.quickReplies,
      state: nextState
    });
  } catch (err) {
    console.error("chat.js error", err);
    return res.status(200).json({
      reply: "Sorry — something glitched on my end, but I’m still here. Tell me what you need cleaned: carpet, upholstery, or air ducts.",
      state: { _started: true, _lastSeen: Date.now(), _history: [] },
      error: String((err && err.message) || err)
    });
  }
}

/* ========================= MAIN EXPORT ========================= */
module.exports = async (req, res) => {
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
            : { text: incoming.text, state: storedState, source: "meta" }
        };

        const fakeRes = {
          _status: 200,
          status(code) { this._status = code; return this; },
          json(obj) { captured = obj; return obj; },
          send(str) { captured = { reply: String(str || ""), state: storedState }; return captured; },
          sendStatus(code) { this._status = code; captured = null; return null; }
        };

        await handleCorePOST(fakeReq, fakeRes);

        const nextState = (captured && captured.state && typeof captured.state === "object") ? captured.state : storedState;
        await setStateByPSID(psid, nextState);

        const replyText = (captured && (captured.reply_text || captured.reply))
          ? String(captured.reply_text || captured.reply)
          : "";

        const quickReplies = captured?.quickReplies;
        await fbSendText(psid, replyText || "How can we help?", quickReplies);
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  }

  return handleCorePOST(req, res);
};
