// Same Day Steamerz — robust ManyChat + Web handler (UPDATED)
// - Keeps existing ManyChat + Web widget behavior
// - Adds DIRECT Meta Messenger Webhook support (object:"page") with PSID state persistence + Send API replies
// - Always includes state (object) AND state_json (string) for ManyChat mapping
// - Adds reply_text (string) so you can map the next prompt into a text block
// - Safe input extraction + ManyChat v2 auto-wrapper (Messenger)
// - Fallback: if user typed but state.step missing, jump to choose_service

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

/* ========================= Data ========================= */
let validZipCodes = null;
try { validZipCodes = require("../zips.js").validZipCodes || null; } catch { /* optional */ }

const SERVICE_CHOICES = ["Carpet Cleaning", "Upholstery Cleaning", "Air Duct Cleaning"];
const UPH_CHOICES = ["Sectional", "Sofa", "Loveseat", "Recliner", "Ottoman", "Dining chair", "Mattress"];

// UPDATED (surgical): ONLY 2 arrival window quick replies to prevent looping
const TIME_WINDOWS = ["8 to 12", "1 to 5"];

// NEW (surgical): normalize common variants to our 2 canonical window strings
function normalizeWindow(input = "") {
  const t = String(input || "").toLowerCase().replace(/\s+/g, " ").trim();

  if (/(^|\b)8\s*(?:am)?\s*(?:-|to|–)\s*12\s*(?:pm)?(\b|$)/.test(t)) return "8 to 12";
  if (/\b8\s*to\s*12\b/.test(t)) return "8 to 12";

  if (/(^|\b)1\s*(?:pm)?\s*(?:-|to|–)\s*5\s*(?:pm)?(\b|$)/.test(t)) return "1 to 5";
  if (/\b1\s*to\s*5\b/.test(t)) return "1 to 5";

  return "";
}

const UPH_PRICES = { loveseat: 100, recliner: 80, ottoman: 50, "dining chair": 25, sofa: 150, mattress: 150 };

/* ========================= Bundle Discount (Surgical Fix) =========================
Apply $50 off ONLY when customer booked carpet AND accepted upholstery upsell.
We do not change item totals; we subtract only from combined totals + zap totals.
=============================================================================== */
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

function answerFAQ(text = "") {
  const qi = detectQuickIntents(text);
  if (qi.stanley) return stanleyRebuttal();
  if (qi.special) return specialCopy();

  if (qi.sameDay) return "We often have same-day or next-day availability. Share your address and I’ll check the earliest arrival window.";
  if (qi.drytime) return "Dry time is usually 4–8 hours, depending on airflow, humidity, and carpet thickness.";
  if (qi.stain) return "We treat most stains (coffee, wine, pet accidents, etc.). Some (bleach/burns) can be permanent.";
  if (qi.petsKids) return "Yes — our products are pet- and child-safe when used as directed.";
  if (qi.furniture) return "We don’t move large furniture (beds, dressers, entertainment centers, sectionals). Please clear small items.";
  if (qi.process) return "We pre-spray, then clean with truck-mounted hot water extraction (~240°F), followed by a fiber rinse and free deodorizer.";
  if (qi.prep) return "Please vacuum areas, ensure parking + water access, and clear small items.";
  if (qi.leather) return "We don’t clean leather upholstery — only fabric (sectionals, sofas, loveseats, recliners, etc.).";
  if (qi.upholsteryDry) return "Upholstery dry time: synthetics in hours; natural fibers longer. Airflow helps.";
  if (qi.furnace) return "Furnace cabinet cleaning is +$200 (Basic) or +$100 (Deep) when paired with duct cleaning.";
  if (qi.dryerVent) return "Dryer vent cleaning is $200 for a standard run to reduce fire risk.";
  if (qi.odor) return "We can treat pet odors with enzyme + hot-water extraction. If urine soaked pad/subfloor, results vary; sealing/replacement may be needed.";
  if (qi.waterDamage) return "We don’t offer water-damage/flood extraction or remediation.";
  if (qi.tileGrout) return "We don’t currently offer tile & grout cleaning.";
  if (qi.hardwood) return "We don’t currently offer hardwood floor cleaning.";
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

  if (d.rooms === 2 && d.halls === 1 && d.stairs === 0 && d.extras === 0 && d.rugs === 0) price = 100;

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

/* ========================= Totals + Zaps ========================= */
function formatPhone(digits) {
  return (digits && digits.length === 10)
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : (digits || "");
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
function totalPriceForZap(state) {
  const raw = (state.carpet?.price || 0) + (state.upholstery?.total || 0) + (state.duct?.total || 0);
  return Math.max(0, raw - bundleDiscount(state));
}
function encodeForm(data) {
  return Object.keys(data).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? "")).join("&");
}
function snapshotForSession(state) {
  const parts = [];
  if (state.carpet) parts.push(`Carpet: ${state.carpet.billable} areas (${state.carpet.describedText})`);
  if (state.upholstery) parts.push(`Upholstery: ${state.upholstery.breakdown?.join(", ") || ""}`);
  if (state.duct) parts.push(`Duct: ${state.duct.pkg} x ${state.duct.systems}`);
  const disc = bundleDiscount(state);
  const discText = disc ? ` | Discount: -$${disc}` : "";
  return parts.length ? `Snapshot: ${parts.join(" | ")}${discText} | Total so far: $${totalPriceForZap(state)}` : "";
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
function refreshFollowUpIfEligible(state) {
  if (hasContact(state) && state.step !== "collect_notes") armFollowUp(state, 10);
}

const fetch = global.fetch || require("node-fetch");

// Your two Zap Webhooks:
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
    conversation: snapshotForSession(state) + (reason ? ` | Reason: ${reason}` : "")
  };

  try {
    await sendSessionZapFormEncoded(payload);
    state._sessionSent = true;
  } catch (e) {
    console.error("Session Zap failed", e);
  }
}

/* ========================= Smart corrections ========================= */
function applySmartCorrections(user, state) {
  if (!user || typeof user !== "string") return null;
  const t = user.toLowerCase();

  if (/(phone|number|override|update)/.test(t)) {
    const digits = (user.match(/\d/g) || []).join("");
    if (digits.length === 10) {
      state.phone = digits;
      return `Got it — I updated your phone number to ${formatPhone(state.phone)}.`;
    }
  }

  if (state.step === "collect_building" && /\bhouse\b/.test(t)) {
    state.building = "House";
    state.step = "collect_notes";
    state.__notesPrompted = true;
    return { reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes", "No, continue"] };
  }
  if (state.step === "collect_building" && /\bapartment\b/.test(t)) {
    state.building = "Apartment";
    state.step = "collect_floor";
    return { reply: "What floor is the apartment on? (1, 2, 3, or 4+)", quickReplies: ["1", "2", "3", "4"] };
  }

  if (state.step === "collect_floor") {
    const fl = numFromText(t);
    if (!fl) return { reply: "Please tell me which floor the apartment is on (e.g., 1, 2, 3, or 4).", quickReplies: ["1", "2", "3", "4"] };
    state.floor = fl;
    if (fl > 3) {
      state.step = "end_for_rep";
      return "Since it’s above the 3rd floor, a sales rep will contact you to confirm if service is possible.";
    }
    state.step = "collect_notes";
    state.__notesPrompted = true;
    return { reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes", "No, continue"] };
  }

  return null;
}

/* ========================= Reuse prompts ========================= */
const normalizeDigits = (s = "") => String(s).replace(/\D+/g, "");
const displayAddress = s => s.Address || s.address || "";
const displayName = s => s.name2025 || s.name || "";
const displayEmail = s => s.email2025 || s.email || "";
const displayPhone = s => normalizeDigits(s.phone2025 || s.phone || "");

function promptAddress(state) {
  const addr = displayAddress(state);
  if (addr) {
    state.step = "confirm_reuse_address";
    return { reply: `Use this service address?\n${addr}`, quickReplies: ["Yes", "No"], state };
  }
  state.step = "collect_address";
  return { reply: "What’s the full service address? (street + city + state + ZIP — commas optional)", state };
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
    case "choose_service": return { reply: "Please choose a service.", quickReplies: SERVICE_CHOICES, state };
    case "carpet_details": return { reply: "Tell me the carpet areas (e.g., “3 rooms, hallway, stairs”).", state };
    case "carpet_confirm": return { reply: "Ready to proceed with carpet?", quickReplies: ["Yes, move forward", "Change areas", "No, not now"], state };
    case "upholstery_details": return { reply: "List upholstery pieces (sectional, sofa, loveseat, recliner, ottoman, dining chairs, mattress).", quickReplies: UPH_CHOICES, state };
    case "upholstery_confirm": return { reply: "Proceed with upholstery?", quickReplies: ["Proceed", "Change items", "Skip"], state };
    case "duct_package": return { reply: ductIntroCopy(), quickReplies: ["Basic", "Deep"], state };
    case "collect_address": return { reply: "What’s the full service address? (street + city + state + ZIP)", state };
    case "collect_name": return { reply: "What’s your full name?", state };
    case "collect_phone": return { reply: "What’s the best 10-digit phone number?", state };
    case "collect_email": return { reply: "What’s your email address?", state };
    case "collect_date": return { reply: "What day would you like the cleaning? (e.g., July 10 or 07/10)", state };
    case "collect_window": return { reply: "Pick a time window:", quickReplies: TIME_WINDOWS, state };
    case "collect_pets": return { reply: "Any pets we should know about?", quickReplies: ["Yes", "No"], state };
    case "collect_water": return { reply: "Do you have an outdoor water supply available?", quickReplies: ["Yes", "No"], state };
    case "collect_building": return { reply: "Is it a house or apartment?", quickReplies: ["House", "Apartment"], state };
    case "collect_floor": return { reply: "What floor is the apartment on?", quickReplies: ["1", "2", "3", "4"], state };
    case "collect_notes": return { reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes", "No, continue"], state };
    default: return intro();
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
    if (typeof state === "string") { try { state = JSON.parse(state); } catch { state = {}; } }

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
        if (fromManyChat) return originalJson(toManyChatV2({ reply: "", state }));
        return originalJson({ reply: "", state, state_json: "{}", reply_text: "" });
      }
    };

    if (body.init || (!user && !state.step)) return res.status(200).json(intro());

    if (state._followUpArmed && state._followUpDueAt && Date.now() >= state._followUpDueAt && state.step !== "collect_notes") {
      await sendSessionIfEligible(state, "timeout");
      disarmFollowUp(state);
    }

    if (!state.step && user) return res.status(200).json(intro());
    if (!user) return res.status(200).json(repromptForStep(state));

    const correctionReply = applySmartCorrections(user, state);
    if (correctionReply) {
      if (typeof correctionReply === "string") return res.status(200).json({ reply: correctionReply, state });
      return res.status(200).json({ ...correctionReply, state });
    }

    const incomingQuestion = body.intent === "faq" ? (body.question || user) : (isQuestion(user) ? user : null);
    if (incomingQuestion) {
      const ans = answerFAQ(incomingQuestion);
      if (ans) { logFAQ(state, incomingQuestion, ans); return res.status(200).json({ reply: ans, state, intentHandled: "faq" }); }
    }

    function preBookingSummary(state) {
      const parts = [];
      if (state.carpet) parts.push(`Carpet — ${state.carpet.billable} area(s) (${state.carpet.describedText}) — $${state.carpet.price}`);
      if (state.upholstery) parts.push(`Upholstery — $${state.upholstery.total} — ${state.upholstery.breakdown?.join(", ") || ""}`);
      if (state.duct) parts.push(`Duct — ${state.duct.pkg} (${state.duct.systems} system${state.duct.systems > 1 ? "s" : ""}) — $${state.duct.total}`);

      const raw = (state.carpet?.price || 0) + (state.upholstery?.total || 0) + (state.duct?.total || 0);
      const disc = bundleDiscount(state);
      const total = Math.max(0, raw - disc);
      const discLine = disc ? `Discount: -$${disc} (Carpet + Upholstery bundle)\n` : "";

      return `**Quick summary so far**

${parts.join("\n")}
${discLine}Combined total: $${total}

Proceed with booking?`;
    }

    switch (state.step) {
      case "choose_service": {
        let choice = null;
        if (/duct|air\s*duct/.test(msg)) choice = "duct";
        if (/(upholstery|sectional|sofa|loveseat|recliner|ottoman|chair|mattress)/.test(msg)) choice = "upholstery";
        if (/(carpet|rooms?|hall|stairs|flight|rugs?)/.test(msg)) choice = "carpet";
        if (!choice) return res.status(200).json(repromptForStep(state));

        if (choice === "carpet") { state.step = "carpet_details"; return res.status(200).json({ reply: "What areas would you like us to clean? (e.g., “3 rooms, hallway, 2 rugs, stairs”).", state }); }
        if (choice === "upholstery") { state.step = "upholstery_details"; return res.status(200).json({ reply: "What upholstery pieces would you like cleaned?", quickReplies: UPH_CHOICES, state }); }

        state.step = "duct_package";
        return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic", "Deep"], state });
      }

      case "carpet_details": {
        const parsed = parseAreas(user);
        if (parsed.billable === 0) return res.status(200).json({ reply: "Please describe the carpet areas again (e.g., “4 rooms, 1 hallway, 1 rug”, or “3 rooms and stairs”).", state });
        state.carpet = parsed;
        state.step = "carpet_confirm";
        return res.status(200).json({
          reply: `For ${parsed.billable} area(s) (${parsed.describedText}) the total is **$${parsed.price}**.\n\nMove forward with carpet?`,
          quickReplies: ["Yes, move forward", "Change areas", "No, not now"],
          state
        });
      }

      case "carpet_confirm": {
        if (/change/i.test(msg)) { state.step = "carpet_details"; return res.status(200).json({ reply: "No problem — tell me the carpet areas again.", state }); }
        if (/no|not now|skip/i.test(msg)) {
          await sendSessionIfEligible(state, "user opted out before notes");
          const keepFaq = state.faqLog;
          state = { step: "choose_service", faqLog: keepFaq };
          return res.status(200).json({ reply: "All good – if you’d like a quote later just say “carpet”, “upholstery”, or “ducts”.", quickReplies: SERVICE_CHOICES, state });
        }
        state.step = "uph_upsell_offer";
        return res.status(200).json({ reply: "Nice — since you’re booking carpet, you’re eligible for **$50 off upholstery**. Want to add upholstery cleaning?", quickReplies: ["Yes, add upholstery", "No, skip"], state });
      }

      case "uph_upsell_offer": {
        if (/no|skip/i.test(msg)) return res.status(200).json(promptAddress(state));
        state.addingUphAfterCarpet = true;
        state.step = "upholstery_details";
        return res.status(200).json({ reply: "Great — what upholstery pieces would you like cleaned?", quickReplies: UPH_CHOICES, state });
      }

      case "upholstery_details": {
        if (/\bsectional\b/i.test(user) && !/\d/.test(user)) {
          state.step = "upholstery_sectional_seats";
          return res.status(200).json({ reply: "For the sectional — how many seats/cushions?", quickReplies: ["3", "4", "5", "6", "7"], state });
        }

        const parsed = parseUph(user);
        if (!parsed.breakdown.length) return res.status(200).json({ reply: "Please list pieces like “sectional 6 seats”, “two recliners”, or “sofa and ottoman”.", quickReplies: UPH_CHOICES, state });

        state.upholstery = { total: parsed.total, breakdown: parsed.breakdown };
        state.step = "confirm_combined_proceed";
        return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
      }

      case "upholstery_sectional_seats": {
        const seats = numFromText(msg);
        if (!seats) return res.status(200).json({ reply: "How many seats? (e.g., 4, 5, 6)", quickReplies: ["3", "4", "5", "6", "7"], state });
        const merged = priceUphFromItems([{ type: "sectional", seats }]);
        state.upholstery = { total: merged.total, breakdown: merged.breakdown };
        state.step = "confirm_combined_proceed";
        return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
      }

      case "confirm_combined_proceed": {
        if (/proceed|yes/i.test(msg)) return res.status(200).json(promptAddress(state));
        if (/change/i.test(msg)) { state.step = "upholstery_details"; return res.status(200).json({ reply: "Tell me the upholstery pieces again.", quickReplies: UPH_CHOICES, state }); }
        return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
      }

      case "duct_package": {
        if (!/basic|deep/.test(msg)) return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic", "Deep"], state });
        state.duct = { pkg: /deep/.test(msg) ? "Deep" : "Basic", systems: 1, add: { furnace: false, dryer: false } };
        state.step = "confirm_combined_proceed";
        return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
      }

      case "confirm_reuse_address": {
        if (/^y/i.test(msg)) return res.status(200).json(promptName(state));
        state.address = ""; state.Address = ""; state.step = "collect_address";
        return res.status(200).json({ reply: "What’s the full service address? (street + city + state + ZIP — commas optional)", state });
      }
      case "collect_address": {
        const zipMatch = user.match(/\b(\d{5})(?:-\d{4})?\b/);
        const hasStreet = /^\s*\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .,'-]*\b/.test(user);
        const hasState = /\b(AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/i.test(user);

        if (!zipMatch || !hasStreet || !hasState) return res.status(200).json({ reply: 'Please provide your **full service address** (street + city + state + ZIP). Example: "2314 College St Atlanta GA 30307"', state });

        const zip = zipMatch[1];
        if (validZipCodes && !validZipCodes.includes(zip)) {
          state.address = user.trim().replace(/\s{2,}/g, " ");
          state.zip = zip;
          state.step = "ooa_collect_phone";
          return res.status(200).json({ reply: "Thanks! Unfortunately, that address looks **outside our service area**.\nWe can have a team member call to see if we can make it work.\n\nWhat’s the best **phone number** to reach you?", state });
        }

        state.address = user.trim().replace(/\s{2,}/g, " ");
        state.Address = state.address;
        state.zip = zip;
        return res.status(200).json(promptName(state));
      }

      case "collect_name": {
        if (!/\b[a-z][a-z]+(?:[-' ]?[a-z]+)?\s+[a-z][a-z]+\b/i.test(user)) return res.status(200).json({ reply: "Please provide your **first and last name**.", state });
        state.name = user.trim();
        return res.status(200).json(promptPhone(state));
      }
      case "collect_phone": {
        const digits = (user.match(/\d/g) || []).join("");
        if (digits.length !== 10) return res.status(200).json({ reply: "Please enter a valid **10-digit** phone number.", state });
        state.phone = digits;
        await sendSessionIfEligible(state, "got phone");
        refreshFollowUpIfEligible(state);
        return res.status(200).json(promptEmail(state));
      }
      case "collect_email": {
        if (!/^[\w.\-+]+@[\w.\-]+\.\w{2,}$/i.test(user)) return res.status(200).json({ reply: "Please enter a valid email address.", state });
        state.email = user.trim();
        state.step = "collect_date";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply: "What day would you like the cleaning? (e.g., July 10 or 07/10)", state });
      }
      case "collect_date": {
        state.date = user.trim();
        state.step = "collect_window";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply: "Which time frame works best for you?", quickReplies: TIME_WINDOWS, state });
      }
      case "collect_window": {
        const chosen = normalizeWindow(user) || user.trim();
        if (!TIME_WINDOWS.includes(chosen)) return res.status(200).json({ reply: "Please pick one:", quickReplies: TIME_WINDOWS, state });
        state.window = chosen;
        state.step = "collect_pets";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply: "Are there any pets we should know about?", quickReplies: ["Yes", "No"], state });
      }
      case "collect_pets": {
        state.pets = /^y/i.test(msg) ? "Yes" : "No";
        state.step = "collect_water";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply: "Do you have an outdoor water supply available?", quickReplies: ["Yes", "No"], state });
      }
      case "collect_water": {
        state.outdoorWater = /^y/i.test(msg) ? "Yes" : "No";
        state.step = "collect_building";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply: "Is it a house or apartment?", quickReplies: ["House", "Apartment"], state });
      }
      case "collect_building": {
        state.building = /house/i.test(msg) ? "House" : /apart/i.test(msg) ? "Apartment" : "";
        if (!state.building) return res.status(200).json({ reply: "Please choose: House or Apartment?", quickReplies: ["House", "Apartment"], state });
        state.step = state.building === "Apartment" ? "collect_floor" : "collect_notes";
        state.__notesPrompted = state.step === "collect_notes";
        return res.status(200).json(repromptForStep(state));
      }
      case "collect_floor": {
        state.floor = numFromText(msg) || "";
        state.step = "collect_notes";
        state.__notesPrompted = true;
        return res.status(200).json(repromptForStep(state));
      }
      case "collect_notes": {
        if (!state.__notesPrompted) {
          state.__notesPrompted = true;
          return res.status(200).json({ reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes", "No, continue"], state });
        }
        state.notes = (/^\s*no/i.test(user) ? "-" : (user || "").trim() || "-");
        disarmFollowUp(state);

        const bookingPayload = {
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
          booking_complete: true
        };
        await sendBookingZapFormEncoded(bookingPayload);

        return res.status(200).json({ reply: `Booked. Total after any bundle discount: $${totalPriceForZap(state)}.`, state: { step: "choose_service", faqLog: state.faqLog } });
      }

      case "ooa_collect_phone": {
        const digits = (user.match(/\d/g) || []).join("");
        if (digits.length !== 10) return res.status(200).json({ reply: "Please enter a valid **10-digit** phone number we can call.", state });
        state.phone = digits;
        state.step = "ooa_collect_name";
        return res.status(200).json({ reply: "Thanks. **Who should we ask for?** (First and last name)", state });
      }
      case "ooa_collect_name": {
        if (!/\b[a-z][a-z]+(?:[-' ]?[a-z]+)?\s+[a-z][a-z]+\b/i.test(user)) return res.status(200).json({ reply: "Please provide both a **first and last name**.", state });
        state.name = user.trim();
        await sendSessionZapFormEncoded({
          Cleaning_Breakdown: buildCleaningBreakdownForZap(state),
          "selected service": selectedServiceForZap(state),
          "Total Price": totalPriceForZap(state),
          name2025: state.name || "",
          phone2025: state.phone || "",
          email2025: state.email || "",
          Address: state.address || "",
          booking_complete: false,
          conversation: snapshotForSession(state) || "OOA handoff"
        });
        return res.status(200).json({ reply: `Thanks, ${state.name}! We’ll review your address and call ${formatPhone(state.phone)}.`, state: { step: "choose_service", faqLog: [] } });
      }

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
  // Messenger Webhook Verification (Meta + direct)
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];

    if (mode === "subscribe" && token === FB_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.sendStatus(403);
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};

  // ===== DIRECT META WEBHOOK BRANCH =====
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
        const storedState = (await getStateByPSID(psid)) || {};

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

  // ===== MANYCHAT + WEB BRANCH =====
  return handleCorePOST(req, res);
};// Same Day Steamerz — robust ManyChat + Web handler (UPDATED)
// - Keeps existing ManyChat + Web widget behavior
// - Adds DIRECT Meta Messenger Webhook support (object:"page") with PSID state persistence + Send API replies
// - Always includes state (object) AND state_json (string) for ManyChat mapping
// - Adds reply_text (string) so you can map the next prompt into a text block
// - Safe input extraction + ManyChat v2 auto-wrapper (Messenger)
// - Fallback: if user typed but state.step missing, jump to choose_service

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

/* ========================= Data ========================= */
let validZipCodes = null;
try { validZipCodes = require("../zips.js").validZipCodes || null; } catch { /* optional */ }

const SERVICE_CHOICES = ["Carpet Cleaning", "Upholstery Cleaning", "Air Duct Cleaning"];
const UPH_CHOICES = ["Sectional", "Sofa", "Loveseat", "Recliner", "Ottoman", "Dining chair", "Mattress"];

// UPDATED (surgical): ONLY 2 arrival window quick replies to prevent looping
const TIME_WINDOWS = ["8 to 12", "1 to 5"];

// NEW (surgical): normalize common variants to our 2 canonical window strings
function normalizeWindow(input = "") {
  const t = String(input || "").toLowerCase().replace(/\s+/g, " ").trim();

  if (/(^|\b)8\s*(?:am)?\s*(?:-|to|–)\s*12\s*(?:pm)?(\b|$)/.test(t)) return "8 to 12";
  if (/\b8\s*to\s*12\b/.test(t)) return "8 to 12";

  if (/(^|\b)1\s*(?:pm)?\s*(?:-|to|–)\s*5\s*(?:pm)?(\b|$)/.test(t)) return "1 to 5";
  if (/\b1\s*to\s*5\b/.test(t)) return "1 to 5";

  return "";
}

const UPH_PRICES = { loveseat: 100, recliner: 80, ottoman: 50, "dining chair": 25, sofa: 150, mattress: 150 };

/* ========================= Bundle Discount (Surgical Fix) =========================
Apply $50 off ONLY when customer booked carpet AND accepted upholstery upsell.
We do not change item totals; we subtract only from combined totals + zap totals.
=============================================================================== */
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

function answerFAQ(text = "") {
  const qi = detectQuickIntents(text);
  if (qi.stanley) return stanleyRebuttal();
  if (qi.special) return specialCopy();

  if (qi.sameDay) return "We often have same-day or next-day availability. Share your address and I’ll check the earliest arrival window.";
  if (qi.drytime) return "Dry time is usually 4–8 hours, depending on airflow, humidity, and carpet thickness.";
  if (qi.stain) return "We treat most stains (coffee, wine, pet accidents, etc.). Some (bleach/burns) can be permanent.";
  if (qi.petsKids) return "Yes — our products are pet- and child-safe when used as directed.";
  if (qi.furniture) return "We don’t move large furniture (beds, dressers, entertainment centers, sectionals). Please clear small items.";
  if (qi.process) return "We pre-spray, then clean with truck-mounted hot water extraction (~240°F), followed by a fiber rinse and free deodorizer.";
  if (qi.prep) return "Please vacuum areas, ensure parking + water access, and clear small items.";
  if (qi.leather) return "We don’t clean leather upholstery — only fabric (sectionals, sofas, loveseats, recliners, etc.).";
  if (qi.upholsteryDry) return "Upholstery dry time: synthetics in hours; natural fibers longer. Airflow helps.";
  if (qi.furnace) return "Furnace cabinet cleaning is +$200 (Basic) or +$100 (Deep) when paired with duct cleaning.";
  if (qi.dryerVent) return "Dryer vent cleaning is $200 for a standard run to reduce fire risk.";
  if (qi.odor) return "We can treat pet odors with enzyme + hot-water extraction. If urine soaked pad/subfloor, results vary; sealing/replacement may be needed.";
  if (qi.waterDamage) return "We don’t offer water-damage/flood extraction or remediation.";
  if (qi.tileGrout) return "We don’t currently offer tile & grout cleaning.";
  if (qi.hardwood) return "We don’t currently offer hardwood floor cleaning.";
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

  if (d.rooms === 2 && d.halls === 1 && d.stairs === 0 && d.extras === 0 && d.rugs === 0) price = 100;

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

/* ========================= Totals + Zaps ========================= */
function formatPhone(digits) {
  return (digits && digits.length === 10)
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : (digits || "");
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
function totalPriceForZap(state) {
  const raw = (state.carpet?.price || 0) + (state.upholstery?.total || 0) + (state.duct?.total || 0);
  return Math.max(0, raw - bundleDiscount(state));
}
function encodeForm(data) {
  return Object.keys(data).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? "")).join("&");
}
function snapshotForSession(state) {
  const parts = [];
  if (state.carpet) parts.push(`Carpet: ${state.carpet.billable} areas (${state.carpet.describedText})`);
  if (state.upholstery) parts.push(`Upholstery: ${state.upholstery.breakdown?.join(", ") || ""}`);
  if (state.duct) parts.push(`Duct: ${state.duct.pkg} x ${state.duct.systems}`);
  const disc = bundleDiscount(state);
  const discText = disc ? ` | Discount: -$${disc}` : "";
  return parts.length ? `Snapshot: ${parts.join(" | ")}${discText} | Total so far: $${totalPriceForZap(state)}` : "";
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
function refreshFollowUpIfEligible(state) {
  if (hasContact(state) && state.step !== "collect_notes") armFollowUp(state, 10);
}

const fetch = global.fetch || require("node-fetch");

// Your two Zap Webhooks:
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
    conversation: snapshotForSession(state) + (reason ? ` | Reason: ${reason}` : "")
  };

  try {
    await sendSessionZapFormEncoded(payload);
    state._sessionSent = true;
  } catch (e) {
    console.error("Session Zap failed", e);
  }
}

/* ========================= Smart corrections ========================= */
function applySmartCorrections(user, state) {
  if (!user || typeof user !== "string") return null;
  const t = user.toLowerCase();

  if (/(phone|number|override|update)/.test(t)) {
    const digits = (user.match(/\d/g) || []).join("");
    if (digits.length === 10) {
      state.phone = digits;
      return `Got it — I updated your phone number to ${formatPhone(state.phone)}.`;
    }
  }

  if (state.step === "collect_building" && /\bhouse\b/.test(t)) {
    state.building = "House";
    state.step = "collect_notes";
    state.__notesPrompted = true;
    return { reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes", "No, continue"] };
  }
  if (state.step === "collect_building" && /\bapartment\b/.test(t)) {
    state.building = "Apartment";
    state.step = "collect_floor";
    return { reply: "What floor is the apartment on? (1, 2, 3, or 4+)", quickReplies: ["1", "2", "3", "4"] };
  }

  if (state.step === "collect_floor") {
    const fl = numFromText(t);
    if (!fl) return { reply: "Please tell me which floor the apartment is on (e.g., 1, 2, 3, or 4).", quickReplies: ["1", "2", "3", "4"] };
    state.floor = fl;
    if (fl > 3) {
      state.step = "end_for_rep";
      return "Since it’s above the 3rd floor, a sales rep will contact you to confirm if service is possible.";
    }
    state.step = "collect_notes";
    state.__notesPrompted = true;
    return { reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes", "No, continue"] };
  }

  return null;
}

/* ========================= Reuse prompts ========================= */
const normalizeDigits = (s = "") => String(s).replace(/\D+/g, "");
const displayAddress = s => s.Address || s.address || "";
const displayName = s => s.name2025 || s.name || "";
const displayEmail = s => s.email2025 || s.email || "";
const displayPhone = s => normalizeDigits(s.phone2025 || s.phone || "");

function promptAddress(state) {
  const addr = displayAddress(state);
  if (addr) {
    state.step = "confirm_reuse_address";
    return { reply: `Use this service address?\n${addr}`, quickReplies: ["Yes", "No"], state };
  }
  state.step = "collect_address";
  return { reply: "What’s the full service address? (street + city + state + ZIP — commas optional)", state };
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
    case "choose_service": return { reply: "Please choose a service.", quickReplies: SERVICE_CHOICES, state };
    case "carpet_details": return { reply: "Tell me the carpet areas (e.g., “3 rooms, hallway, stairs”).", state };
    case "carpet_confirm": return { reply: "Ready to proceed with carpet?", quickReplies: ["Yes, move forward", "Change areas", "No, not now"], state };
    case "upholstery_details": return { reply: "List upholstery pieces (sectional, sofa, loveseat, recliner, ottoman, dining chairs, mattress).", quickReplies: UPH_CHOICES, state };
    case "upholstery_confirm": return { reply: "Proceed with upholstery?", quickReplies: ["Proceed", "Change items", "Skip"], state };
    case "duct_package": return { reply: ductIntroCopy(), quickReplies: ["Basic", "Deep"], state };
    case "collect_address": return { reply: "What’s the full service address? (street + city + state + ZIP)", state };
    case "collect_name": return { reply: "What’s your full name?", state };
    case "collect_phone": return { reply: "What’s the best 10-digit phone number?", state };
    case "collect_email": return { reply: "What’s your email address?", state };
    case "collect_date": return { reply: "What day would you like the cleaning? (e.g., July 10 or 07/10)", state };
    case "collect_window": return { reply: "Pick a time window:", quickReplies: TIME_WINDOWS, state };
    case "collect_pets": return { reply: "Any pets we should know about?", quickReplies: ["Yes", "No"], state };
    case "collect_water": return { reply: "Do you have an outdoor water supply available?", quickReplies: ["Yes", "No"], state };
    case "collect_building": return { reply: "Is it a house or apartment?", quickReplies: ["House", "Apartment"], state };
    case "collect_floor": return { reply: "What floor is the apartment on?", quickReplies: ["1", "2", "3", "4"], state };
    case "collect_notes": return { reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes", "No, continue"], state };
    default: return intro();
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
    if (typeof state === "string") { try { state = JSON.parse(state); } catch { state = {}; } }

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
        if (fromManyChat) return originalJson(toManyChatV2({ reply: "", state }));
        return originalJson({ reply: "", state, state_json: "{}", reply_text: "" });
      }
    };

    if (body.init || (!user && !state.step)) return res.status(200).json(intro());

    if (state._followUpArmed && state._followUpDueAt && Date.now() >= state._followUpDueAt && state.step !== "collect_notes") {
      await sendSessionIfEligible(state, "timeout");
      disarmFollowUp(state);
    }

    if (!state.step && user) return res.status(200).json(intro());
    if (!user) return res.status(200).json(repromptForStep(state));

    const correctionReply = applySmartCorrections(user, state);
    if (correctionReply) {
      if (typeof correctionReply === "string") return res.status(200).json({ reply: correctionReply, state });
      return res.status(200).json({ ...correctionReply, state });
    }

    const incomingQuestion = body.intent === "faq" ? (body.question || user) : (isQuestion(user) ? user : null);
    if (incomingQuestion) {
      const ans = answerFAQ(incomingQuestion);
      if (ans) { logFAQ(state, incomingQuestion, ans); return res.status(200).json({ reply: ans, state, intentHandled: "faq" }); }
    }

    function preBookingSummary(state) {
      const parts = [];
      if (state.carpet) parts.push(`Carpet — ${state.carpet.billable} area(s) (${state.carpet.describedText}) — $${state.carpet.price}`);
      if (state.upholstery) parts.push(`Upholstery — $${state.upholstery.total} — ${state.upholstery.breakdown?.join(", ") || ""}`);
      if (state.duct) parts.push(`Duct — ${state.duct.pkg} (${state.duct.systems} system${state.duct.systems > 1 ? "s" : ""}) — $${state.duct.total}`);

      const raw = (state.carpet?.price || 0) + (state.upholstery?.total || 0) + (state.duct?.total || 0);
      const disc = bundleDiscount(state);
      const total = Math.max(0, raw - disc);
      const discLine = disc ? `Discount: -$${disc} (Carpet + Upholstery bundle)\n` : "";

      return `**Quick summary so far**

${parts.join("\n")}
${discLine}Combined total: $${total}

Proceed with booking?`;
    }

    switch (state.step) {
      case "choose_service": {
        let choice = null;
        if (/duct|air\s*duct/.test(msg)) choice = "duct";
        if (/(upholstery|sectional|sofa|loveseat|recliner|ottoman|chair|mattress)/.test(msg)) choice = "upholstery";
        if (/(carpet|rooms?|hall|stairs|flight|rugs?)/.test(msg)) choice = "carpet";
        if (!choice) return res.status(200).json(repromptForStep(state));

        if (choice === "carpet") { state.step = "carpet_details"; return res.status(200).json({ reply: "What areas would you like us to clean? (e.g., “3 rooms, hallway, 2 rugs, stairs”).", state }); }
        if (choice === "upholstery") { state.step = "upholstery_details"; return res.status(200).json({ reply: "What upholstery pieces would you like cleaned?", quickReplies: UPH_CHOICES, state }); }

        state.step = "duct_package";
        return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic", "Deep"], state });
      }

      case "carpet_details": {
        const parsed = parseAreas(user);
        if (parsed.billable === 0) return res.status(200).json({ reply: "Please describe the carpet areas again (e.g., “4 rooms, 1 hallway, 1 rug”, or “3 rooms and stairs”).", state });
        state.carpet = parsed;
        state.step = "carpet_confirm";
        return res.status(200).json({
          reply: `For ${parsed.billable} area(s) (${parsed.describedText}) the total is **$${parsed.price}**.\n\nMove forward with carpet?`,
          quickReplies: ["Yes, move forward", "Change areas", "No, not now"],
          state
        });
      }

      case "carpet_confirm": {
        if (/change/i.test(msg)) { state.step = "carpet_details"; return res.status(200).json({ reply: "No problem — tell me the carpet areas again.", state }); }
        if (/no|not now|skip/i.test(msg)) {
          await sendSessionIfEligible(state, "user opted out before notes");
          const keepFaq = state.faqLog;
          state = { step: "choose_service", faqLog: keepFaq };
          return res.status(200).json({ reply: "All good – if you’d like a quote later just say “carpet”, “upholstery”, or “ducts”.", quickReplies: SERVICE_CHOICES, state });
        }
        state.step = "uph_upsell_offer";
        return res.status(200).json({ reply: "Nice — since you’re booking carpet, you’re eligible for **$50 off upholstery**. Want to add upholstery cleaning?", quickReplies: ["Yes, add upholstery", "No, skip"], state });
      }

      case "uph_upsell_offer": {
        if (/no|skip/i.test(msg)) return res.status(200).json(promptAddress(state));
        state.addingUphAfterCarpet = true;
        state.step = "upholstery_details";
        return res.status(200).json({ reply: "Great — what upholstery pieces would you like cleaned?", quickReplies: UPH_CHOICES, state });
      }

      case "upholstery_details": {
        if (/\bsectional\b/i.test(user) && !/\d/.test(user)) {
          state.step = "upholstery_sectional_seats";
          return res.status(200).json({ reply: "For the sectional — how many seats/cushions?", quickReplies: ["3", "4", "5", "6", "7"], state });
        }

        const parsed = parseUph(user);
        if (!parsed.breakdown.length) return res.status(200).json({ reply: "Please list pieces like “sectional 6 seats”, “two recliners”, or “sofa and ottoman”.", quickReplies: UPH_CHOICES, state });

        state.upholstery = { total: parsed.total, breakdown: parsed.breakdown };
        state.step = "confirm_combined_proceed";
        return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
      }

      case "upholstery_sectional_seats": {
        const seats = numFromText(msg);
        if (!seats) return res.status(200).json({ reply: "How many seats? (e.g., 4, 5, 6)", quickReplies: ["3", "4", "5", "6", "7"], state });
        const merged = priceUphFromItems([{ type: "sectional", seats }]);
        state.upholstery = { total: merged.total, breakdown: merged.breakdown };
        state.step = "confirm_combined_proceed";
        return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
      }

      case "confirm_combined_proceed": {
        if (/proceed|yes/i.test(msg)) return res.status(200).json(promptAddress(state));
        if (/change/i.test(msg)) { state.step = "upholstery_details"; return res.status(200).json({ reply: "Tell me the upholstery pieces again.", quickReplies: UPH_CHOICES, state }); }
        return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
      }

      case "duct_package": {
        if (!/basic|deep/.test(msg)) return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic", "Deep"], state });
        state.duct = { pkg: /deep/.test(msg) ? "Deep" : "Basic", systems: 1, add: { furnace: false, dryer: false } };
        state.step = "confirm_combined_proceed";
        return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
      }

      case "confirm_reuse_address": {
        if (/^y/i.test(msg)) return res.status(200).json(promptName(state));
        state.address = ""; state.Address = ""; state.step = "collect_address";
        return res.status(200).json({ reply: "What’s the full service address? (street + city + state + ZIP — commas optional)", state });
      }
      case "collect_address": {
        const zipMatch = user.match(/\b(\d{5})(?:-\d{4})?\b/);
        const hasStreet = /^\s*\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .,'-]*\b/.test(user);
        const hasState = /\b(AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/i.test(user);

        if (!zipMatch || !hasStreet || !hasState) return res.status(200).json({ reply: 'Please provide your **full service address** (street + city + state + ZIP). Example: "2314 College St Atlanta GA 30307"', state });

        const zip = zipMatch[1];
        if (validZipCodes && !validZipCodes.includes(zip)) {
          state.address = user.trim().replace(/\s{2,}/g, " ");
          state.zip = zip;
          state.step = "ooa_collect_phone";
          return res.status(200).json({ reply: "Thanks! Unfortunately, that address looks **outside our service area**.\nWe can have a team member call to see if we can make it work.\n\nWhat’s the best **phone number** to reach you?", state });
        }

        state.address = user.trim().replace(/\s{2,}/g, " ");
        state.Address = state.address;
        state.zip = zip;
        return res.status(200).json(promptName(state));
      }

      case "collect_name": {
        if (!/\b[a-z][a-z]+(?:[-' ]?[a-z]+)?\s+[a-z][a-z]+\b/i.test(user)) return res.status(200).json({ reply: "Please provide your **first and last name**.", state });
        state.name = user.trim();
        return res.status(200).json(promptPhone(state));
      }
      case "collect_phone": {
        const digits = (user.match(/\d/g) || []).join("");
        if (digits.length !== 10) return res.status(200).json({ reply: "Please enter a valid **10-digit** phone number.", state });
        state.phone = digits;
        await sendSessionIfEligible(state, "got phone");
        refreshFollowUpIfEligible(state);
        return res.status(200).json(promptEmail(state));
      }
      case "collect_email": {
        if (!/^[\w.\-+]+@[\w.\-]+\.\w{2,}$/i.test(user)) return res.status(200).json({ reply: "Please enter a valid email address.", state });
        state.email = user.trim();
        state.step = "collect_date";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply: "What day would you like the cleaning? (e.g., July 10 or 07/10)", state });
      }
      case "collect_date": {
        state.date = user.trim();
        state.step = "collect_window";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply: "Which time frame works best for you?", quickReplies: TIME_WINDOWS, state });
      }
      case "collect_window": {
        const chosen = normalizeWindow(user) || user.trim();
        if (!TIME_WINDOWS.includes(chosen)) return res.status(200).json({ reply: "Please pick one:", quickReplies: TIME_WINDOWS, state });
        state.window = chosen;
        state.step = "collect_pets";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply: "Are there any pets we should know about?", quickReplies: ["Yes", "No"], state });
      }
      case "collect_pets": {
        state.pets = /^y/i.test(msg) ? "Yes" : "No";
        state.step = "collect_water";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply: "Do you have an outdoor water supply available?", quickReplies: ["Yes", "No"], state });
      }
      case "collect_water": {
        state.outdoorWater = /^y/i.test(msg) ? "Yes" : "No";
        state.step = "collect_building";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply: "Is it a house or apartment?", quickReplies: ["House", "Apartment"], state });
      }
      case "collect_building": {
        state.building = /house/i.test(msg) ? "House" : /apart/i.test(msg) ? "Apartment" : "";
        if (!state.building) return res.status(200).json({ reply: "Please choose: House or Apartment?", quickReplies: ["House", "Apartment"], state });
        state.step = state.building === "Apartment" ? "collect_floor" : "collect_notes";
        state.__notesPrompted = state.step === "collect_notes";
        return res.status(200).json(repromptForStep(state));
      }
      case "collect_floor": {
        state.floor = numFromText(msg) || "";
        state.step = "collect_notes";
        state.__notesPrompted = true;
        return res.status(200).json(repromptForStep(state));
      }
      case "collect_notes": {
        if (!state.__notesPrompted) {
          state.__notesPrompted = true;
          return res.status(200).json({ reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes", "No, continue"], state });
        }
        state.notes = (/^\s*no/i.test(user) ? "-" : (user || "").trim() || "-");
        disarmFollowUp(state);

        const bookingPayload = {
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
          booking_complete: true
        };
        await sendBookingZapFormEncoded(bookingPayload);

        return res.status(200).json({ reply: `Booked. Total after any bundle discount: $${totalPriceForZap(state)}.`, state: { step: "choose_service", faqLog: state.faqLog } });
      }

      case "ooa_collect_phone": {
        const digits = (user.match(/\d/g) || []).join("");
        if (digits.length !== 10) return res.status(200).json({ reply: "Please enter a valid **10-digit** phone number we can call.", state });
        state.phone = digits;
        state.step = "ooa_collect_name";
        return res.status(200).json({ reply: "Thanks. **Who should we ask for?** (First and last name)", state });
      }
      case "ooa_collect_name": {
        if (!/\b[a-z][a-z]+(?:[-' ]?[a-z]+)?\s+[a-z][a-z]+\b/i.test(user)) return res.status(200).json({ reply: "Please provide both a **first and last name**.", state });
        state.name = user.trim();
        await sendSessionZapFormEncoded({
          Cleaning_Breakdown: buildCleaningBreakdownForZap(state),
          "selected service": selectedServiceForZap(state),
          "Total Price": totalPriceForZap(state),
          name2025: state.name || "",
          phone2025: state.phone || "",
          email2025: state.email || "",
          Address: state.address || "",
          booking_complete: false,
          conversation: snapshotForSession(state) || "OOA handoff"
        });
        return res.status(200).json({ reply: `Thanks, ${state.name}! We’ll review your address and call ${formatPhone(state.phone)}.`, state: { step: "choose_service", faqLog: [] } });
      }

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
  // Messenger Webhook Verification (Meta + direct)
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];

    if (mode === "subscribe" && token === FB_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.sendStatus(403);
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};

  // ===== DIRECT META WEBHOOK BRANCH =====
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
        const storedState = (await getStateByPSID(psid)) || {};

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

  // ===== MANYCHAT + WEB BRANCH =====
  return handleCorePOST(req, res);
};
