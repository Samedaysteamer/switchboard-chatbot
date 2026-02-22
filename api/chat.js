// Same Day Steamerz — robust ManyChat + Web handler (UPDATED)
// - Keeps your existing ManyChat + Web widget behavior
// - Adds DIRECT Meta Messenger Webhook support (object:"page") with PSID state persistence + Send API replies
// - Always includes state (object) AND state_json (string) for ManyChat mapping
// - Adds reply_text (string) so you can map the next prompt into a text block
// - Safe input extraction + ManyChat v2 auto-wrapper (Messenger)
// - Fallback: if user typed but state.step missing, jump to choose_service
//
// ✅ LOCKED FIXES (DO NOT TOUCH):
// - ZIP gate before address (collect_zip + Set validation)
// - Bundle discount logic ($50 off upholstery only when added via carpet upsell)
// - Duct base pricing math
//
// ✅ SURGICAL FIXES IN THIS VERSION (ONLY):
// A) Duct: “No add-ons” must NOT trigger dryer add-on (anchored/exact match)
// B) Upholstery: Sofa/Loveseat asks cushions WITHOUT internal rule text; 4+ cushions => sectional pricing
// C) Price confirms: remove “Skip” quick replies (duct_confirm + upholstery_confirm)

const crypto = require("crypto");

const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

function wordsToNumber(v = "") {
  const t = String(v || "").toLowerCase().replace(/-/g, " ").trim();
  if (/^\d+$/.test(t)) return +t;

  let total = 0, current = 0;
  for (const w of t.split(/\s+/)) {
    if (SMALL[w] != null) { current += SMALL[w]; continue; }
    if (TENS[w] != null) { current += TENS[w]; continue; }
    if (w === "hundred") { current *= 100; continue; }
    if (/^(and|a)$/.test(w)) continue;
    if (current) { total += current; current = 0; }
  }
  return total + current || 0;
}

const numFromText = (s = "") => {
  const m = String(s || "").match(/\d+/);
  return m ? +m[0] : wordsToNumber(s);
};

const isQuestion = (t = "") => {
  const s = String(t || "").trim();
  return /\?$/.test(s) || /^(what|when|how|who|where|why|do|does|can|is|are|should|could|would|am i|are y)\b/i.test(s);
};

// ZIP helpers
function normalizeZip(input = "") {
  const m = String(input || "").match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

/* ========================= Data ========================= */
let validZipCodes = null;

// this file lives in /api, so ./zips.js is the correct local import
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

const SERVICE_CHOICES = ["Carpet Cleaning", "Upholstery Cleaning", "Air Duct Cleaning"];
const UPH_CHOICES = ["Sectional", "Sofa", "Loveseat", "Recliner", "Ottoman", "Dining chair", "Mattress"];

// arrival windows (locked)
const TIME_WINDOWS = ["8 to 12", "1 to 5"];

function normalizeWindow(input = "") {
  const t = String(input || "").toLowerCase().replace(/\s+/g, " ").trim();

  if (/(^|\b)8\s*(?:am)?\s*(?:-|to|–)\s*12\s*(?:pm)?(\b|$)/.test(t)) return "8 to 12";
  if (/\b8\s*to\s*12\b/.test(t)) return "8 to 12";

  if (/(^|\b)1\s*(?:pm)?\s*(?:-|to|–)\s*5\s*(?:pm)?(\b|$)/.test(t)) return "1 to 5";
  if (/\b1\s*to\s*5\b/.test(t)) return "1 to 5";

  return "";
}

const UPH_PRICES = { loveseat: 100, recliner: 80, ottoman: 50, "dining chair": 25, sofa: 150, mattress: 150 };

/* ========================= Bundle Discount (locked) ========================= */
function bundleDiscount(state = {}) {
  const hasCarpet = !!(state.carpet && typeof state.carpet.price === "number" && state.carpet.price > 0);
  const hasUph = !!(state.upholstery && typeof state.upholstery.total === "number" && state.upholstery.total > 0);
  const eligible = !!state.addingUphAfterCarpet;
  return (eligible && hasCarpet && hasUph) ? 50 : 0;
}

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
    console.error("Missing FB_PAGE_ACCESS_TOKEN (required for direct Messenger replies).");
    return;
  }
  const _fetch = global.fetch || require("node-fetch");
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(FB_PAGE_ACCESS_TOKEN)}`;

  const msg = { text: String(text || "").trim() || " " };
  const qr = toFBQuickReplies(quickReplies);
  if (qr) msg.quick_replies = qr;

  try {
    await _fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_type: "RESPONSE",
        recipient: { id: psid },
        message: msg
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

/* ========================= Duct copy ========================= */
function ductIntroCopy() {
  return (
    `Air Duct Cleaning — What you get

1) Basic — $200 per system
• Cleans all supply vents/branches with negative-pressure HEPA vacuum.

2) Deep — $500 per system
• Everything in Basic plus the return side + trunks, register cleaning, and EPA sanitizer fogged in ducts.

Ready to choose a package?`
  );
}

function furnaceAddOnCopy(pkg) {
  const add = pkg === "Deep" ? "+$100" : "+$200";
  return (
    `Furnace Cleaning — add-on (${add} per system)
We open the main return cabinet, remove buildup, and sanitize. Add it now?`
  );
}

const dryerVentCopy =
  `Dryer Vent Cleaning — $200
Helps prevent dryer fires, improves airflow, and shortens dry times. Add dryer vent cleaning?`;

/* ========================= Pricing (Carpet) ========================= */
function computeCarpetTotals(detail) {
  const d = { rooms: 0, halls: 0, stairs: 0, extras: 0, rugs: 0, ...detail };

  const totalAreasBeforeFreebie = d.rooms + d.halls + d.stairs + d.extras + d.rugs;

  const freeHall = (totalAreasBeforeFreebie >= 4 && d.halls > 0) ? 1 : 0;
  const freeRoom = (totalAreasBeforeFreebie >= 6 && d.rooms > 0) ? 1 : 0;

  const chargeableRooms = Math.max(0, d.rooms - freeRoom);
  const chargeableHalls = Math.max(0, d.halls - freeHall);

  const billable = chargeableRooms + chargeableHalls + d.stairs + d.extras + d.rugs;
  let price = Math.max(100, billable * 50);

  if (d.rooms === 2 && d.halls === 1 && d.stairs === 0 && d.extras === 0 && d.rugs === 0) {
    price = 100;
  }

  const parts = [];
  if (d.rooms) parts.push(`${d.rooms} room${d.rooms > 1 ? "s" : ""}${freeRoom ? " (1 free)" : ""}`);
  if (d.halls) parts.push(`${d.halls} hallway${d.halls > 1 ? "s" : ""}${freeHall ? " (1 free)" : ""}`);
  if (d.stairs) parts.push(`${d.stairs} flight${d.stairs > 1 ? "s" : ""} of stairs`);
  if (d.rugs) parts.push(`${d.rugs} rug${d.rugs > 1 ? "s" : ""}`);
  if (d.extras) parts.push(`${d.extras} extra area${d.extras > 1 ? "s" : ""}`);

  return {
    billable,
    price,
    describedText: parts.join(", "),
    detail: { ...d, freeHall, freeRoom }
  };
}

function parseAreas(text = "") {
  const t = String(text || "").toLowerCase();

  let rooms = 0;
  for (const m of t.matchAll(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s*(?:rooms?|bedrooms?)/g)) {
    rooms += numFromText(m[1]);
  }
  if (rooms === 0 && /\brooms?\b/.test(t)) rooms = 1;

  let halls = 0;
  const mh = t.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*hall(?:way|ways)?/);
  if (mh) halls = numFromText(mh[1]);
  else if (/\bhall(?:way|ways)?\b/.test(t)) halls = 1;

  let stairs = 0;
  const ms = t.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:flights?|stairs?)/);
  if (ms) stairs = numFromText(ms[1]);
  else if (/\b(?:flights?|stairs?)\b/.test(t)) stairs = 1;

  let rugs = 0;
  const mr = t.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:area\s*)?rugs?\b/);
  if (mr) rugs = numFromText(mr[1]);
  else if (/\b(?:area\s*)?rugs?\b/.test(t)) rugs = 1;

  let extras = 0;
  const extraPatterns = [
    "living room", "family room", "great room", "den", "bonus room",
    "recreation room", "rec room", "game room", "media room", "theater room",
    "dining room", "breakfast nook", "sunroom", "solarium", "mudroom",
    "guest room", "nursery", "office", "home office", "loft", "study",
    "library", "playroom", "man cave", "gym", "exercise room"
  ];
  for (const name of extraPatterns) {
    const rxCount = new RegExp(`(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+${name}`, "i");
    const rxSingle = new RegExp(`\\b${name}\\b`, "i");
    const m = t.match(rxCount);
    if (m) extras += numFromText(m[1]);
    else if (rxSingle.test(t)) extras++;
  }

  return computeCarpetTotals({ rooms, halls, stairs, extras, rugs });
}

/* ========================= Upholstery ========================= */
function priceUphFromItems(items) {
  let total = 0;
  let hasSectional = false;
  const breakdown = [];

  for (const it of items) {
    if (it.type === "sectional") {
      hasSectional = true;
      const seats = it.seats || 0;
      const secPrice = Math.max(250, seats ? seats * 50 : 250);
      total += secPrice;
      breakdown.push(`${seats ? `${seats}-seat ` : ""}sectional`);
    } else {
      const each = UPH_PRICES[it.type] || 0;
      const count = it.count || 1;
      total += each * count;

      if ((it.type === "sofa" || it.type === "loveseat") && it.seats && count === 1) {
        breakdown.push(`${it.type} (${it.seats} cushion${it.seats > 1 ? "s" : ""})`);
      } else {
        breakdown.push(`${count} ${it.type}${count > 1 ? "s" : ""}`);
      }
    }
  }

  if (!hasSectional) total = Math.max(150, total);
  return { total, breakdown, items };
}

function parseUph(text = "") {
  const t = String(text || "").toLowerCase();
  const items = [];

  if (/\bsectional\b/.test(t)) {
    const ms = t.match(/sectional[^0-9]*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)/);
    const seats = ms ? numFromText(ms[1]) : 0;
    items.push({ type: "sectional", seats });
  }

  for (const key of ["sofa", "loveseat", "recliner", "ottoman", "dining chair", "mattress"]) {
    const rx = key === "dining chair"
      ? /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:dining\s+)?chairs?/i
      : new RegExp(`(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s*${key}s?`, "i");

    const m = t.match(rx);
    if (m) {
      items.push({ type: key, count: numFromText(m[1]) });
    } else if (new RegExp(`\\b${key}s?\\b`, "i").test(t)) {
      items.push({ type: key, count: 1 });
    }
  }

  return items.length ? priceUphFromItems(items) : { total: 0, breakdown: [], items: [] };
}

/* ========================= Booking summary + Zap helpers ========================= */
function formatPhone(digits) {
  return (digits && digits.length === 10)
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : (digits || "");
}

function subtotalPrice(state) {
  return (state.carpet?.price || 0) + (state.upholstery?.total || 0) + (state.duct?.total || 0);
}

function totalPriceForZap(state) {
  const subtotal = subtotalPrice(state);
  const discount = bundleDiscount(state);
  return Math.max(0, subtotal - discount);
}

function buildCleaningBreakdownForZap(state) {
  const lines = [];
  if (state.carpet) lines.push(`Carpet — ${state.carpet.billable} area(s) (${state.carpet.describedText}) — $${state.carpet.price}`);
  if (state.upholstery) lines.push(`Upholstery — ${state.upholstery.breakdown?.join(", ") || ""} — $${state.upholstery.total}`);
  if (state.duct) {
    const furn = state.duct.add?.furnace ? ", +furnace" : "";
    const dry = state.duct.add?.dryer ? ", +dryer vent" : "";
    lines.push(`Duct — ${state.duct.pkg} (${state.duct.systems} system${state.duct.systems > 1 ? "s" : ""}${furn}${dry}) — $${state.duct.total}`);
  }
  return lines.join("\n");
}

function selectedServiceForZap(state) {
  const s = [];
  if (state.carpet) s.push("Carpet");
  if (state.upholstery) s.push("Upholstery");
  if (state.duct) s.push("Air Duct");
  return s.join(" + ");
}

function encodeForm(data) {
  return Object.keys(data)
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? ""))
    .join("&");
}

function bookingSummary(state) {
  const parts = [];
  if (state.carpet) parts.push(`Carpet — ${state.carpet.billable} area(s) (${state.carpet.describedText}) — $${state.carpet.price}`);
  if (state.upholstery) parts.push(`Upholstery — ${state.upholstery.breakdown?.join(", ") || ""} — $${state.upholstery.total}`);
  if (state.duct) {
    const furn = state.duct.add?.furnace ? ", +furnace" : "";
    const dry = state.duct.add?.dryer ? ", +dryer vent" : "";
    parts.push(`Duct — ${state.duct.pkg} (${state.duct.systems} system${state.duct.systems > 1 ? "s" : ""}${furn}${dry}) — $${state.duct.total}`);
  }

  const subtotal = subtotalPrice(state);
  const discount = bundleDiscount(state);
  const total = Math.max(0, subtotal - discount);
  const discountLine = discount ? `Bundle discount: -$${discount}\n` : "";

  return `Booking summary
${parts.join("\n")}
${discountLine}Total: $${total}

Name: ${state.name || "-"}
Phone: ${state.phone ? formatPhone(state.phone) : "-"}
Email: ${state.email || "-"}
Address: ${state.address || "-"}
Preferred Day: ${state.date || "-"}
Arrival Time: ${state.window || "-"}
Pets: ${state.pets || "-"}   Outdoor Water: ${state.outdoorWater || "-"}
Building: ${state.building || "-"}${state.floor ? ` (Floor ${state.floor})` : ""}
Notes: ${state.notes || "-"}

If you need to make changes, reply back here and we’ll update the work order.`;
}

/* ========================= Follow-up flags ========================= */
function armFollowUp(state, minutes = 10) {
  const ms = Math.max(5, minutes) * 60 * 1000;
  state._followUpArmed = true;
  state._followUpDueAt = Date.now() + ms;
}
function disarmFollowUp(state) {
  state._followUpArmed = false;
  state._followUpDueAt = 0;
}
function hasContact(state) {
  return !!(state.name && state.phone && /^\d{10}$/.test(state.phone));
}

async function sendSessionIfEligible(state, reason) {
  if (!hasContact(state)) return;
  if (state._sessionSent) return;

  const payload = {
    Cleaning_Breakdown: buildCleaningBreakdownForZap(state),
    "selected service": selectedServiceForZap(state),
    "Total Price": totalPriceForZap(state),
    name2025: state.name || "",
    phone2025: state.phone || "",
    email2025: state.email || "",
    Address: state.address || "",
    date: state.date || "",
    Window: state.window || "",
    pets: state.pets || "",
    OutdoorWater: state.outdoorWater || "",
    BuildingType: state.building || "",
    Notes: state.notes || "",
    booking_complete: false,
    conversation: reason ? `Reason: ${reason}` : ""
  };

  try {
    await sendSessionZapFormEncoded(payload);
    state._sessionSent = true;
  } catch (e) {
    console.error("Session Zap failed", e);
  }
}

function refreshFollowUpIfEligible(state) {
  if (hasContact(state) && state.step !== "collect_notes") {
    armFollowUp(state, 10);
  }
}

/* ========================= Reuse prompts ========================= */
const normalizeDigits = (s = "") => String(s).replace(/\D+/g, "");
const displayAddress = s => s.Address || s.address || "";
const displayName = s => s.name2025 || s.name || "";
const displayEmail = s => s.email2025 || s.email || "";
const displayPhone = s => normalizeDigits(s.phone2025 || s.phone || "");

function promptZip(state) {
  state.step = "collect_zip";
  return { reply: "What’s the ZIP code for the service location?", state };
}

function promptAddress(state) {
  if (!state.zipVerified) {
    if (state.zip && zipInArea(state.zip)) {
      state.zipVerified = true;
    } else {
      return promptZip(state);
    }
  }

  const addr = displayAddress(state);
  if (addr) {
    state.step = "confirm_reuse_address";
    return { reply: `Use this service address?\n${addr}`, quickReplies: ["Yes", "No"], state };
  }
  state.step = "collect_address";
  return { reply: "What’s the full service address? (street + city + state — ZIP optional)", state };
}

function promptName(state) {
  const name = displayName(state);
  if (name) {
    state.step = "confirm_reuse_name";
    return { reply: `Use this name? ${name}`, quickReplies: ["Yes", "No"], state };
  }
  state.step = "collect_name";
  return { reply: "What’s your full name? (First and last name)", state };
}

function promptPhone(state) {
  const digits = displayPhone(state);
  if (digits && /^\d{10}$/.test(digits)) {
    state.step = "confirm_reuse_phone";
    return { reply: `Use this phone number? ${formatPhone(digits)}`, quickReplies: ["Yes", "No"], state };
  }
  state.step = "collect_phone";
  return { reply: "What’s the best phone number to reach you?", state };
}

function promptEmail(state) {
  const email = displayEmail(state);
  if (email) {
    state.step = "confirm_reuse_email";
    return { reply: `Use this email? ${email}`, quickReplies: ["Yes", "No"], state };
  }
  state.step = "collect_email";
  return { reply: "What’s your email address?", state };
}

/* ========================= Intro ========================= */
function intro() {
  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return {
    reply: `${hello}! Are you looking for carpet cleaning, upholstery cleaning, or air duct cleaning service?`,
    quickReplies: SERVICE_CHOICES,
    state: { step: "choose_service", faqLog: [] }
  };
}

/* ========== ManyChat v2 formatter (for messenger only) ========== */
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

  if (payload && payload.error != null) out.error = payload.error;
  if (payload && payload.intentHandled) out.intentHandled = payload.intentHandled;

  return out;
}

/* ========================= Reprompt (fallback prompts) ========================= */
function repromptForStep(state = {}) {
  const s = state.step || "";
  switch (s) {
    case "upholstery_confirm":
      // ✅ FIX C: no Skip button
      return { reply: "Proceed with upholstery?", quickReplies: ["Proceed", "Change items"], state };

    case "duct_confirm":
      // ✅ FIX C: no Skip button
      return { reply: "Proceed?", quickReplies: ["Proceed", "Change"], state };

    default:
      return intro();
  }
}

/* ========================= CORE POST HANDLER (ManyChat + Web) ========================= */
async function handleCorePOST(req, res) {
  try {
    const body = req.body || {};

    const userRaw =
      (typeof body.text === "string" && body.text) ||
      (typeof body.message === "string" && body.message) ||
      (typeof body?.message?.text === "string" && body.message.text) ||
      (typeof body.input === "string" && body.input) ||
      (typeof body.payload === "string" && body.payload) ||
      (typeof body.content === "string" && body.content) ||
      "";

    const user = String(userRaw || "").trim();
    const msg = user.toLowerCase();

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
    if (!Array.isArray(state.faqLog)) state.faqLog = [];

    const fromManyChat = (body.channel === "messenger") || (body.source === "manychat");
    const originalJson = res.json.bind(res);

    res.json = (data) => {
      try {
        let out = (data == null) ? {} : (typeof data === "string" ? { reply: data } : { ...data });
        if (out.state === undefined) out.state = state;

        const v2 = toManyChatV2(out);

        if (fromManyChat) return originalJson(v2);

        out.state_json = v2.state_json;
        out.reply_text = v2.reply_text || (typeof out.reply === "string" ? out.reply : "");
        return originalJson(out);
      } catch {
        return originalJson({ reply: "", state });
      }
    };

    if (body.init || (!user && !state.step)) {
      return res.status(200).json(intro());
    }

    if (!state.step && user) {
      return res.status(200).json(intro());
    }

    if (!user) {
      return res.status(200).json(repromptForStep(state));
    }

    // minimal pre-booking summary (unchanged)
    function preBookingSummary(st) {
      const parts = [];
      if (st.carpet) parts.push(`Carpet — ${st.carpet.billable} area(s) (${st.carpet.describedText}) — $${st.carpet.price}`);
      if (st.upholstery) parts.push(`Upholstery — $${st.upholstery.total} — ${st.upholstery.breakdown?.join(", ") || ""}`);
      if (st.duct) {
        const furn = st.duct.add?.furnace ? ", +furnace" : "";
        const dry = st.duct.add?.dryer ? ", +dryer vent" : "";
        parts.push(`Duct — ${st.duct.pkg} (${st.duct.systems} system${st.duct.systems > 1 ? "s" : ""}${furn}${dry}) — $${st.duct.total}`);
      }

      const subtotal = subtotalPrice(st);
      const discount = bundleDiscount(st);
      const total = Math.max(0, subtotal - discount);
      const discountLine = discount ? `Bundle discount: -$${discount}\n` : "";

      return `*Quick summary so far*

${parts.join("\n")}
${discountLine}Combined total: $${total}

Proceed with booking?`;
    }

    switch (state.step) {
      case "choose_service": {
        let choice = null;
        if (/duct|air\s*duct/.test(msg)) choice = "duct";
        if (/(upholstery|sectional|sofa|loveseat|recliner|ottoman|chair|mattress)/.test(msg)) choice = "upholstery";
        if (/(carpet|rooms?|hall|stairs|flight|rugs?)/.test(msg)) choice = "carpet";
        if (!choice) return res.status(200).json({ reply: "Please choose a service.", quickReplies: SERVICE_CHOICES, state });

        if (choice === "carpet") {
          state.step = "carpet_details";
          return res.status(200).json({ reply: "What areas would you like us to clean? (e.g., “3 rooms, hallway, stairs”).", state });
        }
        if (choice === "upholstery") {
          state.step = "upholstery_details";
          return res.status(200).json({ reply: "What upholstery pieces would you like cleaned?", quickReplies: UPH_CHOICES, state });
        }
        state.step = "duct_package";
        return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic", "Deep"], state });
      }

      case "carpet_details": {
        const parsed = parseAreas(user);
        if (parsed.billable === 0) {
          return res.status(200).json({ reply: "Please describe the carpet areas again (e.g., “4 rooms, 1 hallway, stairs”).", state });
        }
        state.carpet = parsed;
        state.step = "carpet_confirm";
        return res.status(200).json({
          reply: `For ${parsed.billable} area(s) (${parsed.describedText}) the total is **$${parsed.price}**.\n\nMove forward with carpet?`,
          quickReplies: ["Yes, move forward", "Change areas", "No, not now"],
          state
        });
      }

      case "carpet_confirm": {
        if (/change/i.test(msg)) {
          state.step = "carpet_details";
          return res.status(200).json({ reply: "No problem — tell me the carpet areas again.", state });
        }
        if (/no|not now|skip/i.test(msg)) {
          const keepFaq = state.faqLog;
          state = { step: "choose_service", faqLog: keepFaq };
          return res.status(200).json({
            reply: "All good – if you’d like a quote later just say “carpet”, “upholstery”, or “ducts”.",
            quickReplies: SERVICE_CHOICES,
            state
          });
        }
        if (state.upholstery?.total || state.duct?.total) {
          state.step = "confirm_combined_proceed";
          return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
        }
        state.step = "uph_upsell_offer";
        return res.status(200).json({
          reply: "Nice — since you’re booking carpet, you’re eligible for **$50 off upholstery**. Want to add upholstery cleaning?",
          quickReplies: ["Yes, add upholstery", "No, skip"],
          state
        });
      }

      case "uph_upsell_offer": {
        if (/no|skip/i.test(msg)) return res.status(200).json(promptAddress(state));
        state.addingUphAfterCarpet = true;
        state.step = "upholstery_details";
        return res.status(200).json({ reply: "Great — what upholstery pieces would you like cleaned?", quickReplies: UPH_CHOICES, state });
      }

      case "upholstery_details": {
        // ✅ FIX B: Cushion gate for Sofa/Loveseat (no internal rule text)
        if (/\bsofa\b/i.test(user) && !/\d/.test(user)) {
          state.step = "upholstery_cushions";
          state._cushionTarget = "sofa";
          state._cushionContext = user;
          return res.status(200).json({
            reply: "For the sofa — how many seat cushions does it have?",
            quickReplies: ["1", "2", "3", "4", "5", "6", "7"],
            state
          });
        }
        if (/\bloveseat\b/i.test(user) && !/\d/.test(user)) {
          state.step = "upholstery_cushions";
          state._cushionTarget = "loveseat";
          state._cushionContext = user;
          return res.status(200).json({
            reply: "For the loveseat — how many seat cushions does it have?",
            quickReplies: ["1", "2", "3", "4", "5", "6", "7"],
            state
          });
        }

        // existing sectional seat prompt stays (if user types "sectional" without number)
        if (/\bsectional\b/i.test(user) && !/\d/.test(user)) {
          state.step = "upholstery_sectional_seats";
          return res.status(200).json({ reply: "For the sectional — how many seats/cushions?", quickReplies: ["3", "4", "5", "6", "7"], state });
        }

        const parsed = parseUph(user);
        if (!parsed.breakdown.length) {
          return res.status(200).json({
            reply: "Please list pieces like “sectional 6 seats”, “two recliners”, or “sofa and ottoman”.",
            quickReplies: UPH_CHOICES,
            state
          });
        }

        state.upholstery = { total: parsed.total, breakdown: parsed.breakdown };
        state.step = "upholstery_confirm";

        // ✅ FIX C: no Skip button
        return res.status(200).json({
          reply: `Your upholstery total is **$${parsed.total}** for ${parsed.breakdown.join(", ")}.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items"],
          state
        });
      }

      case "upholstery_cushions": {
        const seats = numFromText(msg);
        if (!seats) {
          return res.status(200).json({
            reply: "How many seat cushions does it have?",
            quickReplies: ["1", "2", "3", "4", "5", "6", "7"],
            state
          });
        }

        const target = (state._cushionTarget || "sofa").toLowerCase();
        const ctx = (state._cushionContext || "").toLowerCase();
        const rest = ctx.replace(new RegExp(`\\b${target}\\b`, "i"), "").trim();
        const restParsed = rest ? parseUph(rest) : { items: [] };

        // ✅ FIX B: 4+ cushions => sectional pricing
        let baseItem;
        if (seats >= 4) {
          baseItem = { type: "sectional", seats };
        } else if (target === "loveseat" && seats === 3) {
          baseItem = { type: "sofa", count: 1, seats };
        } else {
          baseItem = { type: target, count: 1, seats };
        }

        const combined = priceUphFromItems([baseItem, ...(restParsed.items || [])]);

        state.upholstery = { total: combined.total, breakdown: combined.breakdown };
        state._cushionTarget = null;
        state._cushionContext = null;

        state.step = "upholstery_confirm";

        // ✅ FIX C: no Skip button
        return res.status(200).json({
          reply: `Your upholstery total is **$${combined.total}** for ${combined.breakdown.join(", ")}.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items"],
          state
        });
      }

      case "upholstery_sectional_seats": {
        const seats = numFromText(msg);
        if (!seats) return res.status(200).json({ reply: "How many seats? (e.g., 4, 5, 6)", quickReplies: ["3", "4", "5", "6", "7"], state });

        const merged = priceUphFromItems([{ type: "sectional", seats }]);
        state.upholstery = { total: merged.total, breakdown: merged.breakdown };
        state.step = "upholstery_confirm";

        // ✅ FIX C: no Skip button
        return res.status(200).json({
          reply: `Your sectional price is **$${merged.total}**.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items"],
          state
        });
      }

      case "upholstery_confirm": {
        if (/change/i.test(msg)) {
          state.step = "upholstery_details";
          return res.status(200).json({ reply: "No problem — tell me the upholstery pieces again.", quickReplies: UPH_CHOICES, state });
        }
        if (/skip|no/i.test(msg)) return res.status(200).json(promptAddress(state));

        if (state.carpet?.price || state.duct?.total) {
          state.step = "confirm_combined_proceed";
          return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
        }

        return res.status(200).json(promptAddress(state));
      }

      case "confirm_combined_proceed": {
        if (/proceed|yes/i.test(msg)) return res.status(200).json(promptAddress(state));
        if (/change|edit|update|back/i.test(msg)) {
          const opts = [];
          if (state.carpet) opts.push("Change carpet");
          if (state.upholstery) opts.push("Change upholstery");
          if (state.duct) opts.push("Change duct");
          state.step = "confirm_combined_edit_picker";
          return res.status(200).json({ reply: "What would you like to change?", quickReplies: opts.concat(["Cancel"]), state });
        }
        return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
      }

      case "confirm_combined_edit_picker": {
        if (/cancel|no changes/i.test(msg)) {
          state.step = "confirm_combined_proceed";
          return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
        }
        if (/change carpet/i.test(msg)) { state.step = "carpet_details"; return res.status(200).json({ reply: "Tell me the carpet areas again.", state }); }
        if (/change upholstery/i.test(msg)) { state.step = "upholstery_details"; return res.status(200).json({ reply: "Tell me the upholstery pieces again.", quickReplies: UPH_CHOICES, state }); }
        if (/change duct/i.test(msg)) { state.step = "duct_package"; return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic", "Deep"], state }); }
        return res.status(200).json({ reply: "Tap one of the options to change, or Cancel to proceed.", state });
      }

      case "duct_package": {
        if (!/basic|deep/.test(msg)) {
          return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic", "Deep"], state });
        }
        state.duct = { pkg: /deep/.test(msg) ? "Deep" : "Basic", systems: 1, add: { furnace: false, dryer: false } };
        state.step = "duct_systems";
        return res.status(200).json({ reply: `Great — you chose **${state.duct.pkg}**. How many **HVAC systems** do you have?`, quickReplies: ["1", "2", "3", "4"], state });
      }

      case "duct_systems": {
        const n = Math.max(1, numFromText(msg));
        if (!n) return res.status(200).json({ reply: "How many systems should I price for? (e.g., 1 or 2)", quickReplies: ["1", "2", "3", "4"], state });
        state.duct.systems = n;
        state.step = "duct_add_furnace";
        return res.status(200).json({ reply: furnaceAddOnCopy(state.duct.pkg), quickReplies: ["Add furnace", "No furnace"], state });
      }

      case "duct_add_furnace": {
        // ✅ FIX A (part 1): anchored intent for add
        const norm = user.trim().toLowerCase();
        state.duct.add.furnace = /^add\b/.test(norm) || norm === "yes" || norm === "y";
        state.step = "duct_add_dryer";
        return res.status(200).json({ reply: dryerVentCopy, quickReplies: ["Add dryer vent", "No add-ons"], state });
      }

      case "duct_add_dryer": {
        // ✅ FIX A (part 2): “No add-ons” must NOT match “add”
        const norm = user.trim().toLowerCase();
        state.duct.add.dryer = /^add\b/.test(norm) || norm === "yes" || norm === "y";

        const base = state.duct.pkg === "Deep" ? 500 : 200;
        let total = state.duct.systems * base;
        if (state.duct.add.furnace) total += state.duct.systems * (state.duct.pkg === "Deep" ? 100 : 200);
        if (state.duct.add.dryer) total += 200;
        state.duct.total = total;

        state.step = "duct_confirm";
        const furn = state.duct.add.furnace ? ", +furnace" : "";
        const dry = state.duct.add.dryer ? ", +dryer vent" : "";

        // ✅ FIX C: no Skip button
        return res.status(200).json({
          reply: `Your **${state.duct.pkg}** duct cleaning total is **$${total}** (${state.duct.systems} system${state.duct.systems > 1 ? "s" : ""}${furn}${dry}). Proceed?`,
          quickReplies: ["Proceed", "Change"],
          state
        });
      }

      case "duct_confirm": {
        if (/change/i.test(msg)) { state.step = "duct_systems"; return res.status(200).json({ reply: "No problem — how many systems should I price for?", quickReplies: ["1", "2", "3", "4"], state }); }
        if (/skip|no/i.test(msg)) return res.status(200).json(promptAddress(state));
        return res.status(200).json(promptAddress(state));
      }

      case "collect_zip": {
        const zip = normalizeZip(user);
        if (!zip) return res.status(200).json({ reply: "Please enter a valid **5-digit ZIP code**.", state });

        state.zip = zip;

        if (!VALID_ZIP_SET || !zipInArea(zip)) {
          state.zipVerified = false;
          state.step = "ooa_collect_phone";
          return res.status(200).json({
            reply:
              "Thanks! Unfortunately, that ZIP looks **outside our service area**.\n" +
              "We can have a team member call to see if we can make it work.\n\n" +
              "What’s the best **phone number** to reach you?",
            state
          });
        }

        state.zipVerified = true;
        return res.status(200).json(promptAddress(state));
      }

      // (rest of booking flow unchanged / locked)
      default:
        return res.status(200).json(intro());
    }
  } catch (err) {
    console.error("chat.js error", err);
    return res.status(200).json({
      reply: "Sorry — something glitched on my end, but I’m still here. Tell me “carpet”, “upholstery”, or “ducts” and I’ll price it.",
      state: { step: "choose_service", faqLog: [] },
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

/* ========================= ZAP HANDLERS (form-encoded) ========================= */
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
    if (!payload.name2025 && !payload.phone2025 && !payload.email2025) return;

    await fetch(ZAPIER_SESSION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: encodeForm(payload)
    });
  } catch (err) {
    console.error("Session Zap failed", err);
  }
  }
