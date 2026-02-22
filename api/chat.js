// Same Day Steamerz — robust ManyChat + Web handler (UPDATED)
// LOCKED: ZIP gate + bundle discount + duct pricing
// SURGICAL: (1) duct "No add-ons" never adds dryer, (2) sofa/loveseat cushion gate (4+ => sectional),
//          (3) remove Skip from PRICE CONFIRMS
// FIXED NOW: (4) web state_json hydration (prevents resets), (5) booking continuation after collect_name (phone/email/date/window/pets/water/building/notes)
// ✅ FIXED NOW (6): Bundle summary + $50 discount works BOTH directions (Carpet→Uph, Uph→Carpet) with combined total screen
// ✅ FIXED NOW (7): Zapier restored (Session/Partial on phone capture + Booking on notes completion)
// ✅ FIXED NOW (OOA): Out-of-area ZIP asks ONLY phone + name, sends Session Zap, then stops

const crypto = require("crypto");

/* ========================= Utilities ========================= */
const SMALL = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20
};
const TENS = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };

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
  return /\?$/.test(s) || /^(what|when|how|who|where|why|do|does|can|is|are|should|could|would)\b/i.test(s);
};

const normalizeDigits = (s = "") => String(s || "").replace(/\D+/g, "");
function formatPhone(digits) {
  const d = normalizeDigits(digits);
  return (d && d.length === 10)
    ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`
    : (digits || "");
}

// ✅ FIX (Zapier): form encoder used by Zapier senders
function encodeForm(data) {
  return Object.keys(data || {})
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? ""))
    .join("&");
}

// ZIP helpers
function normalizeZip(input = "") {
  const m = String(input || "").match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

/* ========================= Data ========================= */
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

const SERVICE_CHOICES = ["Carpet Cleaning", "Upholstery Cleaning", "Air Duct Cleaning"];
const UPH_CHOICES = ["Sectional", "Sofa", "Loveseat", "Recliner", "Ottoman", "Dining chair", "Mattress"];
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

/* ========================= Bundle Discount (LOCKED + UPDATED) =========================
Rule:
- Applies when BOTH carpet + upholstery exist
- AND the bundle was created via either upsell path:
    addingUphAfterCarpet OR addingCarpetAfterUph
- AND carpet has at least 2 billable areas (per your “2+ rooms/areas” requirement)
============================================================================= */
function bundleDiscount(state = {}) {
  const hasCarpet = !!(state.carpet && typeof state.carpet.price === "number" && state.carpet.price > 0);
  const hasUph = !!(state.upholstery && typeof state.upholstery.total === "number" && state.upholstery.total > 0);
  const eligiblePath = !!(state.addingUphAfterCarpet || state.addingCarpetAfterUph);
  const carpetOk = !!(state.carpet && typeof state.carpet.billable === "number" && state.carpet.billable >= 2);
  return (eligiblePath && hasCarpet && hasUph && carpetOk) ? 50 : 0;
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

  return { billable, price, describedText: parts.join(", "), detail: { ...d, freeHall, freeRoom } };
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
    if (m) items.push({ type: key, count: numFromText(m[1]) });
    else if (new RegExp(`\\b${key}s?\\b`, "i").test(t)) items.push({ type: key, count: 1 });
  }

  return items.length ? priceUphFromItems(items) : { total: 0, breakdown: [], items: [] };
}

/* ========================= Totals / Summary ========================= */
function subtotalPrice(state) {
  return (state.carpet?.price || 0) + (state.upholstery?.total || 0) + (state.duct?.total || 0);
}
function totalWithDiscount(state) {
  return Math.max(0, subtotalPrice(state) - bundleDiscount(state));
}

// ✅ FIX (Zapier): helpers for Zap payloads (used by Booking + Session)
function selectedServiceForZap(state) {
  const s = [];
  if (state.carpet) s.push("Carpet");
  if (state.upholstery) s.push("Upholstery");
  if (state.duct) s.push("Air Duct");
  return s.join(" + ");
}
function buildCleaningBreakdownForZap(state) {
  const lines = [];
  if (state.carpet) {
    lines.push(`Carpet — ${state.carpet.billable} area(s) (${state.carpet.describedText}) — $${state.carpet.price}`);
  }
  if (state.upholstery) {
    lines.push(`Upholstery — ${state.upholstery.breakdown?.join(", ") || ""} — $${state.upholstery.total}`);
  }
  if (state.duct) {
    const furn = state.duct.add?.furnace ? ", +furnace" : "";
    const dry = state.duct.add?.dryer ? ", +dryer vent" : "";
    lines.push(`Duct — ${state.duct.pkg} (${state.duct.systems} system${state.duct.systems > 1 ? "s" : ""}${furn}${dry}) — $${state.duct.total}`);
  }
  return lines.join("\n");
}

function combinedBundleSummary(state) {
  const lines = [];
  if (state.carpet) lines.push(`Carpet Cleaning: $${state.carpet.price}`);
  if (state.upholstery) lines.push(`Upholstery Cleaning: $${state.upholstery.total}`);
  if (state.duct) lines.push(`Air Duct Cleaning: $${state.duct.total}`);

  const discount = bundleDiscount(state);
  const total = totalWithDiscount(state);

  return `Quick summary so far

${lines.join("\n")}
${discount ? `Bundle discount: -$${discount}\n` : ""}Combined total: $${total}

Proceed with booking?`;
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
  const discount = bundleDiscount(state);
  return `Booking summary
${parts.join("\n")}
${discount ? `Bundle discount: -$${discount}\n` : ""}Total: $${totalWithDiscount(state)}

Name: ${state.name || "-"}
Phone: ${state.phone ? formatPhone(state.phone) : "-"}
Email: ${state.email || "-"}
Address: ${state.address || "-"}
Preferred Day: ${state.date || "-"}
Arrival Time: ${state.window || "-"}
Pets: ${state.pets || "-"}   Outdoor Water: ${state.outdoorWater || "-"}
Building: ${state.building || "-"}${state.floor ? ` (Floor ${state.floor})` : ""}
Notes: ${state.notes || "-"}
`;
}

/* ========================= Booking prompts ========================= */
function promptZip(state) {
  state.step = "collect_zip";
  return { reply: "What’s the ZIP code for the service location?", state };
}
function promptAddress(state) {
  if (!state.zipVerified) {
    if (state.zip && zipInArea(state.zip)) state.zipVerified = true;
    else return promptZip(state);
  }
  state.step = "collect_address";
  return { reply: "What’s the full service address? (street + city + state — ZIP optional)", state };
}
function promptName(state) {
  state.step = "collect_name";
  return { reply: "What’s your full name? (First and last name)", state };
}
function promptPhone(state) {
  state.step = "collect_phone";
  return { reply: "What’s the best phone number to reach you?", state };
}
function promptEmail(state) {
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
  return out;
}

/* ========================= Reprompt ========================= */
function repromptForStep(state = {}) {
  const s = state.step || "";
  switch (s) {
    case "carpet_details":
      return { reply: "What areas would you like us to clean? (e.g., “3 rooms, hallway, stairs”).", state };
    case "carpet_confirm":
      return { reply: "Move forward with carpet?", quickReplies: ["Yes, move forward", "Change areas"], state };
    case "uph_upsell_offer":
      return { reply: "Want to add upholstery cleaning?", quickReplies: ["Yes, add upholstery", "No, skip"], state };

    case "upholstery_confirm":
      return { reply: "Proceed with upholstery?", quickReplies: ["Proceed", "Change items"], state };
    case "duct_confirm":
      return { reply: "Proceed?", quickReplies: ["Proceed", "Change"], state };

    case "carpet_upsell_offer":
      return { reply: "Want me to price carpet too?", quickReplies: ["Yes, add carpet", "No, skip"], state };

    case "confirm_combined_proceed":
      return { reply: combinedBundleSummary(state), quickReplies: ["Proceed", "Change items"], state };
    case "confirm_combined_edit_picker": {
      const opts = [];
      if (state.carpet) opts.push("Change carpet");
      if (state.upholstery) opts.push("Change upholstery");
      if (state.duct) opts.push("Change duct");
      opts.push("Cancel");
      return { reply: "What would you like to change?", quickReplies: opts, state };
    }

    case "collect_zip":
      return { reply: "What’s the ZIP code for the service location?", state };
    case "collect_address":
      return { reply: "What’s the full service address? (street + city + state — ZIP optional)", state };
    case "collect_name":
      return { reply: "What’s your full name? (First and last name)", state };
    case "collect_phone":
      return { reply: "What’s the best phone number to reach you?", state };
    case "collect_email":
      return { reply: "What’s your email address?", state };
    case "collect_date":
      return { reply: "What day would you like the cleaning? (e.g., July 10 or 07/10)", state };
    case "collect_window":
      return { reply: "Which time frame works best for you?", quickReplies: TIME_WINDOWS, state };
    case "collect_pets":
      return { reply: "Are there any pets we should know about?", quickReplies: ["Yes", "No"], state };
    case "collect_water":
      return { reply: "Do you have an outdoor water supply available?", quickReplies: ["Yes", "No"], state };
    case "collect_building":
      return { reply: "Is it a house or apartment?", quickReplies: ["House", "Apartment"], state };
    case "collect_floor":
      return { reply: "What floor is the apartment on?", quickReplies: ["1", "2", "3", "4"], state };
    case "collect_notes":
      return { reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes", "No, continue"], state };

    // ✅ OOA reprompts (ONLY phone + name)
    case "ooa_collect_phone":
      return { reply: "What’s the best phone number to reach you?", state };
    case "ooa_collect_name":
      return { reply: "Who should we ask for? (First and last name)", state };

    default:
      return intro();
  }
}

/* ========================= CORE POST HANDLER ========================= */
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

    // ✅ FIXED: hydrate from state_json (prevents web widget resets)
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
      let out = (data == null) ? {} : (typeof data === "string" ? { reply: data } : { ...data });
      if (out.state === undefined) out.state = state;

      const v2 = toManyChatV2(out);
      if (fromManyChat) return originalJson(v2);

      out.state_json = v2.state_json;
      out.reply_text = v2.reply_text || (typeof out.reply === "string" ? out.reply : "");
      return originalJson(out);
    };

    if (body.init || (!user && !state.step)) return res.status(200).json(intro());
    if (!state.step && user) return res.status(200).json(intro());
    if (!user) return res.status(200).json(repromptForStep(state));

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

      /* ========================= Carpet Flow (restored) ========================= */
      case "carpet_details": {
        const parsed = parseAreas(user);
        if (!parsed.billable) {
          return res.status(200).json({ reply: "Please describe the carpet areas again (e.g., “2 rooms and a hallway”, “3 rooms, stairs”).", state });
        }
        state.carpet = parsed;
        state.step = "carpet_confirm";
        return res.status(200).json({
          reply: `For ${parsed.billable} area(s) (${parsed.describedText}) the total is **$${parsed.price}**.\n\nMove forward with carpet?`,
          quickReplies: ["Yes, move forward", "Change areas"],
          state
        });
      }

      case "carpet_confirm": {
        if (/change/i.test(msg)) {
          state.step = "carpet_details";
          return res.status(200).json({ reply: "No problem — tell me the carpet areas again.", state });
        }

        // ✅ If we already have upholstery or duct, show combined summary BEFORE ZIP
        if (state.upholstery?.total || state.duct?.total) {
          state.step = "confirm_combined_proceed";
          return res.status(200).json({
            reply: combinedBundleSummary(state),
            quickReplies: ["Proceed", "Change items"],
            state
          });
        }

        // Otherwise offer upholstery discount upsell (LOCKED behavior)
        state.step = "uph_upsell_offer";
        return res.status(200).json({
          reply: "Nice — since you’re booking carpet, you’re eligible for **$50 off upholstery**. Want to add upholstery cleaning?",
          quickReplies: ["Yes, add upholstery", "No, skip"],
          state
        });
      }

      case "uph_upsell_offer": {
        if (/^no\b|skip/i.test(msg)) {
          return res.status(200).json(promptAddress(state));
        }
        state.addingUphAfterCarpet = true; // ✅ needed for bundle discount eligibility
        state.step = "upholstery_details";
        return res.status(200).json({ reply: "Great — what upholstery pieces would you like cleaned?", quickReplies: UPH_CHOICES, state });
      }
      /* ======================================================== */

      /* ========================= Upholstery Flow ========================= */
      case "upholstery_details": {
        const t = msg.trim();

        // Sofa/Loveseat cushion gate (4+ => sectional)
        if ((t === "sofa" || t === "loveseat") && !/\d/.test(user)) {
          state.step = "upholstery_cushions";
          state._cushionTarget = t;
          return res.status(200).json({
            reply: `For the ${t} — how many seat cushions does it have?`,
            quickReplies: ["1", "2", "3", "4", "5", "6", "7"],
            state
          });
        }

        // Sectional without number
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
        return res.status(200).json({
          reply: `Your upholstery total is **$${parsed.total}** for ${parsed.breakdown.join(", ")}.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items"], // ✅ NO SKIP (price confirm)
          state
        });
      }

      case "upholstery_cushions": {
        const cushions = numFromText(user);
        if (!cushions || cushions < 1) {
          return res.status(200).json({
            reply: "How many seat cushions does it have?",
            quickReplies: ["1", "2", "3", "4", "5", "6", "7"],
            state
          });
        }

        const target = (state._cushionTarget || "sofa").toLowerCase();

        // Rule set:
        // - 4+ cushions => sectional pricing
        // - sofa: 1–3 => sofa
        // - loveseat: 1–2 => loveseat, 3 => sofa, 4+ => sectional
        let items;
        if (cushions >= 4) {
          items = [{ type: "sectional", seats: cushions }];
        } else if (target === "loveseat") {
          items = [{ type: (cushions <= 2 ? "loveseat" : "sofa"), count: 1, seats: cushions }];
        } else {
          items = [{ type: "sofa", count: 1, seats: cushions }];
        }

        const priced = priceUphFromItems(items);
        state.upholstery = { total: priced.total, breakdown: priced.breakdown };
        state._cushionTarget = null;

        state.step = "upholstery_confirm";
        return res.status(200).json({
          reply: `Your upholstery total is **$${priced.total}** for ${priced.breakdown.join(", ")}.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items"], // ✅ NO SKIP (price confirm)
          state
        });
      }

      case "upholstery_sectional_seats": {
        const seats = numFromText(user);
        if (!seats) return res.status(200).json({ reply: "How many seats? (e.g., 4, 5, 6)", quickReplies: ["3", "4", "5", "6", "7"], state });

        const merged = priceUphFromItems([{ type: "sectional", seats }]);
        state.upholstery = { total: merged.total, breakdown: merged.breakdown };
        state.step = "upholstery_confirm";
        return res.status(200).json({
          reply: `Your sectional price is **$${merged.total}**.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items"], // ✅ NO SKIP (price confirm)
          state
        });
      }

      case "upholstery_confirm": {
        if (/change/i.test(msg)) {
          state.step = "upholstery_details";
          return res.status(200).json({ reply: "No problem — tell me the upholstery pieces again.", quickReplies: UPH_CHOICES, state });
        }

        // ✅ If carpet already exists (Carpet→Uph bundle), show combined summary BEFORE ZIP
        if (state.carpet?.price || state.duct?.total) {
          state.step = "confirm_combined_proceed";
          return res.status(200).json({
            reply: combinedBundleSummary(state),
            quickReplies: ["Proceed", "Change items"],
            state
          });
        }

        // ✅ Upholstery-only: upsell carpet BEFORE ZIP
        state.step = "carpet_upsell_offer";
        return res.status(200).json({
          reply: "Since you’re booking upholstery, you qualify for a free hallway at 4+ areas, and at 6+ areas you also get one room free. Want me to price carpet too?",
          quickReplies: ["Yes, add carpet", "No, skip"],
          state
        });
      }

      case "carpet_upsell_offer": {
        if (/^no\b|skip/i.test(msg)) {
          return res.status(200).json(promptAddress(state));
        }
        state.addingCarpetAfterUph = true; // ✅ needed for bundle discount eligibility
        state.step = "carpet_details";
        return res.status(200).json({ reply: "Awesome — how many carpet areas should I price? (e.g., “3 rooms, hallway, 1 rug”).", state });
      }
      /* ======================================================== */

      /* ========================= Combined bundle proceed ========================= */
      case "confirm_combined_proceed": {
        if (/^proceed\b|^yes\b/i.test(msg)) {
          return res.status(200).json(promptAddress(state));
        }
        if (/change/i.test(msg)) {
          const opts = [];
          if (state.carpet) opts.push("Change carpet");
          if (state.upholstery) opts.push("Change upholstery");
          if (state.duct) opts.push("Change duct");
          opts.push("Cancel");
          state.step = "confirm_combined_edit_picker";
          return res.status(200).json({ reply: "What would you like to change?", quickReplies: opts, state });
        }
        return res.status(200).json({ reply: combinedBundleSummary(state), quickReplies: ["Proceed", "Change items"], state });
      }

      case "confirm_combined_edit_picker": {
        if (/cancel/i.test(msg)) {
          state.step = "confirm_combined_proceed";
          return res.status(200).json({ reply: combinedBundleSummary(state), quickReplies: ["Proceed", "Change items"], state });
        }
        if (/change carpet/i.test(msg)) { state.step = "carpet_details"; return res.status(200).json({ reply: "Tell me the carpet areas again.", state }); }
        if (/change upholstery/i.test(msg)) { state.step = "upholstery_details"; return res.status(200).json({ reply: "Tell me the upholstery pieces again.", quickReplies: UPH_CHOICES, state }); }
        if (/change duct/i.test(msg)) { state.step = "duct_package"; return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic", "Deep"], state }); }
        return res.status(200).json({ reply: "Tap an option to change, or Cancel.", state });
      }

      /* ========================= Duct Flow (locked behavior) ========================= */
      case "duct_package": {
        if (!/basic|deep/.test(msg)) {
          return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic", "Deep"], state });
        }
        state.duct = { pkg: /deep/.test(msg) ? "Deep" : "Basic", systems: 1, add: { furnace: false, dryer: false } };
        state.step = "duct_systems";
        return res.status(200).json({ reply: `Great — you chose **${state.duct.pkg}**. How many **HVAC systems** do you have?`, quickReplies: ["1", "2", "3", "4"], state });
      }

      case "duct_systems": {
        const n = Math.max(1, numFromText(user));
        state.duct.systems = n;
        state.step = "duct_add_furnace";
        return res.status(200).json({ reply: furnaceAddOnCopy(state.duct.pkg), quickReplies: ["Add furnace", "No furnace"], state });
      }

      case "duct_add_furnace": {
        // ✅ anchored "add" so "No add-ons" never matches
        state.duct.add.furnace = /^\s*add\b/i.test(user);
        state.step = "duct_add_dryer";
        return res.status(200).json({ reply: dryerVentCopy, quickReplies: ["Add dryer vent", "No add-ons"], state });
      }

      case "duct_add_dryer": {
        // ✅ anchored "add" so "No add-ons" never matches
        state.duct.add.dryer = /^\s*add\b/i.test(user);

        const base = state.duct.pkg === "Deep" ? 500 : 200;
        let total = state.duct.systems * base;
        if (state.duct.add.furnace) total += state.duct.systems * (state.duct.pkg === "Deep" ? 100 : 200);
        if (state.duct.add.dryer) total += 200;
        state.duct.total = total;

        state.step = "duct_confirm";
        const furn = state.duct.add.furnace ? ", +furnace" : "";
        const dry = state.duct.add.dryer ? ", +dryer vent" : "";

        return res.status(200).json({
          reply: `Your **${state.duct.pkg}** duct cleaning total is **$${total}** (${state.duct.systems} system${state.duct.systems > 1 ? "s" : ""}${furn}${dry}). Proceed?`,
          quickReplies: ["Proceed", "Change"], // ✅ NO SKIP (price confirm)
          state
        });
      }

      case "duct_confirm": {
        if (/change/i.test(msg)) {
          state.step = "duct_systems";
          return res.status(200).json({ reply: "No problem — how many systems should I price for?", quickReplies: ["1", "2", "3", "4"], state });
        }
        return res.status(200).json(promptAddress(state));
      }

      /* ========================= ZIP Gate + Booking Continuation ========================= */
      case "collect_zip": {
        const zip = normalizeZip(user);
        if (!zip) return res.status(200).json({ reply: "Please enter a valid **5-digit ZIP code**.", state });

        state.zip = zip;

        if (!VALID_ZIP_SET || !zipInArea(zip)) {
          state.zipVerified = false;
          state.step = "ooa_collect_phone"; // ✅ OOA starts here
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

      case "collect_address": {
        const hasStreet = /^\s*\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .,'-]*\b/.test(user);
        const hasState = /\b(AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/i.test(user);
        if (!hasStreet || !hasState) {
          return res.status(200).json({ reply: 'Please provide your **full service address** (street + city + state). Example: "2314 College St Atlanta GA"', state });
        }

        // keep address
        state.address = user.trim().replace(/\s{2,}/g, " ");
        state.Address = state.address;

        state.step = "collect_name";
        return res.status(200).json(promptName(state));
      }

      case "collect_name": {
        if (!/\b[a-z][a-z]+(?:[-' ]?[a-z]+)?\s+[a-z][a-z]+\b/i.test(user)) {
          return res.status(200).json({ reply: "Please provide your **first and last name**.", state });
        }
        state.name = user.trim();
        // ✅ continue booking
        return res.status(200).json(promptPhone(state));
      }

      case "collect_phone": {
        const digits = (user.match(/\d/g) || []).join("");
        if (digits.length !== 10) return res.status(200).json({ reply: "Please enter a valid **10-digit** phone number.", state });
        state.phone = digits;

        // ✅ Session/Partial Zap once we have name + phone (normal in-area flow)
        if (!state._sessionSent) {
          try {
            const sessionPayload = {
              Cleaning_Breakdown: buildCleaningBreakdownForZap(state),
              "selected service": selectedServiceForZap(state),
              "Total Price": totalWithDiscount(state),
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
              booking_complete: false
            };
            await sendSessionZapFormEncoded(sessionPayload);
            state._sessionSent = true;
          } catch (e) {
            console.error("Session Zap send failed", e);
          }
        }

        return res.status(200).json(promptEmail(state));
      }

      case "collect_email": {
        if (!/^[\w.\-+]+@[\w.\-]+\.\w{2,}$/i.test(user)) return res.status(200).json({ reply: "Please enter a valid email address.", state });
        state.email = user.trim();
        state.step = "collect_date";
        return res.status(200).json({ reply: "What day would you like the cleaning? (e.g., July 10 or 07/10)", state });
      }

      case "collect_date": {
        let d = null;
        const now = new Date();
        const thisYear = now.getFullYear();

        if (/^[0-1]?\d\/[0-3]?\d$/.test(user.trim())) {
          const [mm, dd] = user.split("/").map(x => +x);
          d = new Date(thisYear, mm - 1, dd);
          if (d < new Date(thisYear, now.getMonth(), now.getDate())) d = new Date(thisYear + 1, mm - 1, dd);
        } else {
          const tryD = Date.parse(user);
          if (!Number.isNaN(tryD)) d = new Date(tryD);
        }
        if (!d) return res.status(200).json({ reply: "Please enter a date like “July 10” or “07/10”.", state });

        state.date = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
        state.step = "collect_window";
        return res.status(200).json({ reply: "Which time frame works best for you?", quickReplies: TIME_WINDOWS, state });
      }

      case "collect_window": {
        const chosen = normalizeWindow(user) || user.trim();
        if (!TIME_WINDOWS.includes(chosen)) return res.status(200).json({ reply: "Please pick one:", quickReplies: TIME_WINDOWS, state });
        state.window = chosen;
        state.step = "collect_pets";
        return res.status(200).json({ reply: "Are there any pets we should know about?", quickReplies: ["Yes", "No"], state });
      }

      case "collect_pets": {
        state.pets = /^y/i.test(msg) ? "Yes" : "No";
        state.step = "collect_water";
        return res.status(200).json({ reply: "Do you have an outdoor water supply available?", quickReplies: ["Yes", "No"], state });
      }

      case "collect_water": {
        state.outdoorWater = /^y/i.test(msg) ? "Yes" : "No";
        state.step = "collect_building";
        return res.status(200).json({ reply: "Is it a house or apartment?", quickReplies: ["House", "Apartment"], state });
      }

      case "collect_building": {
        if (/house/i.test(msg)) {
          state.building = "House";
          state.step = "collect_notes";
          return res.status(200).json({ reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes", "No, continue"], state });
        }
        if (/apart/i.test(msg)) {
          state.building = "Apartment";
          state.step = "collect_floor";
          return res.status(200).json({ reply: "What floor is the apartment on?", quickReplies: ["1", "2", "3", "4"], state });
        }
        return res.status(200).json({ reply: "Please choose: House or Apartment?", quickReplies: ["House", "Apartment"], state });
      }

      case "collect_floor": {
        const fl = numFromText(user);
        if (!fl) return res.status(200).json({ reply: "Please tell me which floor the apartment is on (e.g., 1, 2, 3, or 4).", quickReplies: ["1", "2", "3", "4"], state });
        state.floor = fl;
        if (fl > 3) {
          state.step = "end_for_rep";
          return res.status(200).json({ reply: "Since it’s above the 3rd floor, a sales rep will contact you to confirm if service is possible.", state });
        }
        state.step = "collect_notes";
        return res.status(200).json({ reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes", "No, continue"], state });
      }

      case "collect_notes": {
        if (/^\s*yes/i.test(user)) {
          return res.status(200).json({ reply: "Please type your notes or special instructions:", state });
        }
        if (/^\s*no/i.test(user)) state.notes = "-";
        else state.notes = (user || "").trim() || "-";

        // ✅ Booking Zap once booking is complete (notes captured)
        if (!state._bookingSent) {
          try {
            const bookingPayload = {
              Cleaning_Breakdown: buildCleaningBreakdownForZap(state),
              "selected service": selectedServiceForZap(state),
              "Total Price": totalWithDiscount(state),
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
              booking_complete: true
            };
            await sendBookingZapFormEncoded(bookingPayload);
            state._bookingSent = true;
          } catch (e) {
            console.error("Booking Zap send failed", e);
          }
        }

        const summary = bookingSummary(state);
        state.step = "post_summary_offer";
        return res.status(200).json({
          reply: summary + "\nBefore you go — would you like to hear about another service?",
          quickReplies: ["Carpet", "Upholstery", "Tell me about duct cleaning", "No thanks"],
          state
        });
      }

      case "post_summary_offer": {
        return res.status(200).json({
          reply: "Got it! If you need anything else, just say “carpet”, “upholstery”, or “ducts”.",
          quickReplies: SERVICE_CHOICES,
          state: { step: "choose_service", faqLog: state.faqLog || [] }
        });
      }

      /* ========================= ✅ OOA FLOW (ONLY CHANGE) ========================= */
      case "ooa_collect_phone": {
        const digits = (user.match(/\d/g) || []).join("");
        if (digits.length !== 10) return res.status(200).json({ reply: "Please enter a valid **10-digit** phone number.", state });
        state.phone = digits;

        state.step = "ooa_collect_name";
        return res.status(200).json({ reply: "Who should we ask for? (First and last name)", state });
      }

      case "ooa_collect_name": {
        if (!/\b[a-z][a-z]+(?:[-' ]?[a-z]+)?\s+[a-z][a-z]+\b/i.test(user)) {
          return res.status(200).json({ reply: "Please provide a **first and last name**.", state });
        }
        state.name = user.trim();

        // Send Session/Partial Zap for OOA lead (so Zapier can text)
        try {
          await sendSessionZapFormEncoded({
            Cleaning_Breakdown: buildCleaningBreakdownForZap(state),
            "selected service": selectedServiceForZap(state),
            "Total Price": totalWithDiscount(state),
            name2025: state.name || "",
            phone2025: state.phone || "",
            email2025: "",              // OOA: we do NOT collect email
            Address: "",                // OOA: we do NOT collect address
            date: "",
            Window: "",
            pets: "",
            OutdoorWater: "",
            BuildingType: "",
            Notes: `OUTSIDE SERVICE AREA — ZIP ${state.zip || ""}`,
            booking_complete: false
          });
        } catch (e) {
          console.error("OOA Session Zap send failed", e);
        }

        // Stop and reset (no more questions)
        const ph = state.phone || "";
        const nm = state.name || "";
        state = { step: "choose_service", faqLog: state.faqLog || [] };

        return res.status(200).json({
          reply:
            `Thanks, ${nm}! That ZIP is outside our normal service area.\n` +
            `A team member will reach out to ${formatPhone(ph)} to see if we can make it work.`,
          quickReplies: SERVICE_CHOICES,
          state
        });
      }
      /* ======================================================== */

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
