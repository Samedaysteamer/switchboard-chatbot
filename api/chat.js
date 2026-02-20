// Same Day Steamerz — robust ManyChat + Web handler (UPDATED BASELINE)
// - Keeps existing ManyChat + Web widget behavior
// - Adds DIRECT Meta Messenger Webhook support (object:"page") with PSID state persistence + Send API replies
// - Always includes state (object) AND state_json (string) for ManyChat mapping
// - Adds reply_text (string) so you can map the next prompt into a text block
// - Safe input extraction + ManyChat v2 auto-wrapper (Messenger)
// - Fallback: if user typed but state.step missing, jump to choose_service
//
// SURGICAL FIXES INCLUDED:
// 1) ZIP list import path corrected to ./zips.js (your repo structure)
// 2) ZIP gate: enforced BEFORE address via promptAddress() gate (zipVerified)
// 3) Address: ZIP optional (ZIP already collected)
// 4) Name loop fix: trim state.step + robust collect_name capture that ALWAYS advances

/* ========================= Utilities ========================= */
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

function normalizeZip(input = "") {
  const m = String(input || "").match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

/* ========================= Data ========================= */
// ✅ FIX: ZIP list is in /api/zips.js, so load from "./zips.js"
let validZipCodes = null;
try { validZipCodes = require("./zips.js").validZipCodes || null; } catch { validZipCodes = null; }
const VALID_ZIP_SET = Array.isArray(validZipCodes)
  ? new Set(validZipCodes.map(z => String(z || "").trim()).filter(Boolean))
  : null;

const SERVICE_CHOICES = ["Carpet Cleaning", "Upholstery Cleaning", "Air Duct Cleaning"];
const UPH_CHOICES = ["Sectional", "Sofa", "Loveseat", "Recliner", "Ottoman", "Dining chair", "Mattress"];

// Arrival windows (2 only — prevents looping)
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

/* ========================= ZIP verification (fail-closed) ========================= */
function zipVerdict(zipInput) {
  const z = normalizeZip(zipInput);
  if (!z) return { ok: false, reason: "invalid_format", zip: "" };
  if (!VALID_ZIP_SET) return { ok: false, reason: "zip_list_missing", zip: z };
  return { ok: VALID_ZIP_SET.has(z), reason: VALID_ZIP_SET.has(z) ? "in_area" : "out_of_area", zip: z };
}

/* ========================= Meta Messenger Direct Support ========================= */
const FB_PAGE_ACCESS_TOKEN =
  process.env.PAGE_ACCESS_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN || "";

const FB_VERIFY_TOKEN =
  process.env.VERIFY_TOKEN || process.env.FB_VERIFY_TOKEN || "switchboard_verify_123";

const FB_APP_SECRET =
  process.env.APP_SECRET || process.env.FB_APP_SECRET || "";

// Optional: Vercel KV persistence (recommended). If not installed/configured, falls back to in-memory.
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

// Optional signature validation (permissive if you don’t have raw body wired up)
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

/* ========================= Interrupts (Q&A) ========================= */
function detectQuickIntents(text = "") {
  const t = String(text || "").toLowerCase();
  return {
    stanley: /(stanley\ssteem(?:er|ers)|stanley\ssteam(?:er|ers)|is this\s+stanley|are you\s+stanley|stanley\ssteamerz|steemers)/i.test(t),
    company: /(who am i|what company|what.*business|who.*are you)/i.test(t),
    location: /(where.*located|what.*location|service.*atlanta|do you service|which areas.*cover)/i.test(t),
    human: /(human|agent|rep|representative)/i.test(t),
    special: /(\$?\s*50\b|fifty\s(?:dollars|special)|50\s*special)/i.test(t),
    whatsDiff: /(what'?s the difference|difference between)/i.test(t),

    drytime: /(how long.*dry|dry\s*time|hours.*dry|time.*dry|when.*dry)/i.test(t),
    stain: /(stain|spots?|pet stain|red wine|coffee|urine|odor|smell|guarantee)/i.test(t),
    petsKids: /(pet|dog|cat|animal|child|kid|baby|toddler).*(safe|okay|friendly)/i.test(t),
    furniture: /(move (?:furniture|sofa|bed|dresser|entertainment|sectional)|do you move.*furniture)/i.test(t),
    process: /(how.*work|what.*process|steam|truck.?mount|hot water extraction)/i.test(t),
    prep: /(prep|prepare|before you come|vacuum|water supply|hose|parking)/i.test(t),
    leather: /\bleather\b/i.test(t),
    upholsteryDry: /(upholstery).*(dry|how long)/i.test(t),
    furnace: /\bfurnace\b/i.test(t),
    dryerVent: /(dryer\s*vent|lint vent)/i.test(t),
    sameDay: /(same[-\s]?day|today|next day|tomorrow).*?(available|availability|slot|open|appointment|service)/i.test(t),

    odor: /(odor|odour|smell|urine|pee|pet\s*odor|pet\s*smell)/i.test(t),
    waterDamage: /(water\s*damage|flood(?:ed|ing)?|standing\s*water|water\s*extraction)/i.test(t),
    tileGrout: /\btile\b.*\bgrout\b|\bgrout\b.*\btile\b|tile\s*clean|grout\s*clean/i.test(t),
    hardwood: /(hard\s*wood|hardwood|wood\s*floor).*(clean|refinish|buff)?/i.test(t),
  };
}

// === Customer-facing copy ===
const stanleyRebuttal = () =>
  `We’re Same Day Steamerz — locally owned with truck-mounted hot water extraction (~240°F).

Why people switch from “big brands”:
• Straightforward pricing: $50 per area, $100 minimum.
• Promo: 2 rooms + 1 hallway = $100.
• Extra value: 4+ areas → hallway free, 6+ areas → +1 room free.
• Deeper clean included: pre-spray, fiber rinse, deodorizer.
• Flexible scheduling when available.

Want me to price your home now?`;

const specialCopy = () =>
  `Our $50 special is $50 per area with a $100 minimum.
Promo: 2 rooms + 1 hallway = $100.

Freebies built in
• 4+ areas: first hallway free
• 6+ areas: one room free + a hallway free

Includes pre-spray, deodorizer, and fiber rinse/sanitizer.`;

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

/* ========================= FAQ Answers ========================= */
function answerFAQ(text = "") {
  const qi = detectQuickIntents(text);
  if (qi.stanley) return stanleyRebuttal();
  if (qi.special) return specialCopy();

  if (qi.sameDay) return "We often have same-day or next-day availability. Share your ZIP code and I’ll confirm service in your area.";
  if (qi.drytime) return "Dry time is usually 4–8 hours, depending on airflow, humidity, and carpet thickness.";
  if (qi.stain) return "We treat most stains (coffee, wine, pet accidents, etc.). Some (bleach/burns) can be permanent.";
  if (qi.petsKids) return "Yes — our products are pet- and child-safe when used as directed.";
  if (qi.furniture) return "We don’t move large furniture (beds, dressers, entertainment centers, sectionals). Please clear small items.";
  if (qi.process) return "We pre-spray, then clean with truck-mounted hot water extraction (~240°F), followed by a fiber rinse and free deodorizer.";
  if (qi.prep) return "Please vacuum areas, ensure parking + water access, and clear small items.";
  if (qi.leather) return "We don’t clean leather upholstery — only fabric (sectionals, sofas, loveseats, recliners, etc.).";
  if (qi.upholsteryDry) return "Upholstery dry time: synthetics in hours; natural fibers (cotton/linen) longer. Airflow helps.";
  if (qi.furnace) return "Furnace cabinet cleaning is +$200 (Basic) or +$100 (Deep) when paired with duct cleaning.";
  if (qi.dryerVent) return "Dryer vent cleaning is $200 for a standard run to reduce fire risk.";

  if (qi.location) return "We cover metro ATL and surrounding ZIPs. Share your ZIP code and I’ll confirm service in your area.";
  return null;
}

function logFAQ(state, q, a) {
  if (!Array.isArray(state.faqLog)) state.faqLog = [];
  state.faqLog.push({ q, a, at: new Date().toISOString() });
}

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
    if (m) items.push({ type: key, count: numFromText(m[1]) });
    else if (new RegExp(`\\b${key}s?\\b`, "i").test(t)) items.push({ type: key, count: 1 });
  }

  return items.length ? priceUphFromItems(items) : { total: 0, breakdown: [], items: [] };
}

/* ========================= Booking summary builder ========================= */
function formatPhone(digits) {
  return (digits && digits.length === 10)
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : (digits || "");
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

  const total =
    (state.carpet?.price || 0) +
    (state.upholstery?.total || 0) +
    (state.duct?.total || 0);

  return `Booking summary
${parts.join("\n")}
Total: $${total}

ZIP: ${state.zip || "-"}
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

/* === Zap helpers (form-encoded) === */
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

function totalPriceForZap(state) {
  return (state.carpet?.price || 0) + (state.upholstery?.total || 0) + (state.duct?.total || 0);
}

function encodeForm(data) {
  return Object.keys(data)
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? ""))
    .join("&");
}

function snapshotForSession(state) {
  const parts = [];
  if (state.carpet) parts.push(`Carpet: ${state.carpet.billable} areas (${state.carpet.describedText})`);
  if (state.upholstery) parts.push(`Upholstery: ${state.upholstery.breakdown?.join(", ") || ""}`);
  if (state.duct) {
    const furn = state.duct.add?.furnace ? ", furnace" : "";
    const dry = state.duct.add?.dryer ? ", dryer" : "";
    parts.push(`Duct: ${state.duct.pkg} x ${state.duct.systems}${furn}${dry}`);
  }
  const total = totalPriceForZap(state);
  return parts.length ? `Snapshot: ${parts.join(" | ")} | Total so far: $${total}` : "";
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
    zip: state.zip || "",
    booking_complete: false,
    conversation: snapshotForSession(state) + (reason ? ` | Reason: ${reason}` : "")
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

/* ========================= ZIP gate (BEFORE address) ========================= */
function promptAddress(state) {
  // Gate: require a verified ZIP first
  if (!state.zipVerified) {
    state.step = "collect_zip";
    return { reply: "What’s your *ZIP code* for the service location?", state };
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

/* ========================= API Handler helpers ========================= */
function repromptForStep(state = {}) {
  const s = state.step || "";
  switch (s) {
    case "choose_service":
      return { reply: "Please choose a service.", quickReplies: SERVICE_CHOICES, state };

    case "collect_zip":
      return { reply: "What’s your ZIP code for the service location?", state };

    case "collect_address":
      return { reply: "What’s the full service address? (street + city + state — ZIP optional)", state };

    case "collect_name":
      return { reply: "What’s your full name? (First and last name)", state };

    case "collect_phone":
      return { reply: "What’s the best 10-digit phone number?", state };

    case "collect_email":
      return { reply: "What’s your email address?", state };

    case "collect_date":
      return { reply: "What day would you like the cleaning? (e.g., July 10 or 07/10)", state };

    case "collect_window":
      return { reply: "Pick a time window:", quickReplies: TIME_WINDOWS, state };

    case "collect_pets":
      return { reply: "Any pets we should know about?", quickReplies: ["Yes", "No"], state };

    case "collect_water":
      return { reply: "Do you have an outdoor water supply available?", quickReplies: ["Yes", "No"], state };

    case "collect_building":
      return { reply: "Is it a house or apartment?", quickReplies: ["House", "Apartment"], state };

    case "collect_floor":
      return { reply: "What floor is the apartment on?", quickReplies: ["1", "2", "3", "4"], state };

    case "collect_notes":
      return { reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes", "No, continue"], state };

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

    // ✅ SURGICAL: trim step to prevent “collect_name ” / whitespace bugs
    if (typeof state.step === "string") state.step = state.step.trim();

    const last =
      (typeof body.last === "string" && body.last) ||
      (typeof body.last_reply === "string" && body.last_reply) ||
      "";

    if (!state.step && last) {
      const l = last.toLowerCase();
      if (/zip code/.test(l)) state.step = "collect_zip";
      else if (/full service address/.test(l)) state.step = "collect_address";
      else if (/full name/.test(l)) state.step = "collect_name";
    }

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
        if (fromManyChat) return originalJson(toManyChatV2({ reply: "", state }));
        return originalJson({ reply: "", state, state_json: "{}", reply_text: "" });
      }
    };

    if (body.init || (!user && !state.step)) return res.status(200).json(intro());
    if (!state.step && user) return res.status(200).json(intro());
    if (!user) return res.status(200).json(repromptForStep(state));

    // FAQ at any time
    const incomingQuestion = body.intent === "faq" ? (body.question || user) : (isQuestion(user) ? user : null);
    if (incomingQuestion) {
      const ans = answerFAQ(incomingQuestion);
      if (ans) {
        logFAQ(state, incomingQuestion, ans);
        return res.status(200).json({ reply: ans, state, intentHandled: "faq" });
      }
    }

    switch (state.step) {
      case "choose_service": {
        let choice = null;
        if (/duct|air\s*duct/.test(msg)) choice = "duct";
        else if (/(upholstery|sectional|sofa|loveseat|recliner|ottoman|chair|mattress)/.test(msg)) choice = "upholstery";
        else if (/(carpet|rooms?|hall|stairs|flight|rugs?)/.test(msg)) choice = "carpet";

        if (!choice) return res.status(200).json(repromptForStep(state));

        if (choice === "carpet") {
          state.step = "carpet_details";
          return res.status(200).json({ reply: "What areas would you like us to clean? (e.g., “3 rooms, hallway, 2 rugs, stairs”).", state });
        }
        if (choice === "upholstery") {
          state.step = "upholstery_details";
          return res.status(200).json({ reply: "What upholstery pieces would you like cleaned?", quickReplies: UPH_CHOICES, state });
        }
        state.step = "duct_package";
        return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic", "Deep"], state });
      }

      case "carpet_details": {
        const parsed =
