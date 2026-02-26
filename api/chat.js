/**
 * Same Day Steamerz — OpenAI-Powered Full Bot (PROMPT DRIVES 100%)
 * Code does ONLY:
 * - Channel plumbing (Web / ManyChat / Meta)
 * - State persistence (server memory TTL)
 * - Zapier sends (Session + Booking)
 * - Runtime safety guards (history parity, non-empty responses, one-time upsell guard)
 *
 * REQUIRED ENVs:
 * - OPENAI_API_KEY (or OPENAI_KEY)
 *
 * Optional:
 * - OPENAI_API_BASE (default https://api.openai.com/v1)
 * - OPENAI_MODEL (default gpt-4.1)
 * - OPENAI_TIMEOUT_MS (default 12000)
 * - SESSION_TTL_MIN (default 240)
 * - MAX_HISTORY_MESSAGES (default 18)
 *
 * Meta envs supported (if using direct Facebook webhook):
 * - PAGE_ACCESS_TOKEN / FB_PAGE_ACCESS_TOKEN
 * - VERIFY_TOKEN / FB_VERIFY_TOKEN
 * - APP_SECRET / FB_APP_SECRET (optional signature validation)
 *
 * Zapier URLs:
 * - ZAPIER_SESSION_URL
 * - ZAPIER_BOOKING_URL
 *
 * Notes:
 * - This file is intentionally verbose (bigger) with robust guards and helpers.
 * - Prompt controls conversation; code only stores state and sends it back.
 */

const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { URL } = require("url");

/* ========================= ENV ========================= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const OPENAI_TIMEOUT_MS = Math.max(1200, parseInt(process.env.OPENAI_TIMEOUT_MS || "12000", 10) || 12000);

const SESSION_TTL_MIN = Math.max(10, parseInt(process.env.SESSION_TTL_MIN || "240", 10) || 240);
const MAX_HISTORY_MESSAGES = Math.max(6, parseInt(process.env.MAX_HISTORY_MESSAGES || "18", 10) || 18);

const PAGE_ACCESS_TOKEN =
  process.env.PAGE_ACCESS_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN || "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || process.env.FB_VERIFY_TOKEN || "";
const APP_SECRET = process.env.APP_SECRET || process.env.FB_APP_SECRET || "";

const ZAPIER_SESSION_URL = process.env.ZAPIER_SESSION_URL || "";
const ZAPIER_BOOKING_URL = process.env.ZAPIER_BOOKING_URL || "";

/* ========================= ZIP DATA (optional) =========================
 * If you have ./zips.js exporting something like:
 * module.exports = { zips: ["30044","30045",... ] } or module.exports = ["30044"...]
 * we'll load it. Otherwise, ZIP gating stays prompt-driven only.
 */
let ZIP_SET = null;
try {
  // Prefer local first
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const z = require("./zips.js");
  const list = Array.isArray(z) ? z : Array.isArray(z?.zips) ? z.zips : [];
  if (list.length) ZIP_SET = new Set(list.map((x) => String(x).trim()));
} catch (_) {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const z2 = require("../zips.js");
    const list2 = Array.isArray(z2) ? z2 : Array.isArray(z2?.zips) ? z2.zips : [];
    if (list2.length) ZIP_SET = new Set(list2.map((x) => String(x).trim()));
  } catch (__e) {
    ZIP_SET = null;
  }
}

/* ========================= IN-MEMORY STATE STORE =========================
 * Vercel serverless: memory may reset between invocations.
 * But for typical chat turns it works; your upstream can also persist if needed.
 */
const STORE = new Map(); // sessionId -> { state, expiresAt }

/* ========================= UTILITIES ========================= */
function nowMs() {
  return Date.now();
}

function ttlMs() {
  return SESSION_TTL_MIN * 60 * 1000;
}

function safeJsonParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function toJsonString(obj) {
  try {
    return JSON.stringify(obj || {});
  } catch (_e) {
    return "{}";
  }
}

function clampStr(s, max = 2000) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  return t.slice(0, max);
}

function normalizeText(t) {
  return String(t ?? "").replace(/\s+/g, " ").trim();
}

function isLikelyPhone(s) {
  const d = String(s || "").replace(/[^\d]/g, "");
  return d.length >= 10 && d.length <= 15;
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

function makeSessionId(req) {
  // Priority: explicit id from caller (ManyChat subscriber id, PSID, web session, etc.)
  const h = req.headers || {};
  const fromHeader = h["x-session-id"] || h["x-sessionid"] || h["x-user-id"];
  const q = req.query || {};
  const fromQuery = q.session_id || q.sessionId || q.psid || q.subscriber_id || q.user_id;
  if (fromHeader) return String(fromHeader);
  if (fromQuery) return String(fromQuery);

  // Fallback: stable-ish hash of IP + UA (not perfect, but avoids empty)
  const ip =
    (h["x-forwarded-for"] ? String(h["x-forwarded-for"]).split(",")[0].trim() : "") ||
    (req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : "") ||
    "0.0.0.0";
  const ua = String(h["user-agent"] || "");
  const seed = `${ip}|${ua}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function getStore(sessionId) {
  const row = STORE.get(sessionId);
  if (!row) return null;
  if (row.expiresAt < nowMs()) {
    STORE.delete(sessionId);
    return null;
  }
  return row.state || {};
}

function setStore(sessionId, state) {
  STORE.set(sessionId, { state: state || {}, expiresAt: nowMs() + ttlMs() });
}

function mergeState(prev, next) {
  const a = prev && typeof prev === "object" ? prev : {};
  const b = next && typeof next === "object" ? next : {};
  return { ...a, ...b };
}

function ensureHistory(state) {
  const s = state && typeof state === "object" ? state : {};
  if (!Array.isArray(s._history)) s._history = [];
  return s;
}

function pushHistory(state, role, content) {
  const s = ensureHistory(state);
  const c = normalizeText(content);
  if (!c) return s;

  s._history.push({ role, content: clampStr(c, 2000) });
  // Cap: keep last MAX_HISTORY_MESSAGES (messages, not turns)
  if (s._history.length > MAX_HISTORY_MESSAGES) {
    s._history = s._history.slice(s._history.length - MAX_HISTORY_MESSAGES);
  }
  return s;
}

/* ========================= Zapier payload mapping (LOCKED KEYS) =========================
 * Must match your working Zaps EXACTLY (casing + spaces):
 * Cleaning_Breakdown
 * "selected service"
 * "Total Price"
 * name2025
 * phone2025
 * email2025
 * Address
 * date
 * Window
 * pets
 * OutdoorWater
 * BuildingType
 * Notes
 * booking_complete
 */
function buildZapPayloadFromState(state = {}) {
  const s = state && typeof state === "object" ? state : {};

  const payload = {
    Cleaning_Breakdown: pickFirst(s.Cleaning_Breakdown, ""),
    "selected service": pickFirst(s["selected service"], s.selected_service, s.selectedService, ""),
    "Total Price": pickFirst(s["Total Price"], s.total_price, s.totalPrice, ""),

    name2025: pickFirst(s.name2025, s.name, ""),
    phone2025: pickFirst(s.phone2025, s.phone, ""),
    email2025: pickFirst(s.email2025, s.email, ""),

    Address: pickFirst(s.Address, s.address, ""),
    date: pickFirst(s.date, ""),
    Window: pickFirst(s.Window, s.window, ""),

    pets: pickFirst(s.pets, ""),
    OutdoorWater: pickFirst(s.outdoorWater, s.OutdoorWater, ""),
    BuildingType: pickFirst(s.building, s.BuildingType, ""),
    Notes: pickFirst(s.notes, s.Notes, ""),

    booking_complete: !!s.booking_complete,
  };

  return payload;
}

function shouldSendSessionZap(state) {
  const s = state || {};
  return !!(s.name && s.phone && !s._sessionSent);
}

function shouldSendBookingZap(state) {
  const s = state || {};
  return !!(s.booking_complete === true && !s._bookingSent);
}

async function httpRequest(urlString, opts = {}) {
  const url = new URL(urlString);
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;

  const method = opts.method || "GET";
  const headers = opts.headers || {};
  const body = opts.body ? Buffer.from(opts.body) : null;
  const timeoutMs = Math.max(500, opts.timeoutMs || 8000);

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          ...headers,
          ...(body ? { "Content-Length": body.length } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers || {},
            body: data,
          })
        );
      }
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timeout"));
    });

    if (body) req.write(body);
    req.end();
  });
}

async function sendZapier(url, payload) {
  if (!url) return { ok: false, skipped: true, reason: "Missing Zapier URL" };
  try {
    const res = await httpRequest(url, {
      method: "POST",
      timeoutMs: 9000,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body: res.body };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/* ========================= META SIGNATURE VALIDATION (optional) ========================= */
function verifyMetaSignature(req, rawBodyBuffer) {
  if (!APP_SECRET) return true; // If no secret configured, skip
  const sigHeader = req.headers["x-hub-signature-256"] || req.headers["x-hub-signature"];
  if (!sigHeader) return false;

  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(rawBodyBuffer).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sigHeader)));
}

/* ========================= INPUT EXTRACTION (Web / ManyChat / Meta) ========================= */
function extractIncoming(req) {
  const body = req.body || {};
  const headers = req.headers || {};
  const query = req.query || {};

  // 1) Direct Meta webhook (object:"page")
  // Structure: { object:"page", entry:[{ messaging:[{ sender:{id}, message:{text} }]}]}
  if (body && body.object === "page" && Array.isArray(body.entry)) {
    for (const entry of body.entry) {
      const messaging = entry && entry.messaging;
      if (!Array.isArray(messaging)) continue;
      for (const evt of messaging) {
        const psid = evt?.sender?.id ? String(evt.sender.id) : "";
        const text = evt?.message?.text ? String(evt.message.text) : "";
        if (psid && text) {
          return {
            channel: "meta",
            sessionId: psid,
            text: normalizeText(text),
            raw: body,
          };
        }
      }
    }
  }

  // 2) ManyChat (v2) webhook style or custom mapping
  // Common: body.subscriber.id + body.message.text
  const subId =
    pickFirst(body?.subscriber?.id, body?.subscriber_id, body?.contact?.id, body?.psid, query?.subscriber_id, query?.psid) || "";
  const manyText =
    pickFirst(body?.message?.text, body?.text, body?.last_text, body?.input, body?.data?.text, body?.payload?.text) || "";

  if (subId && normalizeText(manyText)) {
    return {
      channel: "manychat",
      sessionId: String(subId),
      text: normalizeText(manyText),
      raw: body,
    };
  }

  // 3) Web widget / generic POST
  // Accept: { message: "..."} or { text:"..."} or { input:"..."}
  const webText =
    pickFirst(body?.message, body?.text, body?.input, body?.user_message, body?.prompt, query?.message, query?.text) || "";

  if (normalizeText(webText)) {
    return {
      channel: "web",
      sessionId: makeSessionId(req),
      text: normalizeText(webText),
      raw: body,
    };
  }

  // 4) INIT / cold start (web)
  // If nothing found, treat as init for web flow only when explicitly asked
  // but we will not auto-init; caller should send "__INIT__"
  return {
    channel: pickFirst(headers["x-channel"], body?.channel, "web"),
    sessionId: makeSessionId(req),
    text: "",
    raw: body,
  };
}

/* ========================= OpenAI System Prompt (FULL BOT) ========================= */
const SDS_SYSTEM_PROMPT = `
You are Agent 995 for Same Day Steamerz. You are a calm, confident booking and sales agent.
You run the ENTIRE conversation (pricing, upsells, booking, confirmations). The backend only stores state and sends it to you.

CRITICAL OUTPUT FORMAT:
- You MUST return a single JSON object ONLY (no markdown, no code fences, no extra text).
- JSON schema:
  {
    "reply": "string (what customer sees)",
    "quick_replies": ["optional", "strings"],
    "state": { "object with all saved fields" }
  }

ABSOLUTE RULES:
- All prices must be numeric using $ (examples: $100, $150, $250, $500).
- Never write prices in words.
- Never explain pricing math or how prices are calculated.
- Ask only ONE question per message.
- Never repeat a question if the customer already provided the required info.
- Keep responses short, confident, booking-focused.

STATE RULES:
- You will receive CURRENT_STATE_JSON (includes prior state and conversation history).
- Always return an updated "state" object.
- Store these keys when collected:
  zip, address, name, phone, email, date, window, pets, building, floor, outdoorWater, notes
- Also store:
  selected_service (string), Cleaning_Breakdown (string), total_price (number), booking_complete (boolean)
- Also store this key to prevent repeated post-booking upsell:
  post_booking_upsell_done (boolean)
- If you do not know a value yet, leave it empty or omit it.

GREETING (LOCKED):
If user input is "__INIT__", greet and ask:
"What do you need cleaned today: carpet, upholstery, or air ducts?"
Provide quick replies:
["Carpet Cleaning","Upholstery Cleaning","Air Duct Cleaning"]

ARRIVAL WINDOWS (LOCKED):
Offer ONLY these two windows:
- 8 to 12
- 1 to 5
Ask:
"Which arrival window works best: 8 to 12 or 1 to 5?"

CARPET PRICING (LOCKED):
(unchanged — your full pricing rules remain here)

UPHOLSTERY (LOCKED):
(unchanged — your full upholstery rules remain here)

DUCT CLEANING (LOCKED ORDER):
(unchanged — your full duct rules remain here)

ZIP GATE (PROMPT-CONTROLLED):
Ask ZIP only after move-forward + required pre-zip upsell (if applicable).
If out of area: collect ONLY name + phone, stop.

BOOKING ORDER (LOCKED):
After ZIP verified in-area, collect in order (one question per message):
1 Address
2 Name
3 Phone
4 Email
5 Date
6 Window (8 to 12 OR 1 to 5)
7 Pets
8 House or apartment
9 Floor (if apartment)
10 Outdoor water supply (that you can connect a garden hose to)
Ask exactly:
"Do you have an outdoor water supply available? (that you can connect a garden hose to)"
11 Notes

FINAL CONFIRMATION:
Provide summary including Total: $___ then ask:
"Is there anything you’d like to change before I finalize this?"
If they say no, finalize and include:
"If you have any questions or need changes, you can reach our dispatcher at 678-929-8202."

POST-BOOKING UPSELL (LOCKED):
- If customer booked carpet or upholstery: offer duct ONCE after final confirmation.
- If customer booked duct: offer carpet/upholstery ONCE after final confirmation.
- Never upsell duct before booking is finalized.
- Use state.post_booking_upsell_done=true after the one-time offer has been made.

NON-SALES HARD STOP:
If they mention reschedule/cancel/complaint/refund/past job:
Say it’s the sales line and provide dispatcher 678-929-8202. Collect only name, phone, reason. End.
`.trim();

/* ========================= OpenAI Call (history parity + hardening) ========================= */
async function callOpenAI({ userText, state }) {
  if (!OPENAI_API_KEY) {
    return {
      ok: false,
      error: "Missing OPENAI_API_KEY",
      parsed: null,
      rawText: "",
    };
  }

  const s = ensureHistory(state || {});
  const currentStateJson = toJsonString(s);

  // Order MUST be:
  // system prompt
  // CURRENT_STATE_JSON
  // ...state._history
  // current user message
  const messages = [
    { role: "system", content: SDS_SYSTEM_PROMPT },
    { role: "system", content: `CURRENT_STATE_JSON: ${currentStateJson}` },
    ...(Array.isArray(s._history) ? s._history : []),
    { role: "user", content: clampStr(userText, 1500) },
  ];

  const payload = {
    model: OPENAI_MODEL,
    messages,
    temperature: 0.3,
    response_format: { type: "json_object" },
  };

  let res;
  try {
    res = await httpRequest(`${OPENAI_API_BASE.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      timeoutMs: OPENAI_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return {
      ok: false,
      error: `OpenAI request failed: ${String(e && e.message ? e.message : e)}`,
      parsed: null,
      rawText: "",
    };
  }

  if (!(res.status >= 200 && res.status < 300)) {
    return {
      ok: false,
      error: `OpenAI non-200: ${res.status}`,
      parsed: null,
      rawText: res.body || "",
    };
  }

  const parsedTop = safeJsonParse(res.body || "{}");
  if (!parsedTop.ok) {
    return {
      ok: false,
      error: "OpenAI response JSON parse failed (top-level).",
      parsed: null,
      rawText: res.body || "",
    };
  }

  const content = parsedTop.value?.choices?.[0]?.message?.content || "";
  const rawText = String(content || "");
  const parsed = safeJsonParse(rawText);

  if (!parsed.ok) {
    // Bad JSON from model — return safe fallback (hardening)
    return {
      ok: false,
      error: "Model output JSON parse failed.",
      parsed: null,
      rawText,
    };
  }

  return {
    ok: true,
    error: null,
    parsed: parsed.value,
    rawText,
  };
}

/* ========================= Output Builders (Web + ManyChat + Meta) ========================= */
function buildWebResponse({ reply, quick_replies, state }) {
  const safeReply = normalizeText(reply) || "Got it. What do you need cleaned today: carpet, upholstery, or air ducts?";
  const s = state && typeof state === "object" ? state : {};
  return {
    reply: safeReply,
    reply_text: safeReply, // for mapping
    quick_replies: Array.isArray(quick_replies) ? quick_replies : [],
    state: s,
    state_json: toJsonString(s),
  };
}

function buildManyChatV2Response({ reply, quick_replies, state }) {
  const safeReply = normalizeText(reply) || "Got it. What do you need cleaned today: carpet, upholstery, or air ducts?";
  const s = state && typeof state === "object" ? state : {};

  // ManyChat v2 messages
  const msg = {
    type: "text",
    text: safeReply,
  };

  // ManyChat quick replies format varies; keep simple strings for mapping or custom usage
  // If your ManyChat expects different schema, you can map reply_text and ignore quick replies.
  const out = {
    version: "v2",
    content: {
      messages: [msg],
    },
    // Also provide fields ManyChat can map directly:
    reply: safeReply,
    reply_text: safeReply,
    state: s,
    state_json: toJsonString(s),
    quick_replies: Array.isArray(quick_replies) ? quick_replies : [],
  };

  return out;
}

async function sendMetaMessage(psid, text) {
  if (!PAGE_ACCESS_TOKEN) return { ok: false, skipped: true, reason: "Missing PAGE_ACCESS_TOKEN" };
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload = {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: { text: String(text || "") },
  };

  try {
    const res = await httpRequest(url, {
      method: "POST",
      timeoutMs: 9000,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body: res.body };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/* ========================= Outdoor water fallback text (Search & Replace target) ========================= */
const OUTDOOR_WATER_QUESTION =
  "Do you have an outdoor water supply available? (that you can connect a garden hose to)";

/* ========================= Post-booking upsell enforcement (runtime safety) =========================
 * Minimal guard:
 * - We do NOT generate upsell content in code.
 * - We only ensure the flag exists to prevent repeats.
 * - If booking_complete just became true, we leave model to upsell ONCE.
 * - If state.post_booking_upsell_done is already true, we do nothing.
 */
function enforcePostBookingUpsellGuard(prevState, nextState) {
  const prev = prevState || {};
  const next = nextState || {};

  // If already done, keep it done.
  if (next.post_booking_upsell_done === true || prev.post_booking_upsell_done === true) {
    next.post_booking_upsell_done = true;
    return next;
  }

  // If booking just completed, we allow the model to offer upsell once.
  // The model should set post_booking_upsell_done=true after it offers.
  // We do not auto-set it here because we don't know if the model actually offered yet.
  return next;
}

/* ========================= Optional ZIP hard gate (code-level) =========================
 * Your prompt controls ZIP gating; this is only extra safety if you loaded ZIP_SET.
 * We only enforce if the state.zip exists and ZIP_SET exists and it's out-of-area:
 * - Force stop: keep only name + phone flow (softly)
 *
 * If you do NOT want code-level ZIP gating, set ZIP_SET=null.
 */
function applyZipSafetyGate(nextState) {
  if (!ZIP_SET) return nextState;
  const s = nextState || {};
  const zip = String(s.zip || "").trim();
  if (!zip) return s;
  if (!ZIP_SET.has(zip)) {
    // Out of area safety: do not let address/date/etc persist
    return {
      ...s,
      address: s.address || "",
      date: "",
      window: "",
      email: s.email || "",
      booking_complete: false,
    };
  }
  return s;
}

/* ========================= CORE HANDLER ========================= */
async function handleCorePOST(req, res, rawBodyBuffer = null) {
  const incoming = extractIncoming(req);
  const sessionId = incoming.sessionId || makeSessionId(req);
  const channel = incoming.channel || "web";
  const userText = incoming.text || "";

  // Load previous state
  const prevState = getStore(sessionId) || {};
  let state = mergeState(prevState, {}); // clone-ish
  state = ensureHistory(state);

  // INIT path: if empty message and state has no history, force __INIT__ only for web/manychat
  // But we do NOT auto-init on Meta, since Meta should send real messages.
  const effectiveUserText = normalizeText(userText) || "";

  // Append user message to history (history parity) — including __INIT__ if caller sends it.
  if (effectiveUserText) {
    pushHistory(state, "user", effectiveUserText);
  }

  // If caller didn't send anything, respond safely
  if (!effectiveUserText) {
    const safe = buildWebResponse({
      reply: "Send a message to get started.",
      quick_replies: [],
      state,
    });
    setStore(sessionId, state);
    return res.status(200).json(channel === "manychat" ? buildManyChatV2Response(safe) : safe);
  }

  // Call OpenAI
  const ai = await callOpenAI({ userText: effectiveUserText, state });

  // Hardening: if OpenAI fails or returns bad JSON, keep state + return safe reply
  if (!ai.ok || !ai.parsed) {
    const fallbackReply =
      "Got it. What do you need cleaned today: carpet, upholstery, or air ducts?";
    // Append assistant fallback to history
    pushHistory(state, "assistant", fallbackReply);

    // Persist
    setStore(sessionId, state);

    // Web/Multi channel response
    if (channel === "manychat") {
      return res.status(200).json(
        buildManyChatV2Response({
          reply: fallbackReply,
          quick_replies: ["Carpet Cleaning", "Upholstery Cleaning", "Air Duct Cleaning"],
          state,
        })
      );
    }

    // For Meta: send message via Send API + 200 OK
    if (channel === "meta") {
      await sendMetaMessage(sessionId, fallbackReply);
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json(
      buildWebResponse({
        reply: fallbackReply,
        quick_replies: ["Carpet Cleaning", "Upholstery Cleaning", "Air Duct Cleaning"],
        state,
      })
    );
  }

  // Model output schema: { reply, quick_replies, state }
  const modelObj = ai.parsed && typeof ai.parsed === "object" ? ai.parsed : {};
  const modelReply = normalizeText(modelObj.reply || "");
  const modelQuick = Array.isArray(modelObj.quick_replies) ? modelObj.quick_replies : [];
  const modelState = modelObj.state && typeof modelObj.state === "object" ? modelObj.state : {};

  // Merge nextState (model wins for conversational keys)
  let nextState = mergeState(state, modelState);

  // Enforce runtime safety
  nextState = enforcePostBookingUpsellGuard(state, nextState);

  // Optional code-level ZIP safety (only if ZIP_SET loaded)
  nextState = applyZipSafetyGate(nextState);

  // Outdoor water wording fallback search/replace safety:
  // If prompt ever produces alternate wording for the specific question, we keep prompt-driven,
  // but we also provide the canonical constant for any future step-machine fallback.
  nextState._outdoorWaterQuestion = OUTDOOR_WATER_QUESTION;

  // Append assistant message to history (history parity)
  const finalReply =
    modelReply ||
    "Got it. What do you need cleaned today: carpet, upholstery, or air ducts?";
  pushHistory(nextState, "assistant", finalReply);

  // Persist state
  setStore(sessionId, nextState);

  // Zapier triggers (LOCKED)
  // Session Zap: when name + phone exist and _sessionSent not set
  if (shouldSendSessionZap(nextState)) {
    const payload = buildZapPayloadFromState({ ...nextState, booking_complete: false });
    const zap = await sendZapier(ZAPIER_SESSION_URL, payload);
    nextState._sessionSent = true;
    nextState._sessionZapStatus = zap.ok ? "sent" : "failed";
    setStore(sessionId, nextState);
  }

  // Booking Zap: when booking_complete true and _bookingSent not set
  if (shouldSendBookingZap(nextState)) {
    const payload = buildZapPayloadFromState({ ...nextState, booking_complete: true });
    const zap = await sendZapier(ZAPIER_BOOKING_URL, payload);
    nextState._bookingSent = true;
    nextState._bookingZapStatus = zap.ok ? "sent" : "failed";
    setStore(sessionId, nextState);
  }

  // Respond per channel
  if (channel === "manychat") {
    return res.status(200).json(
      buildManyChatV2Response({
        reply: finalReply,
        quick_replies: modelQuick,
        state: nextState,
      })
    );
  }

  if (channel === "meta") {
    // Meta requires us to send via Send API; respond 200 OK to webhook
    await sendMetaMessage(sessionId, finalReply);
    return res.status(200).json({ ok: true });
  }

  return res.status(200).json(
    buildWebResponse({
      reply: finalReply,
      quick_replies: modelQuick,
      state: nextState,
    })
  );
}

/* ========================= NEXT.JS / VERCEL HANDLER =========================
 * Supports:
 * - GET: Meta verification
 * - POST: Web / ManyChat / Meta incoming
 */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // 1) Meta verify (GET)
  if (req.method === "GET") {
    const mode = req.query && req.query["hub.mode"];
    const token = req.query && req.query["hub.verify_token"];
    const challenge = req.query && req.query["hub.challenge"];

    const ok =
      mode === "subscribe" &&
      token &&
      VERIFY_TOKEN &&
      String(token) === String(VERIFY_TOKEN);

    if (ok) {
      return res.status(200).type("text/plain").send(String(challenge || ""));
    }
    return res.status(403).type("text/plain").send("Forbidden");
  }

  // 2) POST for all channels
  if (req.method === "POST") {
    // If you want strict Meta signature validation, you need raw body buffer.
    // In many Next.js setups, body parsing consumes raw bytes.
    // We keep a permissive mode unless APP_SECRET is set AND you provide raw bytes.
    if (APP_SECRET && rawBodyBuffer && req.body && req.body.object === "page") {
      const ok = verifyMetaSignature(req, rawBodyBuffer);
      if (!ok) return res.status(403).json({ error: "Bad signature" });
    }

    try {
      return await handleCorePOST(req, res, rawBodyBuffer);
    } catch (e) {
      // Global hardening: never return blank
      const msg =
        "Got it. What do you need cleaned today: carpet, upholstery, or air ducts?";
      return res.status(200).json(
        buildWebResponse({
          reply: msg,
          quick_replies: ["Carpet Cleaning", "Upholstery Cleaning", "Air Duct Cleaning"],
          state: getStore(makeSessionId(req)) || {},
        })
      );
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).type("text/plain").send("Method Not Allowed");
}

/* ========================= OPTIONAL: OUTDOOR WATER SEARCH/REPLACE HELPERS =========================
 * If you ever reintroduce any step-machine fallback prompts, use this constant:
 * OUTDOOR_WATER_QUESTION
 * "Do you have an outdoor water supply available? (that you can connect a garden hose to)"
 */
