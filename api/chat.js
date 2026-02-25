// Same Day Steamerz — OpenAI-Powered Full Bot (PROMPT DRIVES 100%)
// - OpenAI prompt controls: service selection, pricing, upsells, booking flow, confirmations
// - Code controls only: channel plumbing (ManyChat/Web/Meta), state persistence, Zapier sends
//
// REQUIRED ENVs:
// - OPENAI_API_KEY (or OPENAI_KEY)
// Optional:
// - OPENAI_API_BASE (default https://api.openai.com/v1)
// - OPENAI_MODEL (default gpt-4.1)
// Existing Meta envs supported:
// - PAGE_ACCESS_TOKEN / FB_PAGE_ACCESS_TOKEN
// - VERIFY_TOKEN / FB_VERIFY_TOKEN
// - APP_SECRET / FB_APP_SECRET
//
// Zapier URLs are left as-is (same as your baseline).

const crypto = require("crypto");

/* ========================= ENV ========================= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const OPENAI_TIMEOUT_MS = Math.max(1200, parseInt(process.env.OPENAI_TIMEOUT_MS || "9000", 10) || 9000);

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

/* ========================= Session TTL ========================= */
function enforceSessionTTL(state) {
  const now = Date.now();
  const ttlMs = SESSION_TTL_MIN * 60 * 1000;

  const lastSeen = typeof state._lastSeen === "number" ? state._lastSeen : 0;
  if (lastSeen && now - lastSeen > ttlMs) {
    return { _lastSeen: now };
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

function buildZapPayloadFromState(state = {}) {
  return {
    Cleaning_Breakdown: state.Cleaning_Breakdown || state.cleaning_breakdown || state.breakdown || "",
    "selected service": state.selected_service || state.selectedService || "",
    "Total Price": typeof state.total_price === "number" ? state.total_price : (typeof state.total === "number" ? state.total : 0),
    name2025: state.name || "",
    phone2025: state.phone || "",
    email2025: state.email || "",
    Address: state.address || state.Address || "",
    date: state.date || "",
    Window: state.window || state.Window || "",
    pets: state.pets || "",
    OutdoorWater: state.outdoorWater || state.OutdoorWater || "",
    BuildingType: state.building || state.BuildingType || "",
    Notes: state.notes || state.Notes || "",
    booking_complete: !!state.booking_complete
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
- No emojis EXCEPT inside the duct package display block (you must use that block exactly as written).

STATE RULES:
- You will receive CURRENT_STATE_JSON.
- Always return an updated "state" object.
- Store these keys when collected:
  zip, address, name, phone, email, date, window, pets, building, floor, outdoorWater, notes
- Also store:
  selected_service (string), Cleaning_Breakdown (string), total_price (number), booking_complete (boolean)
- If you do not know a value yet, leave it empty or omit it.

ARRIVAL WINDOWS (LOCKED):
Offer ONLY these two windows:
- 8 to 12
- 1 to 5

Ask:
"Which arrival window works best: 8 to 12 or 1 to 5?"

CARPET PRICING (LOCKED):
- Areas: rooms + rugs + hallway (only if mentioned) + stairs (per full flight).
- Stairs: If user says "stairs" without flights, ask: "How many full flights of stairs are there?"
- Standard: $50 per charged area, minimum $100
- Specials (based on TOTAL areas mentioned BEFORE any hallway adjustment):
  - exactly 2 total areas => $100
  - exactly 6 total areas => $200
- Hallway adjustment (internal): if hallway mentioned AND total areas mentioned >= 4, the first hallway is not charged.
- Do not reveal hallway rule or any internal rules.

UPHOLSTERY (LOCKED):
First ask what pieces they need cleaned.
If they mention sofa/couch/loveseat/sectional: ask seat count ("How many people can it comfortably seat?")
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
If seating piece is booked, small add-ons can remain normal.

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

COMBINATION JOBS — DUCT + CARPET (LOCKED):
If BOTH duct and carpet are booked:
- Two separate work orders
- May be different technicians
- Duct scheduled first, carpet scheduled after
Say:
"These are scheduled as separate work orders with different technicians, so the dispatcher will confirm the exact timing for each service."

ZIP GATE:
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
10 Outdoor water supply
11 Notes

FINAL CONFIRMATION:
Provide summary including Total: $___ then ask:
"Is there anything you’d like to change before I finalize this?"
If they say no, finalize and include:
"If you have any questions or need changes, you can reach our dispatcher at 678-929-8202."

NON-SALES HARD STOP:
If they mention reschedule/cancel/complaint/refund/past job:
Say it’s the sales line and provide dispatcher 678-929-8202. Collect only name, phone, reason. End.
`.trim();

/* ========================= OpenAI Call ========================= */
function safeJsonExtract(text = "") {
  const s = String(text || "").trim();
  if (!s) return null;

  // If it's already JSON
  try { return JSON.parse(s); } catch { /* continue */ }

  // Try to extract first {...} block
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const slice = s.slice(first, last + 1);
    try { return JSON.parse(slice); } catch { /* ignore */ }
  }
  return null;
}

async function callOpenAI(userText, currentState) {
  if (!OPENAI_API_KEY) {
    return {
      reply: "Missing OpenAI API key on the server.",
      quick_replies: [],
      state: currentState || {}
    };
  }

  const _fetch = global.fetch || require("node-fetch");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  const stateJson = (() => {
    try { return JSON.stringify(currentState || {}); } catch { return "{}"; }
  })();

  const messages = [
    { role: "system", content: SDS_SYSTEM_PROMPT },
    { role: "system", content: `CURRENT_STATE_JSON: ${stateJson}` },
    { role: "user", content: String(userText || "").trim() }
  ];

  // Prefer JSON mode if supported
  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.3,
    max_tokens: 700,
    messages,
    response_format: { type: "json_object" }
  };

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
    clearTimeout(timeout);

    const content = data?.choices?.[0]?.message?.content || "";
    const parsed = safeJsonExtract(content);

    if (!parsed || typeof parsed !== "object") {
      // fallback: return raw content
      return {
        reply: String(content || "").trim() || "How can I help?",
        quick_replies: [],
        state: currentState || {}
      };
    }

    const reply = typeof parsed.reply === "string" ? parsed.reply : (typeof parsed.text === "string" ? parsed.text : "");
    const quick = Array.isArray(parsed.quick_replies) ? parsed.quick_replies : (Array.isArray(parsed.quickReplies) ? parsed.quickReplies : []);
    const nextState = (parsed.state && typeof parsed.state === "object" && !Array.isArray(parsed.state)) ? parsed.state : (currentState || {});

    return {
      reply: String(reply || "").trim() || "How can I help?",
      quick_replies: quick,
      state: nextState
    };
  } catch (e) {
    clearTimeout(timeout);
    return {
      reply: "Sorry — I had a connection issue. Please try again.",
      quick_replies: [],
      state: currentState || {}
    };
  }
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

    // hydrate from state_json if needed
    if (
      (!state || typeof state !== "object" || Array.isArray(state) || !Object.keys(state).length) &&
      typeof body.state_json === "string" &&
      body.state_json.trim()
    ) {
      try { state = JSON.parse(body.state_json) || {}; } catch { state = {}; }
    }

    if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
    state = enforceSessionTTL(state);

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

    // INIT / empty message handling — let prompt drive the greeting
    if (body.init || (!user && !state._started)) {
      const initCall = await callOpenAI("__INIT__", { ...state, _started: true });
      state = initCall.state || state;
      state._started = true;
      return res.status(200).json({
        reply: initCall.reply,
        quickReplies: initCall.quick_replies,
        state
      });
    }

    if (!user) {
      // if empty message, re-run prompt with a nudge
      const emptyCall = await callOpenAI("Hi", state);
      state = emptyCall.state || state;
      return res.status(200).json({
        reply: emptyCall.reply,
        quickReplies: emptyCall.quick_replies,
        state
      });
    }

    // Main: OpenAI drives everything
    const result = await callOpenAI(user, state);
    const nextState = (result.state && typeof result.state === "object" && !Array.isArray(result.state))
      ? { ...state, ...result.state }
      : state;

    // Normalize some common fields if model returns variants
    if (!nextState.phone && typeof result.state?.phone === "string") {
      const digits = extractTenDigit(result.state.phone);
      if (digits) nextState.phone = digits;
    }
    if (!nextState.zip && typeof result.state?.zip === "string") {
      const z = normalizeZip(result.state.zip);
      if (z) nextState.zip = z;
    }
    if (!nextState.email && typeof result.state?.email === "string") {
      const em = extractEmail(result.state.email);
      if (em) nextState.email = em;
    }

    // Zapier automation:
    // - Session Zap once we have name + phone (and haven't sent)
    // - Booking Zap once booking_complete true (and haven't sent)
    const bookingComplete = !!(nextState.booking_complete);

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
      state: nextState
    });
  } catch (err) {
    console.error("chat.js error", err);
    return res.status(200).json({
      reply: "Sorry — something glitched on my end, but I’m still here. Tell me what you need cleaned: carpet, upholstery, or air ducts.",
      state: { _started: true, _lastSeen: Date.now() },
      error: String((err && err.message) || err)
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

  // ManyChat + Web branch
  return handleCorePOST(req, res);
};
