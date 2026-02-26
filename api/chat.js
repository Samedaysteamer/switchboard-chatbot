// Same Day Steamerz — OpenAI-Powered Full Bot (PROMPT DRIVES 100%)
// Code does ONLY:
// - channel plumbing (Web / ManyChat / Meta)
// - state persistence
// - Zapier sends
// The OpenAI prompt controls: service selection, pricing, upsells, booking, confirmations.
//
// REQUIRED ENVs:
// - OPENAI_API_KEY (or OPENAI_KEY)
// Optional:
// - OPENAI_API_BASE (default https://api.openai.com/v1)
// - OPENAI_MODEL (default gpt-4.1)
// - OPENAI_TIMEOUT_MS (default 12000)
// - SESSION_TTL_MIN (default 240)
// Existing Meta envs supported:
// - PAGE_ACCESS_TOKEN / FB_PAGE_ACCESS_TOKEN
// - VERIFY_TOKEN / FB_VERIFY_TOKEN
// - APP_SECRET / FB_APP_SECRET
//
// Zapier URLs are left as-is (same as your baseline).

const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { URL } = require("url");

/* ========================= ENV ========================= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const OPENAI_TIMEOUT_MS = Math.max(
  1200,
  parseInt(process.env.OPENAI_TIMEOUT_MS || "12000", 10) || 12000
);

const SESSION_TTL_MIN = Math.max(
  10,
  parseInt(process.env.SESSION_TTL_MIN || "240", 10) || 240
);
const MAX_HISTORY_MESSAGES = Math.max(
  6,
  parseInt(process.env.MAX_HISTORY_MESSAGES || "18", 10) || 18
); // total msgs (user+assistant)

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
    stateObj && typeof stateObj === "object" && !Array.isArray(stateObj) ? stateObj : {};
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

/* ========================= Low-level HTTP (fetch-safe) ========================= */
function httpRequest(
  urlStr,
  { method = "GET", headers = {}, body = null, timeoutMs = 12000 } = {}
) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;

    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ""),
      headers: headers || {},
    };

    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        resolve({ status: res.statusCode || 0, headers: res.headers || {}, text });
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy(new Error("Request timeout"));
      } catch {
        /* ignore */
      }
    });

    if (body != null) req.write(body);
    req.end();
  });
}

async function postJson(url, payload, extraHeaders = {}, timeoutMs = 12000) {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  };
  const res = await httpRequest(url, { method: "POST", headers, body, timeoutMs });
  let json = null;
  try {
    json = JSON.parse(res.text || "");
  } catch {
    json = null;
  }
  return { ...res, json };
}

async function postForm(url, formEncoded, extraHeaders = {}, timeoutMs = 12000) {
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "Content-Length": Buffer.byteLength(formEncoded),
    ...extraHeaders,
  };
  return httpRequest(url, { method: "POST", headers, body: formEncoded, timeoutMs });
}

/* ========================= Utilities ========================= */
function encodeForm(data) {
  return Object.keys(data || {})
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? ""))
    .join("&");
}

const normalizeDigits = (s = "") => String(s || "").replace(/\D+/g, "");

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

function safeTrim(v) {
  if (typeof v !== "string") return "";
  return v.trim();
}

function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s) return s;
  }
  return "";
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

/* ========================= Session TTL ========================= */
function enforceSessionTTL(state) {
  const now = Date.now();
  const ttlMs = SESSION_TTL_MIN * 60 * 1000;

  const lastSeen = typeof state._lastSeen === "number" ? state._lastSeen : 0;
  if (lastSeen && now - lastSeen > ttlMs) {
    return {
      _lastSeen: now,
      _started: false,
      _history: [],
      _sessionSent: !!state._sessionSent,
      _bookingSent: !!state._bookingSent,
    };
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
const ZAPIER_BOOKING_URL = "https://hooks.zapier.com/hooks/catch/3165661/u13zg9e/"; // Booking Zap
const ZAPIER_SESSION_URL = "https://hooks.zapier.com/hooks/catch/3165661/u12ap8l/"; // Session/Partial Zap

async function sendBookingZapFormEncoded(payload) {
  try {
    await postForm(ZAPIER_BOOKING_URL, encodeForm(payload), {}, 12000);
  } catch (err) {
    console.error("Booking Zap failed", err);
  }
}

async function sendSessionZapFormEncoded(payload) {
  try {
    if (!payload?.name2025 && !payload?.phone2025 && !payload?.email2025) return;
    await postForm(ZAPIER_SESSION_URL, encodeForm(payload), {}, 12000);
  } catch (err) {
    console.error("Session Zap failed", err);
  }
}

/**
 * SURGICAL: Normalize state fields so Zapier doesn't get blanks when the model
 * returns different casing/aliases (Window vs window, OutdoorWater vs outdoorWater, etc.)
 * This does NOT rename your Zapier keys — only ensures state has canonical fields populated.
 */
function normalizeStateForZapier(state = {}) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;

  // Canonical: name, phone, email
  state.name = pickFirstNonEmpty(state.name, state.Name, state.full_name, state.fullName);
  state.phone = pickFirstNonEmpty(state.phone, state.Phone, state.phone2025, state.Phone2025);
  state.email = pickFirstNonEmpty(state.email, state.Email, state.email2025, state.Email2025);

  // Canonical: address, zip
  state.address = pickFirstNonEmpty(state.address, state.Address, state.service_address, state.serviceAddress);
  state.zip = pickFirstNonEmpty(state.zip, state.Zip, state.ZIP, state.postal_code, state.postalCode);

  // Canonical: date, window
  state.date = pickFirstNonEmpty(state.date, state.Date, state.cleaning_date, state.cleaningDate, state.service_date);
  state.window = pickFirstNonEmpty(state.window, state.Window, state.arrival_window, state.arrivalWindow);

  // Canonical: pets
  state.pets = pickFirstNonEmpty(state.pets, state.Pets, state.pet, state.hasPets);

  // Canonical: building (house/apartment)
  state.building = pickFirstNonEmpty(
    state.building,
    state.BuildingType,
    state.buildingType,
    state.house_or_apartment,
    state.houseOrApartment,
    state.property_type,
    state.propertyType
  );

  // Canonical: floor
  state.floor = pickFirstNonEmpty(state.floor, state.Floor, state.apartment_floor, state.apartmentFloor);

  // Canonical: outdoorWater
  state.outdoorWater = pickFirstNonEmpty(
    state.outdoorWater,
    state.OutdoorWater,
    state.outdoor_water,
    state.water_supply,
    state.waterSupply,
    state.outside_water,
    state.outsideWater
  );

  // Canonical: notes
  state.notes = pickFirstNonEmpty(state.notes, state.Notes, state.note, state.technician_notes, state.technicianNotes);

  // Canonical: pricing/breakdown/service
  state.selected_service = pickFirstNonEmpty(
    state.selected_service,
    state.selectedService,
    state["selected service"],
    state.service,
    state.Service
  );

  state.Cleaning_Breakdown = pickFirstNonEmpty(
    state.Cleaning_Breakdown,
    state.cleaning_breakdown,
    state.breakdown,
    state.Breakdown,
    state.cleaningBreakdown
  );

  // total_price number handling
  if (typeof state.total_price !== "number") {
    if (typeof state.total === "number") state.total_price = state.total;
    else if (typeof state.Total === "number") state.total_price = state.Total;
    else if (typeof state.total_price === "string") {
      const n = parseFloat(state.total_price.replace(/[^0-9.]/g, ""));
      if (!Number.isNaN(n)) state.total_price = n;
    }
  }

  // Normalize phone/email/zip formatting
  if (typeof state.phone === "string") {
    const digits = extractTenDigit(state.phone);
    if (digits) state.phone = digits;
  }
  if (typeof state.email === "string") {
    const em = extractEmail(state.email);
    if (em) state.email = em;
  }
  if (typeof state.zip === "string") {
    const z = normalizeZip(state.zip);
    if (z) state.zip = z;
  }

  return state;
}

/**
 * IMPORTANT: Keep Zapier field NAMES exactly the same as your existing Zap mappings.
 * We only improve the source (state aliases) so fields stop arriving blank.
 */
function buildZapPayloadFromState(state = {}) {
  const s = normalizeStateForZapier({ ...state });

  return {
    Cleaning_Breakdown: s.Cleaning_Breakdown || "",
    "selected service": s.selected_service || "",
    "Total Price": typeof s.total_price === "number" ? s.total_price : 0,

    // These are the names your Zap already expects:
    name2025: s.name || "",
    phone2025: s.phone || "",
    email2025: s.email || "",

    Address: s.address || "",
    date: s.date || "",
    Window: s.window || "",
    pets: s.pets || "",
    OutdoorWater: s.outdoorWater || "",
    BuildingType: s.building || "",
    Notes: s.notes || "",

    booking_complete: !!s.booking_complete,
  };
}

/* ========================= Meta helpers ========================= */
function toFBQuickReplies(quickReplies) {
  if (!Array.isArray(quickReplies) || !quickReplies.length) return undefined;
  return quickReplies.slice(0, 13).map((q) => {
    const title = typeof q === "string" ? q : q?.title || q?.text || "";
    const payload = (typeof q === "string" ? q : q?.payload || title || "").toLowerCase();
    return {
      content_type: "text",
      title: String(title).slice(0, 20),
      payload: String(payload).slice(0, 1000),
    };
  });
}

async function fbSendText(psid, text, quickReplies) {
  if (!FB_PAGE_ACCESS_TOKEN) return;

  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(
    FB_PAGE_ACCESS_TOKEN
  )}`;
  const msgObj = { text: String(text || "").trim() || " " };
  const qr = toFBQuickReplies(quickReplies);
  if (qr) msgObj.quick_replies = qr;

  try {
    await postJson(
      url,
      {
        messaging_type: "RESPONSE",
        recipient: { id: psid },
        message: msgObj,
      },
      {},
      12000
    );
  } catch (e) {
    console.error("fbSendText failed", e);
  }
}

function verifyFBSignature(req) {
  if (!FB_APP_SECRET) return true;

  const sig = req.headers?.["x-hub-signature-256"] || req.headers?.["X-Hub-Signature-256"];
  if (!sig || typeof sig !== "string") return true;

  try {
    const body = JSON.stringify(req.body || {});
    const expected =
      "sha256=" + crypto.createHmac("sha256", FB_APP_SECRET).update(body).digest("hex");
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
- Post-booking upsell safety:
  post_booking_upsell_done (boolean) — set true once you offer the post-booking upsell (whether accepted or declined) so you do NOT repeat it.

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
- Areas: rooms + rugs + hallway (only if mentioned) + stairs (per full flight).
- Stairs: If user says "stairs" or gives step count without flights, ask:
  "How many full flights of stairs are there?"
- Standard: $50 per charged area, minimum $100
- Specials (based on TOTAL areas mentioned BEFORE any hallway adjustment):
  - exactly 2 total areas => $100
  - exactly 6 total areas => $200
- Hallway adjustment (internal): if hallway mentioned AND total areas mentioned >= 4, the first hallway is not charged.
- Do not reveal hallway rule or any internal rules.

UPHOLSTERY (LOCKED):
First ask what pieces they need cleaned.
If they mention sofa/couch/loveseat/sectional: ask seat count:
"How many people can it comfortably seat?"
Pricing:
- Seating pieces: $50 per seat
- If seat count is 1–3: minimum $150
- If seat count is 4+ OR they say "sectional": minimum $250
Other items:
- Dining chair: $25 each
- Recliner: $80
- Ottoman: $50
- Mattress: $150
Standalone upholstery minimum: $100 (if only small items subtotal < $100, charge $100).
If a seating piece is booked, small add-ons can remain normal.

BUNDLE DISCOUNT + PROFIT PROTECTION (LOCKED):
If BOTH carpet + upholstery are booked in the same conversation, apply -$50.
If bundle active and upholstery subtotal < $100, treat upholstery subtotal as $100 BEFORE applying -$50.
Never mention this adjustment. Only show:
"Bundle discount: -$50"
"New combined total: $___"

PRE-ZIP UPSELL (LOCKED):
After customer says YES to move forward on carpet OR upholstery:
- Carpet => offer upholstery once before ZIP:
  "Before we move forward, if you bundle upholstery with carpet today, you qualify for $50 off the combined total. Would you like to add upholstery cleaning?"
- Upholstery => offer carpet once before ZIP:
  "Before we move forward, would you like me to quote carpet cleaning as well?"
After accept/decline, proceed to ZIP question.

DUCT CLEANING (LOCKED ORDER):
If customer selects duct cleaning:
First question MUST be:
"How many HVAC systems (AC units) do you have?"
Never ask "how many vents".

After systems, present packages using EXACT block below (keep emojis & formatting EXACT):

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
"Would you like Basic or Deep?"

Pricing:
- Basic: $200 per system
- Deep: $500 per system
Then add-ons one at a time:
- Furnace: Basic $200 per system, Deep $100 per system
- Dryer vent: $200

COMBINATION JOBS — DUCT + (CARPET OR UPHOLSTERY) (LOCKED):
If duct is booked with carpet and/or upholstery:
- Two separate work orders
- May be different technicians
Say:
"These are scheduled as separate work orders with different technicians, so the dispatcher will confirm the exact timing for each service."

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
11 Notes

OUTDOOR WATER QUESTION (LOCKED TEXT):
When you ask about outdoor water, ask exactly:
"Do you have an outside water supply available? (that you can connect a garden hose to)"

FINAL CONFIRMATION:
Provide summary including Total: $___ then ask:
"Is there anything you’d like to change before I finalize this?"
If they say no, finalize and include:
"If you have any questions or need changes, you can reach our dispatcher at 678-929-8202."

POST-BOOKING UPSELL (LOCKED):
- Only after booking is finalized (booking_complete true).
- If customer booked carpet or upholstery (and did NOT book duct): offer duct cleaning ONCE.
- If customer booked duct (and did NOT book carpet/upholstery): offer carpet or upholstery ONCE.
- After offering and receiving accept/decline, set post_booking_upsell_done = true and do NOT offer again.
- Do NOT upsell duct before booking is finalized.

NON-SALES HARD STOP:
If they mention reschedule/cancel/complaint/refund/past job:
Say it’s the sales line and provide dispatcher 678-929-8202. Collect only name, phone, reason. End.
`.trim();

/* ========================= JSON extraction ========================= */
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

/* ========================= History helpers ========================= */
function ensureHistory(state) {
  if (!state || typeof state !== "object") return [];
  if (!Array.isArray(state._history)) state._history = [];
  if (state._history.length > MAX_HISTORY_MESSAGES) {
    state._history = state._history.slice(-MAX_HISTORY_MESSAGES);
  }
  return state._history;
}

function appendHistory(state, role, content) {
  ensureHistory(state);
  const msg = { role, content: String(content || "").slice(0, 2000) };
  state._history.push(msg);
  if (state._history.length > MAX_HISTORY_MESSAGES) {
    state._history = state._history.slice(-MAX_HISTORY_MESSAGES);
  }
}

/* ========================= OpenAI Call ========================= */
async function callOpenAI(userText, currentState) {
  const stateSafe =
    currentState && typeof currentState === "object" && !Array.isArray(currentState)
      ? currentState
      : {};

  if (!OPENAI_API_KEY) {
    return {
      reply: "Missing OpenAI API key on the server.",
      quick_replies: [],
      state: stateSafe,
    };
  }

  ensureHistory(stateSafe);

  const stateJson = (() => {
    try {
      return JSON.stringify(stateSafe || {});
    } catch {
      return "{}";
    }
  })();

  const messages = [
    { role: "system", content: SDS_SYSTEM_PROMPT },
    { role: "system", content: `CURRENT_STATE_JSON: ${stateJson}` },
    ...stateSafe._history,
    { role: "user", content: String(userText || "").trim() },
  ];

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.25,
    max_tokens: 800,
    messages,
  };

  const url = `${OPENAI_API_BASE.replace(/\/+$/, "")}/chat/completions`;

  const resp = await postJson(url, payload, { Authorization: `Bearer ${OPENAI_API_KEY}` }, OPENAI_TIMEOUT_MS);

  if (!(resp.status >= 200 && resp.status < 300)) {
    console.error("OPENAI_NON_200", resp.status, (resp.text || "").slice(0, 300));
    return {
      reply: "Sorry — I had a connection issue. Please try again.",
      quick_replies: [],
      state: stateSafe,
    };
  }

  const content = resp?.json?.choices?.[0]?.message?.content || "";
  const parsed = safeJsonExtract(content);

  if (!parsed || typeof parsed !== "object") {
    console.error("OPENAI_BAD_JSON", String(content || "").slice(0, 300));
    return {
      reply: "Sorry — I had a quick formatting issue. Please try that again.",
      quick_replies: [],
      state: stateSafe,
    };
  }

  const reply =
    typeof parsed.reply === "string" ? parsed.reply : typeof parsed.text === "string" ? parsed.text : "";
  const quick = Array.isArray(parsed.quick_replies)
    ? parsed.quick_replies
    : Array.isArray(parsed.quickReplies)
    ? parsed.quickReplies
    : [];
  const nextState =
    parsed.state && typeof parsed.state === "object" && !Array.isArray(parsed.state) ? parsed.state : {};

  return {
    reply: String(reply || "").trim() || "How can I help?",
    quick_replies: quick,
    state: nextState,
  };
}

/* ========================= CORE POST HANDLER ========================= */
async function handleCorePOST(req, res) {
  try {
    const body = req.body || {};
    const user = extractUserText(body);

    let state = body.state ?? {};
    if (typeof state === "string") {
      try {
        state = JSON.parse(state);
      } catch {
        state = {};
      }
    }

    // hydrate from state_json if needed
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
    ensureHistory(state);

    const fromManyChat = body.channel === "messenger" || body.source === "manychat";
    const originalJson = typeof res.json === "function" ? res.json.bind(res) : null;

    // Response writer compatible with ManyChat + Web widget
    if (originalJson) {
      res.json = (data) => {
        let out = data == null ? {} : typeof data === "string" ? { reply: data } : { ...data };
        if (out.state === undefined) out.state = state;

        const v2 = toManyChatV2(out);
        if (fromManyChat) return originalJson(v2);

        out.state_json = v2.state_json;
        out.reply_text = v2.reply_text || (typeof out.reply === "string" ? out.reply : "");
        return originalJson(out);
      };
    }

    // INIT / first-load handling — prompt drives greeting
    if (body.init || (!user && !state._started)) {
      const initCall = await callOpenAI("__INIT__", { ...state, _started: true });
      const merged =
        initCall.state && typeof initCall.state === "object" ? { ...state, ...initCall.state } : state;
      merged._started = true;

      // Save assistant output into history (so Vercel follows OpenAI prompt behavior)
      appendHistory(merged, "user", "__INIT__");
      appendHistory(merged, "assistant", initCall.reply);

      // Normalize (safe) so state stays consistent from the beginning
      normalizeStateForZapier(merged);

      return res.status(200).json({
        reply: initCall.reply,
        quickReplies: initCall.quick_replies,
        state: merged,
      });
    }

    if (!user) {
      // Empty message: just reprompt safely
      const emptyCall = await callOpenAI("Hi", state);
      const merged =
        emptyCall.state && typeof emptyCall.state === "object" ? { ...state, ...emptyCall.state } : state;

      appendHistory(merged, "user", "Hi");
      appendHistory(merged, "assistant", emptyCall.reply);

      normalizeStateForZapier(merged);

      return res.status(200).json({
        reply: emptyCall.reply,
        quickReplies: emptyCall.quick_replies,
        state: merged,
      });
    }

    // Track transition to booking_complete for optional safety flags
    const wasBookingComplete = !!state.booking_complete;

    // Main: OpenAI drives everything
    const result = await callOpenAI(user, state);

    const nextState =
      result.state && typeof result.state === "object" && !Array.isArray(result.state)
        ? { ...state, ...result.state }
        : state;

    // Normalize state BEFORE history + Zapier sends (this is the Zapier blank-field fix)
    normalizeStateForZapier(nextState);

    // Append to history (THIS is what makes Vercel match Prompt Editor behavior)
    appendHistory(nextState, "user", user);
    appendHistory(nextState, "assistant", result.reply);

    // Zapier automation:
    // - Session Zap once we have name + phone (and haven't sent)
    // - Booking Zap once booking_complete true (and haven't sent)
    const bookingComplete = !!nextState.booking_complete;

    // Optional: if booking just became complete and model forgot to set upsell flag, keep it false.
    if (!wasBookingComplete && bookingComplete && typeof nextState.post_booking_upsell_done !== "boolean") {
      nextState.post_booking_upsell_done = false;
    }

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
      quickReplies: result.quick_replies,
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

        // Normalize before saving too (keeps PSID state clean)
        normalizeStateForZapier(nextState);

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
