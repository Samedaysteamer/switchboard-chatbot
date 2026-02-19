// Same Day Steamerz — Facebook bot ($100 min) + one-time TURN LOG
// -------------------------------------------------------------------
// Zaps used by this file:
//  • BOOKING (kept exactly as-is):     u13zg9e
//  • SESSION/PARTIAL (kept as-is):     u12ap8l
//  • TURN LOG (one-time per session):  u9477fj  (sends arrays for Row(s))
// -------------------------------------------------------------------
// Important behavior:
//  • We DO NOT call a Zap per turn. We collect each turn in state._turns.
//  • We send ONE Turn Log webhook at true session end (booking, OOA, >3rd floor,
//    explicit opt-out, explicit finalize, error, or timeout ping). Guarded by state._turnLogSent.
//  • Optional: we send ONE early "start" Turn Log when a service is first chosen,
//    so Zapier can start a 10-min Delay and still end with a single final update.
// -------------------------------------------------------------------

const fetch = global.fetch || require("node-fetch");

/* ========================= Webhook URLs ========================= */
// 🔒 TURN LOG (one-time at session end; optional 'start' ping at service select)
const ZAPIER_TURNLOG_URL  = "https://hooks.zapier.com/hooks/catch/3165661/u9477fj/";
// ✅ COMPLETE BOOKING (unchanged)
const ZAPIER_BOOKING_URL  = "https://hooks.zapier.com/hooks/catch/3165661/u13zg9e/";
// ✅ PARTIAL/SESSION (unchanged)
const ZAPIER_SESSION_URL  = "https://hooks.zapier.com/hooks/catch/3165661/u12ap8l/";

/* ========================= Constants / Meta ========================= */
const BOT_NAME   = "Same Day Steamerz FB Bot";
const BOT_VER    = "2025-10-04-turnlog-v3.1";
const CHANNEL    = "facebook";
const DEFAULT_TIMEOUT_MIN = 10; // for Turn Log 'start' ping

/* ========================= Utilities ========================= */
const SMALL = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20 };
const TENS  = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };

const nowIso   = () => new Date().toISOString();
const tsToIso  = (ms) => new Date(ms).toISOString();
const clampMin = (n, min) => (n < min ? min : n);

function wordsToNumber(v=""){
  const t = v.toLowerCase().replace(/-/g," ").trim();
  if (/^\d+$/.test(t)) return +t;
  let total = 0, current = 0;
  for (const w of t.split(/\s+/)) {
    if (SMALL[w] != null) { current += SMALL[w]; continue; }
    if (TENS[w]  != null) { current += TENS[w];  continue; }
    if (w === "hundred")  { current *= 100;      continue; }
    if (/^(and|a)$/.test(w)) continue;
    if (current) { total += current; current = 0; }
  }
  return total + current || 0;
}
const numFromText = (s="") => { const m = String(s).match(/\d+/); return m ? +m[0] : wordsToNumber(s); };
const isQuestion = (t="") =>
  /\?$/.test(t.trim()) ||
  /^(what|when|how|who|where|why|do|does|can|is|are|should|could|would|are y|am i)\b/i.test(t);

const normalizeDigits = (s='') => String(s).replace(/\D+/g,'');
const formatPhone = digits => (digits && digits.length===10)
  ? `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`
  : digits;

function encodeForm(data){
  return Object.keys(data).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? "")).join("&");
}

/* ========================= Data ========================= */
let validZipCodes = null;
try { validZipCodes = require("../zips.js").validZipCodes || null; } catch { /* optional */ }

const SERVICE_CHOICES = ["Carpet Cleaning", "Upholstery Cleaning", "Air Duct Cleaning"];
const UPH_CHOICES     = ["Sectional", "Sofa", "Loveseat", "Recliner", "Ottoman", "Dining chair", "Mattress"];
const TIME_WINDOWS    = ["8 AM–12 PM", "1 PM–5 PM"];

const UPH_PRICES = { loveseat:100, recliner:80, ottoman:50, "dining chair":25, sofa:150, mattress:150 };

/* ========================= Interrupts (Q&A) ========================= */
function detectQuickIntents(text="") {
  const t = text.toLowerCase();
  return {
    stanley: /(stanley\s*steem(?:er|ers)|stanley\s*steam(?:er|ers)|is this\s+stanley|are you\s+stanley|stanley\s*steamerz|steemers)/i.test(t),
    company: /(who am i|what company|what.*business|who.*are you)/.test(t),
    location: /(where.*located|what.*location|service.*atlanta|do you service|which areas.*cover)/.test(t),
    human: /(human|agent|rep|representative)/.test(t),
    special: /(\$?\s*50\b|fifty\s*(?:dollars|special)|50\s*special)/.test(t),
    whatsDiff: /(what'?s the difference|difference between)/.test(t),

    // FAQ themes
    drytime: /(how long.*dry|dry\s*time|hours.*dry|time.*dry|when.*dry)/.test(t),
    stain: /(stain|spots?|pet stain|red wine|coffee|urine|odor|smell|guarantee)/.test(t),
    petsKids: /(pet|dog|cat|animal|child|kid|baby|toddler).*(safe|okay|friendly)/.test(t),
    furniture: /(move (?:furniture|sofa|bed|dresser|entertainment|sectional)|do you move.*furniture)/.test(t),
    process: /(how.*work|what.*process|steam|truck.?mount|hot water extraction)/.test(t),
    prep: /(prep|prepare|before you come|vacuum|water supply|hose|parking)/.test(t),
    leather: /\bleather\b/.test(t),
    upholsteryDry: /(upholstery).*(dry|how long)/.test(t),
    furnace: /\bfurnace\b/.test(t),
    dryerVent: /(dryer\s*vent|lint vent)/.test(t),
    sameDay: /(same[-\s]?day|today|next day|tomorrow).*?(available|availability|slot|open|appointment|service)/.test(t),

    // Additional intents
    odor: /(odor|odour|smell|urine|pee|pet\s*odor|pet\s*smell)/.test(t),
    waterDamage: /(water\s*damage|flood(?:ed|ing)?|standing\s*water|water\s*extraction)/.test(t),
    tileGrout: /\btile\b.*\bgrout\b|\bgrout\b.*\btile\b|tile\s*clean|grout\s*clean/i.test(t),
    hardwood: /(hard\s*wood|hardwood|wood\s*floor).*(clean|refinish|buff)?/i.test(t),
  };
}

// $100 minimum + 2R+Hall promo copy
const stanleyRebuttal = () =>
`We’re **Same Day Steamerz** — locally owned with **truck-mounted hot water extraction (~240°F)** and we stand behind every job.

**Why people switch from “big brands”:**
• **Straightforward pricing:** **$50 per area, $100 minimum.**  
• **Promo:** **2 rooms + 1 hallway = $100.**  
• **Extra value built in:**  
  – **4+ total areas:** your **first hallway is free**.  
  – **6+ total areas:** **one room free** **+** a **hallway free**.  
• **Deeper clean, included:** pre-spray, fiber rinse, and deodorizer — **no upsell games**.  
• **Flexible scheduling:** same-day/next-day when available.

Want me to price your home now?`;

const specialCopy = () =>
`Our **$50 special** is **$50 per area** with a **$100 minimum**.
**Promo:** **2 rooms + 1 hallway = $100**.

**Freebies built in**  
• **4+ total areas:** your **first hallway is free**.  
• **6+ total areas:** **one room free** + **a hallway free**.  

Includes **pre-spray, deodorizer, and a fiber rinse/sanitizer**.`;

/* ========================= Duct copy ========================= */
function ductIntroCopy() {
  return (
`**Air Duct Cleaning — What you get**

**1) Basic — $200 per system**  
• Full cleaning of **all supply vents/branches** using a powerful negative-pressure vacuum (HEPA).  

**2) Deep — $500 per system**  
• Everything in Basic, **plus** the **return side + trunks**, register cleaning, and **EPA-registered sanitizer** fogged through ducts.

Ready to choose a package?`);
}
const furnaceAddOnCopy = (pkg) =>
`**Furnace Cleaning — Recommended add-on (${pkg === "Deep" ? "+$100" : "+$200"} per system)**  
Open main return cabinet, remove buildup, **sanitize interior**. Add it now?`;
const dryerVentCopy =
`**Dryer Vent Cleaning — $200**  
• Removes flammable lint (reduce fire risk)  
• Restores airflow (faster drying)  
Add dryer vent cleaning?`;

/* ========================= FAQ Answers ========================= */
function answerFAQ(text="") {
  const qi = detectQuickIntents(text);
  if (qi.stanley) return stanleyRebuttal();
  if (qi.special) return specialCopy();

  if (qi.sameDay)   return "We often have **same-day or next-day availability**. Tell me your address and I’ll check the earliest arrival window.";
  if (qi.drytime)   return "Dry time is usually **4–8 hours**, depending on airflow, humidity, and carpet thickness.";
  if (qi.stain)     return "We treat most stains (coffee, wine, pet accidents). **Bleach or burns** can be permanent.";
  if (qi.petsKids)  return "Yes — all products are **pet- and child-safe** when used as directed.";
  if (qi.furniture) return "We don’t move large furniture (beds, dressers, entertainment centers, sectionals). Please clear small items.";
  if (qi.process)   return "We pre-spray, extract with **truck-mounted hot water (~240°F)**, then fiber rinse and deodorizer.";
  if (qi.prep)      return "Please vacuum areas, ensure parking/access for hoses, and have water supply available.";
  if (qi.leather)   return "We **do not clean leather upholstery** — fabric only.";
  if (qi.upholsteryDry) return "Upholstery dry time: synthetics in hours; natural fibers longer. Good airflow helps.";
  if (qi.furnace)   return "Furnace cabinet cleaning is **+$200 (Basic) / +$100 (Deep)** per system.";
  if (qi.dryerVent) return "Dryer vent cleaning is **$200**.";
  if (qi.odor)      return "We can treat **pet odors** with enzyme + hot-water extraction. If urine reached pad/subfloor, results vary; sealing/replacement may be needed.";
  if (qi.waterDamage) return "We **don’t offer water-damage/flood extraction** or remediation.";
  if (qi.tileGrout)   return "We **don’t offer tile & grout cleaning** currently.";
  if (qi.hardwood)    return "We **don’t offer hardwood floor cleaning** currently.";
  if (qi.location)    return "We cover **metro ATL and surrounding ZIPs**. Share your **ZIP code** and I’ll confirm.";
  return null;
}
function logFAQ(state, q, a) {
  if (!Array.isArray(state.faqLog)) state.faqLog = [];
  state.faqLog.push({ q, a, at: nowIso() });
}

/* ========================= Pricing (Carpet) ========================= */
function computeCarpetTotals(detail) {
  const d = { rooms:0, halls:0, stairs:0, extras:0, rugs:0, ...detail };
  const totalAreasBeforeFreebie = d.rooms + d.halls + d.stairs + d.extras + d.rugs;
  const freeHall = (totalAreasBeforeFreebie >= 4 && d.halls > 0) ? 1 : 0;
  const freeRoom = (totalAreasBeforeFreebie >= 6 && d.rooms > 0) ? 1 : 0;
  const chargeableRooms = Math.max(0, d.rooms - freeRoom);
  const chargeableHalls = Math.max(0, d.halls - freeHall);
  const billable = chargeableRooms + chargeableHalls + d.stairs + d.extras + d.rugs;
  let price = Math.max(100, billable * 50);
  if (d.rooms === 2 && d.halls === 1 && d.stairs === 0 && d.extras === 0 && d.rugs === 0) price = 100;

  const parts = [];
  if (d.rooms)  parts.push(`${d.rooms} room${d.rooms>1?"s":""}${freeRoom ? " (1 free)" : ""}`);
  if (d.halls)  parts.push(`${d.halls} hallway${d.halls>1?"s":""}${freeHall ? " (1 free)" : ""}`);
  if (d.stairs) parts.push(`${d.stairs} flight${d.stairs>1?"s":""} of stairs`);
  if (d.rugs)   parts.push(`${d.rugs} rug${d.rugs>1?"s":""}`);
  if (d.extras) parts.push(`${d.extras} extra area${d.extras>1?"s":""}`);
  return { billable, price, describedText: parts.join(", "), detail: { ...d, freeHall, freeRoom } };
}

function parseAreas(text="") {
  const t = text.toLowerCase();

  let rooms = 0;
  for (const m of t.matchAll(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s*(?:rooms?|bedrooms?)/g)) {
    rooms += numFromText(m[1]);
  }
  if (rooms === 0 && /\brooms?\b/.test(t)) rooms = 1;

  let halls = 0;
  const mh = t.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*hall(?:way|ways)?/);
  if (mh) halls = numFromText(mh[1]); else if (/\bhall(?:way|ways)?\b/.test(t)) halls = 1;

  let stairs = 0;
  const ms = t.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:flights?|stairs?)/);
  if (ms) stairs = numFromText(ms[1]); else if (/\b(?:flights?|stairs?)\b/.test(t)) stairs = 1;

  let rugs = 0;
  const mr = t.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:area\s*)?rugs?\b/);
  if (mr) rugs = numFromText(mr[1]); else if (/\b(?:area\s*)?rugs?\b/.test(t)) rugs = 1;

  let extras = 0;
  const extraPatterns = [
    "living room","family room","great room","den","bonus room","recreation room","rec room","game room",
    "media room","theater room","dining room","breakfast nook","sunroom","solarium","mudroom",
    "guest room","nursery","office","home office","loft","study","library","playroom","man cave","gym","exercise room"
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
  let total = 0, hasSectional = false;
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
        breakdown.push(`${it.type} (${it.seats} cushion${it.seats>1?"s":""})`);
      } else {
        breakdown.push(`${count} ${it.type}${count>1?"s":""}`);
      }
    }
  }
  if (!hasSectional) total = Math.max(150, total);
  return { total, breakdown, items };
}

function parseUph(text="") {
  const t = text.toLowerCase();
  const items = [];

  if (/\bsectional\b/.test(t)) {
    const ms = t.match(/sectional[^0-9]*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)/);
    const seats = ms ? numFromText(ms[1]) : 0;
    items.push({ type: "sectional", seats });
  }

  for (const key of ["sofa","loveseat","recliner","ottoman","dining chair","mattress"]) {
    const rx = key==="dining chair"
      ? /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:dining\s+)?chairs?/
      : new RegExp(`(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s*${key}s?`);
    const m = t.match(rx);
    if (m) items.push({ type: key, count: numFromText(m[1]) });
    else if (new RegExp(`\\b${key}s?\\b`).test(t)) items.push({ type: key, count: 1 });
  }

  return items.length ? priceUphFromItems(items) : { total:0, breakdown:[], items:[] };
}

/* ========================= Session + Turn Log helpers ========================= */
function initSessionState(state) {
  if (!state._sessionId)    state._sessionId = Math.random().toString(36).slice(2);
  if (!state._sessionStart) state._sessionStart = nowIso();
  if (!Array.isArray(state._turns)) state._turns = [];
  if (!state._firstMessageAt) state._firstMessageAt = nowIso();
  return state;
}
const displayAddress = s => s.Address || s.address || '';
const displayName    = s => s.name2025 || s.name || '';
const displayEmail   = s => s.email2025 || s.email || '';
const displayPhone   = s => normalizeDigits(s.phone2025 || s.phone || '');

function snapshotForSession(state){
  const parts = [];
  const total = totalPriceForZap(state);
  if (state.carpet)     parts.push(`Carpet: ${state.carpet.billable} areas (${state.carpet.describedText})`);
  if (state.upholstery) parts.push(`Upholstery: ${state.upholstery.breakdown?.join(", ") || ""}`);
  if (state.duct)       parts.push(`Duct: ${state.duct.pkg} x ${state.duct.systems}${state.duct.add?.furnace?`, furnace`:""}${state.duct.add?.dryer?`, dryer`:""}`);
  return parts.length ? `Snapshot: ${parts.join(" | ")} | Total so far: $${total}` : "";
}

function appendTurn(state, { user, bot, stepBefore, stepAfter, quickReplies, intentHandled, error }) {
  initSessionState(state);

  // last-seen stamps (useful to know activity)
  const now = nowIso();
  if (user) state._lastUserAt = now;
  if (bot)  state._lastBotAt  = now;

  // Contact snapshot as-of this turn
  const name = displayName(state);
  const phone = displayPhone(state);
  const email = displayEmail(state);
  const address = displayAddress(state);
  const zip = state.zip || "";

  state._turns.push({
    ts: now,
    user_message: user || "",
    bot_reply: bot || "",
    quick_replies: Array.isArray(quickReplies) ? quickReplies.join(" | ") : (quickReplies || ""),
    step_before: stepBefore || "",
    step_after: stepAfter || "",
    intentHandled: intentHandled || "",
    error: error ? String(error) : "",
    name, phone, email, address, zip,
    snapshot: snapshotForSession(state)
  });
}

function transcriptToText(turns=[]) {
  const lines = [];
  for (const r of turns) {
    lines.push(`[${r.ts}] STEP ${r.step_before} → ${r.step_after}`);
    if (r.user_message) lines.push(`U> ${r.user_message}`);
    if (r.bot_reply)     lines.push(`B> ${r.bot_reply}`);
    if (r.quick_replies) lines.push(`Q> ${r.quick_replies}`);
    if (r.intentHandled) lines.push(`I> ${r.intentHandled}`);
    if (r.error)         lines.push(`E> ${r.error}`);
  }
  return lines.join("\n");
}

function buildLineItemsFromTurns(turns=[]) {
  const li = {
    ts:[], user_message:[], bot_reply:[], quick_replies:[],
    step_before:[], step_after:[], intentHandled:[],
    name:[], phone:[], email:[], address:[], zip:[],
    snapshot:[], error:[]
  };
  for (const t of turns) {
    li.ts.push(t.ts || "");
    li.user_message.push(t.user_message || "");
    li.bot_reply.push(t.bot_reply || "");
    li.quick_replies.push(t.quick_replies || "");
    li.step_before.push(t.step_before || "");
    li.step_after.push(t.step_after || "");
    li.intentHandled.push(t.intentHandled || "");
    li.name.push(t.name || "");
    li.phone.push(t.phone || "");
    li.email.push(t.email || "");
    li.address.push(t.address || "");
    li.zip.push(t.zip || "");
    li.snapshot.push(t.snapshot || "");
    li.error.push(t.error || "");
  }
  return li;
}

async function postJSON(url, payload){
  try {
    await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
  } catch (err) {
    console.error("Webhook POST failed", err);
  }
}

function leadStatusFromState(state, reason) {
  if (reason === "booking_complete") return "Booked";
  if (reason === "OOA_handoff")      return "OOA";
  if (reason === "building_above_3rd_floor") return "Needs Rep";
  if (reason === "opt_out_before_booking")   return "Opted Out";
  if (reason === "client_finalize")          return "Archived";
  if (reason === "timeout")                  return "Abandoned";
  if (reason === "error")                    return "Error";
  return "Open";
}

function enrichFinalPayloadBase(state, reason, event) {
  const li = buildLineItemsFromTurns(state._turns || []);
  const firstAt = state._firstMessageAt || state._sessionStart || nowIso();
  const lastAt  = state._lastUserAt || state._lastBotAt || nowIso();

  return {
    event, // "final" or "start"
    channel: CHANNEL,
    bot_name: BOT_NAME,
    bot_version: BOT_VER,

    // Session core
    session_id: state._sessionId || "",
    session_started_at: state._sessionStart || "",
    session_first_message_at: firstAt,
    session_last_activity_at: lastAt,
    session_ended_at: event === "final" ? nowIso() : "",

    // Timeouts
    timeout_minutes: clampMin(state._turnLogTimeoutMin || DEFAULT_TIMEOUT_MIN, 1),
    timeout_due_at: state._turnLogDueAt ? tsToIso(state._turnLogDueAt) : "",

    // Reason/status
    reason: reason || "",
    lead_status: leadStatusFromState(state, reason),

    // Contact snapshot (final-as-known)
    name: displayName(state),
    phone: displayPhone(state),
    email: displayEmail(state),
    address: displayAddress(state),
    zip: state.zip || "",

    // Sales snapshot
    services: selectedServiceForZap(state),
    cleaning_breakdown: buildCleaningBreakdownForZap(state),
    total_price: totalPriceForZap(state),

    // Journey flags
    service_selected: !!state._serviceSelected,
    service_selected_at: state._serviceSelectedAt || "",
    upsell_offered: !!(state.addingUphAfterCarpet || state.addingCarpetAfterUph),
    upsell_path: state.addingUphAfterCarpet ? "UphAfterCarpet"
               : state.addingCarpetAfterUph ? "CarpetAfterUph" : "",
    address_confirmed: !!displayAddress(state),
    name_confirmed: !!displayName(state),
    phone_confirmed: /^\d{10}$/.test(displayPhone(state) || ""),
    email_confirmed: !!displayEmail(state),
    date_selected: state.date || "",
    window_selected: state.window || "",
    building_type: state.building || "",
    floor: state.floor || "",
    pets: state.pets || "",
    outdoor_water: state.outdoorWater || "",

    // FAQ/Transcript
    faq_count: Array.isArray(state.faqLog) ? state.faqLog.length : 0,
    faq_log_json: JSON.stringify(state.faqLog || []),
    transcript: transcriptToText(state._turns || []),

    // Per-turn arrays (so Zap can loop OR create line-items)
    turns_json: state._turns || [],
    ...li
  };
}

async function sendStartTurnLogOnce(state, reason) {
  try {
    initSessionState(state);
    if (state._turnLogStartSent) return;
    state._turnLogStartSent = true;

    // establish timeout window for dashboarding
    state._turnLogTimeoutMin = state._turnLogTimeoutMin || DEFAULT_TIMEOUT_MIN;
    state._turnLogDueAt = Date.now() + state._turnLogTimeoutMin * 60 * 1000;

    const payload = enrichFinalPayloadBase(state, reason || "service_selected", "start");
    await postJSON(ZAPIER_TURNLOG_URL, payload);
  } catch (e) {
    console.error("Start Turn Log failed", e);
  }
}

async function sendFinalTurnLogOnce(state, reason) {
  try {
    initSessionState(state);
    if (state._turnLogSent) return;
    state._turnLogSent = true;

    const payload = enrichFinalPayloadBase(state, reason, "final");
    await postJSON(ZAPIER_TURNLOG_URL, payload);
  } catch (e) {
    console.error("Final Turn Log failed", e);
  }
}

/* === Helpers to build Zap payloads (unchanged two Zaps) === */
function buildCleaningBreakdownForZap(state){
  const lines = [];
  if (state.carpet)     lines.push(`Carpet — ${state.carpet.billable} area(s) (${state.carpet.describedText}) — $${state.carpet.price}`);
  if (state.upholstery) lines.push(`Upholstery — ${state.upholstery.breakdown?.join(", ") || ""} — $${state.upholstery.total}`);
  if (state.duct)       lines.push(`Duct — ${state.duct.pkg} (${state.duct.systems} system${state.duct.systems>1?"s":""}${state.duct.add?.furnace?`, +furnace`:""}${state.duct.add?.dryer?`, +dryer vent`:""}) — $${state.duct.total}`);
  return lines.join("\n");
}
function selectedServiceForZap(state){
  const s = [];
  if (state.carpet) s.push("Carpet");
  if (state.upholstery) s.push("Upholstery");
  if (state.duct) s.push("Air Duct");
  return s.join(" + ");
}
function totalPriceForZap(state){
  return (state.carpet?.price || 0) + (state.upholstery?.total || 0) + (state.duct?.total || 0);
}

/* ========================= Follow-up helpers ========================= */
function armFollowUp(state, minutes=10) {
  const ms = clampMin(minutes, 5) * 60 * 1000;
  state._followUpArmed = true;
  state._followUpDueAt = Date.now() + ms;
}
function disarmFollowUp(state) {
  state._followUpArmed = false;
  state._followUpDueAt = 0;
}
function hasContact(state){ 
  return !!(state.name && state.phone && /^\d{10}$/.test(state.phone)); 
}
async function sendSessionIfEligible(state, reason){
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
    await fetch(ZAPIER_SESSION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: encodeForm(payload)
    });
    state._sessionSent = true; 
  } catch(e){ 
    console.error("Session Zap failed", e); 
  }
}

/* ========================= Reuse prompts ========================= */
function promptAddress(state) {
  const addr = displayAddress(state);
  if (addr) {
    state.step = "confirm_reuse_address";
    return { reply: `Use this service address?\n${addr}`, quickReplies: ["Yes","No"], state };
  }
  state.step = "collect_address";
  return { reply: `What’s the full service address? (street + city + state + ZIP — commas optional)`, state };
}
function promptName(state) {
  const name = displayName(state);
  if (name) {
    state.step = "confirm_reuse_name";
    return { reply: `Use this name? ${name}`, quickReplies: ["Yes","No"], state };
  }
  state.step = "collect_name";
  return { reply: `What’s your full name? (First and last name)`, state };
}
function promptPhone(state) {
  const digits = displayPhone(state);
  if (digits && /^\d{10}$/.test(digits)) {
    state.step = "confirm_reuse_phone";
    return { reply: `Use this phone number? ${formatPhone(digits)}`, quickReplies: ["Yes","No"], state };
  }
  state.step = "collect_phone";
  return { reply: `What’s the best phone number to reach you?`, state };
}
function promptEmail(state) {
  const email = displayEmail(state);
  if (email) {
    state.step = "confirm_reuse_email";
    return { reply: `Use this email? ${email}`, quickReplies: ["Yes","No"], state };
  }
  state.step = "collect_email";
  return { reply: `What’s your email address?`, state };
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

/* ========================= Smart Corrections ========================= */
// Safe no-op to prevent crashes if not using any smart auto-fixes.
// (You can replace with your previous implementation later.)
function applySmartCorrections(/* text, state */) {
  return null;
}
/* ========================= API Handler ========================= */
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body   = req.body || {};
    const user   = (body.message || "").trim();
    const msg    = user.toLowerCase();
    let state    = body.state || {};
    if (!Array.isArray(state.faqLog)) state.faqLog = [];
    initSessionState(state);

    // Helper: respond + record the turn (no Zap here)
    const stepBefore = state.step || "choose_service";
    const respond = async (out, meta={}) => {
      try {
        const st = out && out.state ? out.state : state;
        appendTurn(st, {
          user: user || (body.init ? "INIT" : ""),
          bot: out && out.reply ? out.reply : "",
          stepBefore,
          stepAfter: (st && st.step) || "",
          quickReplies: out && out.quickReplies,
          intentHandled: out && out.intentHandled,
          error: out && out.error
        });
        if (meta.flushReason) {
          await sendFinalTurnLogOnce(st, meta.flushReason);
        }
        return res.status(200).json(out);
      } catch (e) {
        console.error("respond() failed", e);
        return res.status(200).json(out || { reply: "Okay." });
      }
    };

    // Idle follow-up timeout → send partial + finalize turn log on next ping after due
    if (state._followUpArmed && state._followUpDueAt && Date.now() >= state._followUpDueAt && state.step !== "collect_notes") {
      await sendSessionIfEligible(state, "timeout");
      await sendFinalTurnLogOnce(state, "timeout");
      disarmFollowUp(state);
    }

    // Optional explicit finalize (debug/testing)
    if (body.finalize === true) {
      await sendFinalTurnLogOnce(state, "client_finalize");
      return respond({ reply: "Session archived. How else can I help?", quickReplies: SERVICE_CHOICES, state: { step:"choose_service", faqLog: state.faqLog } });
    }

    // First load
    if (body.init) return respond(intro());

    // Smart corrections FIRST
    const correctionReply = applySmartCorrections(user, state);
    if (correctionReply) {
      if (typeof correctionReply === "string") {
        return respond({ reply: correctionReply, state });
      } else {
        return respond({ ...correctionReply, state });
      }
    }

    // FAQ any time
    const incomingQuestion = body.intent === "faq" ? (body.question || user) : (isQuestion(user) ? user : null);
    if (incomingQuestion) {
      const ans = answerFAQ(incomingQuestion);
      if (ans) { logFAQ(state, incomingQuestion, ans); return respond({ reply: ans, state, intentHandled: "faq" }); }
    }

    /* ---------------- Router helpers ---------------- */
    function preBookingSummary(state) {
      const parts = [];
      if (state.carpet)     parts.push(`Carpet — ${state.carpet.billable} area(s) (${state.carpet.describedText}) — $${state.carpet.price}`);
      if (state.upholstery) parts.push(`Upholstery — ${state.upholstery.breakdown?.length ? state.upholstery.breakdown.join(", ") : "selected items"} — $${state.upholstery.total}`);
      if (state.duct)       parts.push(`Duct — ${state.duct.pkg} (${state.duct.systems} system${state.duct.systems>1?"s":""}${state.duct.add?.furnace?`, +furnace`:""}${state.duct.add?.dryer?`, +dryer vent`:""}) — $${state.duct.total}`);
      const total = (state.carpet?.price || 0) + (state.upholstery?.total || 0) + (state.duct?.total || 0);
      return `**Quick summary so far**
${parts.join("\n")}
**Combined total:** $${total}

Proceed with booking?`;
    }

    switch (state.step || "choose_service") {
      /* ========== Choose service ========== */
      case "choose_service": {
        let choice = null;
        if (/duct|air\s*duct/.test(msg)) choice = "duct";
        if (/(upholstery|sectional|sofa|loveseat|recliner|ottoman|chair|mattress)/.test(msg)) choice = "upholstery";
        if (/(carpet|rooms?|hall|stairs|flight|rugs?)/.test(msg)) choice = "carpet";
        if (!choice) {
          return respond({
            reply: "Please choose carpet cleaning, upholstery cleaning, or air duct cleaning.",
            quickReplies: SERVICE_CHOICES, state
          });
        }

        // Mark first service selection + start log once (for Zapier Delay 10m)
        state._serviceSelected = true;
        state._serviceSelectedAt = nowIso();
        // Establish a Turn Log timeout window Zap can use (10m by default)
        state._turnLogTimeoutMin = state._turnLogTimeoutMin || DEFAULT_TIMEOUT_MIN;
        state._turnLogDueAt = Date.now() + state._turnLogTimeoutMin * 60 * 1000;
        // OPTIONAL early ping (won't create extra rows if your Zap does upsert by session_id)
        await sendStartTurnLogOnce(state, "service_selected");

        if (choice === "carpet") {
          state.step = "carpet_details";
          return respond({ reply: `What areas would you like us to clean? (e.g., “3 rooms, hallway, 2 rugs, stairs”)`, state });
        }
        if (choice === "upholstery") {
          state.step = "upholstery_details";
          return respond({ reply: `What upholstery pieces would you like cleaned? (sectional, sofa, loveseat, recliner, ottoman, dining chairs, mattress)`, quickReplies: UPH_CHOICES, state });
        }
        state.step = "duct_package";
        return respond({ reply: ductIntroCopy(), quickReplies: ["Basic","Deep"], state });
      }

      /* ========== Carpet flow ========== */
      case "carpet_details": {
        const parsed = parseAreas(user);
        if (parsed.billable === 0) {
          return respond({ reply: `Please describe the carpet areas again (e.g., “4 rooms, 1 hallway, 1 rug”, or “3 rooms and stairs”).`, state });
        }
        state.carpet = parsed;
        state.step   = "carpet_confirm";
        return respond({
          reply: `For ${parsed.billable} area(s) (${parsed.describedText}) the total is **$${parsed.price}**.\n\nMove forward with carpet?`,
          quickReplies: ["Yes, move forward", "Change areas", "No, not now"],
          state
        });
      }

      case "carpet_confirm": {
        if (/change/i.test(msg)) {
          state.step = "carpet_details";
          return respond({ reply: `No problem — tell me the carpet areas again.`, state });
        }
        if (/no|not now|skip/i.test(msg)) {
          await sendSessionIfEligible(state, "user opted out before notes");
          await sendFinalTurnLogOnce(state, "opt_out_before_booking");
          state = { step: "choose_service", faqLog: state.faqLog };
          return respond({
            reply: `All good – if you’d like a quote later just say “carpet”, “upholstery”, or “ducts”.`,
            quickReplies: SERVICE_CHOICES,
            state
          });
        }
        if (state.upholstery?.total || state.duct?.total) {
          state.step = "confirm_combined_proceed";
          return respond({
            reply: preBookingSummary(state),
            quickReplies: ["Proceed", "Change items"],
            state
          });
        }
        state.step = "uph_upsell_offer";
        return respond({
          reply: `Nice — since you’re booking carpet, you’re eligible for **$50 off upholstery**. Want to add upholstery cleaning?`,
          quickReplies: ["Yes, add upholstery", "No, skip"],
          state
        });
      }

      case "uph_upsell_offer": {
        if (/no|skip/i.test(msg)) return respond(promptAddress(state));
        state.addingUphAfterCarpet = true;
        state.step = "upholstery_details";
        return respond({ reply: `Great — what upholstery pieces would you like cleaned?`, quickReplies: UPH_CHOICES, state });
      }

      /* ========== Upholstery flow ========== */
      case "upholstery_details": {
        if (/\bsofa\b/i.test(user) && !/\d/.test(user)) {
          state.step = "upholstery_cushions";
          state._cushionTarget = "sofa";
          state._cushionContext = user;
          return respond({
            reply: `How many cushions are on the sofa?`,
            quickReplies: ["1","2","3","4"],
            state
          });
        }
        if (/\bloveseat\b/i.test(user) && !/\d/.test(user)) {
          state.step = "upholstery_cushions";
          state._cushionTarget = "loveseat";
          state._cushionContext = user;
          return respond({
            reply: `How many cushions are on the loveseat?`,
            quickReplies: ["1","2","3","4"],
            state
          });
        }

        const parsed = parseUph(user);
        if (!parsed.breakdown.length) {
          return respond({ reply: `Please list pieces like “sectional 6 seats”, “two recliners”, or “sofa and ottoman”.`, quickReplies: UPH_CHOICES, state });
        }
        state.upholstery = { total: parsed.total, breakdown: parsed.breakdown };

        if (/\bsectional\b/i.test(user) && !/\d/.test(user)) {
          state.step = "upholstery_sectional_seats";
          return respond({ reply: `For the sectional — how many seats/cushions?`, quickReplies: ["3","4","5","6","7"], state });
        }

        state.step = "upholstery_confirm";
        return respond({
          reply: `Your upholstery total is **$${parsed.total}** for ${parsed.breakdown.join(", ")}.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items", "Skip"],
          state
        });
      }

      case "upholstery_cushions": {
        const seats = numFromText(msg);
        if (!seats) {
          return respond({
            reply: `How many cushions?`,
            quickReplies: ["1","2","3","4"],
            state
          });
        }
        const target = state._cushionTarget || "sofa";
        const ctx = (state._cushionContext || "").toLowerCase();
        let rest = ctx.replace(new RegExp(`\\b${target}\\b`,"i"), "");
        const restParsed = parseUph(rest);
        const combined = priceUphFromItems([{ type: target, count:1, seats }, ...(restParsed.items||[])]);
        state.upholstery = { total: combined.total, breakdown: combined.breakdown };
        state._cushionTarget = null;
        state._cushionContext = null;

        state.step = "upholstery_confirm";
        return respond({
          reply: `Your upholstery total is **$${combined.total}** for ${combined.breakdown.join(", ")}.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items", "Skip"],
          state
        });
      }

      case "upholstery_sectional_seats": {
        const seats = numFromText(msg);
        if (!seats) return respond({ reply: `How many seats? (e.g., 4, 5, 6)`, quickReplies: ["3","4","5","6","7"], state });
        const merged = priceUphFromItems([{ type:"sectional", seats }]);
        state.upholstery = { total: merged.total, breakdown: merged.breakdown };
        state.step = "upholstery_confirm";
        return respond({
          reply: `Your sectional price is **$${merged.total}**.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items", "Skip"],
          state
        });
      }

      case "upholstery_confirm": {
        if (/change/i.test(msg)) {
          state.step = "upholstery_details";
          return respond({
            reply: `No problem — tell me the upholstery pieces again.`,
            quickReplies: UPH_CHOICES,
            state
          });
        }
        if (/skip|no/i.test(msg)) return respond(promptAddress(state));

        if (state.carpet?.price || state.duct?.total) {
          state.step = "confirm_combined_proceed";
          return respond({
            reply: preBookingSummary(state),
            quickReplies: ["Proceed", "Change items"],
            state
          });
        }
        state.step = "carpet_upsell_offer";
        return respond({
          reply: `Since you’re booking upholstery, you qualify for a **free hallway** at 4+ areas, and at **6+** you also get **one room free**. Want me to price carpet too?`,
          quickReplies: ["Yes, add carpet", "No, skip"],
          state
        });
      }

      case "confirm_combined_proceed": {
        if (/proceed|yes/i.test(msg)) return respond(promptAddress(state));
        if (/change|edit|update|back/i.test(msg)) {
          const opts = [];
          if (state.carpet)      opts.push("Change carpet");
          if (state.upholstery)  opts.push("Change upholstery");
          if (state.duct)        opts.push("Change duct");
          if (!opts.length)      opts.push("No changes");
          state.step = "confirm_combined_edit_picker";
          return respond({
            reply: `What would you like to change?`,
            quickReplies: opts.concat(["Cancel"]),
            state
          });
        }
        return respond({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
      }

      case "confirm_combined_edit_picker": {
        if (/cancel|no changes/i.test(msg)) {
          state.step = "confirm_combined_proceed";
          return respond({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
        }
        if (/change carpet/i.test(msg)) { state.step = "carpet_details"; return respond({ reply: `Tell me the carpet areas again.`, state }); }
        if (/change upholstery/i.test(msg)) {
          state.step = "upholstery_details";
          return respond({ reply: `Tell me the upholstery pieces again.`, quickReplies: UPH_CHOICES, state });
        }
        if (/change duct/i.test(msg)) {
          state.step = "duct_package";
          return respond({ reply: ductIntroCopy(), quickReplies: ["Basic","Deep"], state });
        }
        return respond({ reply: `Tap one of the options to change, or Cancel to proceed.`, state });
      }

      /* ========== Carpet upsell after upholstery ========== */
      case "carpet_upsell_offer": {
        if (/no|skip/i.test(msg)) return respond(promptAddress(state));
        state.addingCarpetAfterUph = true;
        state.step = "carpet_details";
        return respond({ reply:`Awesome — how many carpet areas should I price? (e.g., “3 rooms, hallway, 1 rug”).`, state });
      }

      /* ========== Duct flow ========== */
      case "duct_package": {
        if (!/basic|deep/.test(msg)) {
          state.step = "duct_package";
          return respond({ reply: ductIntroCopy(), quickReplies: ["Basic","Deep"], state });
        }
        state.duct = { pkg: /deep/.test(msg) ? "Deep" : "Basic", systems: 1, add: { furnace:false, dryer:false } };
        state.step = "duct_systems";
        return respond({
          reply: `Great — you chose **${state.duct.pkg}**. How many **HVAC systems** do you have?`,
          quickReplies: ["1","2","3","4"],
          state
        });
      }

      case "duct_systems": {
        const n = Math.max(1, numFromText(msg));
        if (!n) return respond({ reply: `How many systems should I price for? (e.g., 1 or 2)`, quickReplies: ["1","2","3","4"], state });
        state.duct.systems = n;
        state.step = "duct_add_furnace";
        return respond({
          reply: furnaceAddOnCopy(state.duct.pkg),
          quickReplies: ["Add furnace", "No furnace"],
          state
        });
      }

      case "duct_add_furnace": {
        state.duct.add.furnace = /add/.test(msg);
        state.step = "duct_add_dryer";
        return respond({ reply: dryerVentCopy, quickReplies: ["Add dryer vent","No add-ons"], state });
      }

      case "duct_add_dryer": {
        state.duct.add.dryer = /add/.test(msg);
        const base = state.duct.pkg === "Deep" ? 500 : 200;
        let total = state.duct.systems * base;
        if (state.duct.add.furnace) total += state.duct.systems * (state.duct.pkg === "Deep" ? 100 : 200);
        if (state.duct.add.dryer)   total += 200;
        state.duct.total = total;

        state.step = "duct_confirm";
        return respond({ reply: `Your **${state.duct.pkg}** duct cleaning total is **$${total}** (${state.duct.systems} system${state.duct.systems>1?"s":""}${state.duct.add.furnace?`, +furnace`:""}${state.duct.add.dryer?`, +dryer vent`:""}). Proceed?`, quickReplies: ["Proceed","Change","Skip"], state });
      }

      case "duct_confirm": {
        if (/change/i.test(msg)) { state.step = "duct_systems"; return respond({ reply:`No problem — how many systems should I price for?`, quickReplies: ["1","2","3","4"], state }); }
        if (/skip|no/i.test(msg)) return respond(promptAddress(state));
        return respond(promptAddress(state));
      }

      /* ========== Address → Name → Phone → Email → Date → Window → Pets → Water → Building → Floor → Notes ========== */
      case "confirm_reuse_address": {
        if (/^y/i.test(msg)) return respond(promptName(state));
        state.address=""; state.Address=""; state.step = "collect_address";
        return respond({ reply: `What’s the full service address? (street + city + state + ZIP — commas optional)`, state });
      }
      case "confirm_reuse_name": {
        if (/^y/i.test(msg)) return respond(promptPhone(state));
        state.name=""; state.name2025=""; state.step = "collect_name";
        return respond({ reply: `What’s your full name? (First and last name)`, state });
      }
      case "confirm_reuse_phone": {
        if (/^y/i.test(msg)) return respond(promptEmail(state));
        state.phone=""; state.phone2025=""; state.step = "collect_phone";
        return respond({ reply: `What’s the best phone number to reach you?`, state });
      }
      case "confirm_reuse_email": {
        if (/^y/i.test(msg)) { state.step="collect_date"; armFollowUp(state, 10); return respond({ reply:`What day would you like the cleaning? (e.g., July 10 or 07/10)`, state }); }
        state.email=""; state.email2025=""; state.step = "collect_email";
        return respond({ reply: `What’s your email address?`, state });
      }

      case "collect_address": {
        if (isQuestion(user)) {
          const a = answerFAQ(user);
          if (a) {
            logFAQ(state, user, a);
            return respond({ reply: a + `\n\nWhat’s the full service address? (street + city + state + ZIP — commas optional)`, state, intentHandled:"faq" });
          }
          return respond({ reply: `I can help with that, but first I need your address. What’s the full service address? (street + city + state + ZIP — commas optional)`, state });
        }

        const zipMatch = user.match(/\b(\d{5})(?:-\d{4})?\b/);
        const hasStreet = /^\s*\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .,'-]*\b/.test(user);
        const hasState  = /\b(AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/i.test(user);

        if (!zipMatch || !hasStreet || !hasState) {
          return respond({ reply: `Please provide your **full service address** (street + city + state + ZIP). Commas are optional.\nExample: "2314 College St Atlanta GA 30307"`, state });
        }

        const zip = zipMatch[1];

        if (validZipCodes && !validZipCodes.includes(zip)) {
          state.address = user.trim().replace(/\s{2,}/g, " ");
          state.zip = zip;
          state.step = "ooa_collect_phone";
          return respond({
            reply: `Thanks! Unfortunately, that address looks **outside our service area**.\nWe can have a team member call to see if we can make it work.\n\nWhat’s the best **phone number** to reach you?`,
            state
          });
        }

        state.address = user.trim().replace(/\s{2,}/g, " ");
        state.Address = state.address;
        state.zip     = zip;
        return respond(promptName(state));
      }

      case "ooa_collect_phone": {
        const digits = (user.match(/\d/g) || []).join("");
        if (digits.length !== 10) return respond({ reply: `Please enter a valid **10-digit** phone number we can call.`, state });
        state.phone = digits; state.step  = "ooa_collect_name";
        return respond({ reply: `Thanks. **Who should we ask for?** (First and last name)`, state });
      }

      case "ooa_collect_name": {
        if (!/\b[a-z][a-z]+(?:[-' ]?[a-z]+)?\s+[a-z][a-z]+\b/i.test(user)) {
          return respond({ reply: `Please provide both a **first and last name**.`, state });
        }
        state.name = user.trim();
        const handoffMsg = `Thanks, ${state.name}! We’ll review your address (${state.address}) and call ${formatPhone(state.phone)} to see if we can service your area.`;

        await sendSessionIfEligible(state, "OOA handoff");
        await sendFinalTurnLogOnce(state, "OOA_handoff");

        state = { step: "choose_service", faqLog: [] };
        return respond({ reply: handoffMsg, quickReplies: SERVICE_CHOICES, state });
      }

      case "collect_name": {
        if (!/\b[a-z][a-z]+(?:[-' ]?[a-z]+)?\s+[a-z][a-z]+\b/i.test(user)) {
          return respond({ reply: `Please provide your **first and last name**.`, state });
        }
        state.name = user.trim();
        return respond(promptPhone(state));
      }

      case "collect_phone": {
        const digits = (user.match(/\d/g) || []).join("");
        if (digits.length !== 10) return respond({ reply:`Please enter a valid **10-digit** phone number.`, state });
        state.phone = digits;

        // Fire Partial/Session once (name + phone captured)
        try { await sendSessionIfEligible(state, "got phone"); } catch (e) { console.error("Session (got phone) emit failed", e); }

        armFollowUp(state, 10);
        return respond(promptEmail(state));
      }

      case "collect_email": {
        if (!/^[\w.\-+]+@[\w.\-]+\.\w{2,}$/i.test(user)) return respond({ reply:`Please enter a valid email address.`, state });
        state.email = user.trim();
        state.step  = "collect_date";
        armFollowUp(state, 10);
        return respond({ reply:`What day would you like the cleaning? (e.g., July 10 or 07/10)`, state });
      }

      case "collect_date": {
        let d = null;
        const now = new Date();
        const thisYear = now.getFullYear();

        if (/^[0-1]?\d\/[0-3]?\d$/.test(user.trim())) {
          const [mm, dd] = user.split("/").map(x=>+x);
          d = new Date(thisYear, mm-1, dd);
          if (d < new Date(thisYear, now.getMonth(), now.getDate())) d = new Date(thisYear+1, mm-1, dd);
        } else {
          const tryD = Date.parse(user);
          if (!Number.isNaN(tryD)) d = new Date(tryD);
        }
        if (!d) return respond({ reply:`Please enter a date like “July 10” or “07/10”.`, state });

        const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (midnight < todayMid) return respond({ reply:`Let’s pick a date today or later. What date works?`, state });

        state.date = d.toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });
        state.step = "collect_window";
        armFollowUp(state, 10);
        return respond({ reply:`Which time frame works best for you?`, quickReplies: TIME_WINDOWS, state });
      }

      case "collect_window": {
        if (!TIME_WINDOWS.includes(user.trim())) return respond({ reply:`Please pick one:`, quickReplies: TIME_WINDOWS, state });
        state.window = user.trim();
        state.step   = "collect_pets";
        armFollowUp(state, 10);
        return respond({ reply:`Are there any pets we should know about?`, quickReplies: ["Yes","No"], state });
      }

      case "collect_pets": {
        state.pets = /^y/i.test(msg) ? "Yes" : "No";
        state.step = "collect_water";
        armFollowUp(state, 10);
        return respond({ reply:`Do you have an outdoor water supply available?`, quickReplies: ["Yes","No"], state });
      }

      case "collect_water": {
        state.outdoorWater = /^y/i.test(msg) ? "Yes" : "No";
        state.step = "collect_building";
        armFollowUp(state, 10);
        return respond({ reply: `Is it a house or apartment?`, quickReplies: ["House", "Apartment"], state });
      }

      case "collect_building": {
        if (/house/i.test(msg)) {
          state.building = "House";
          state.step = "collect_notes";
          state.__notesPrompted = true;
          return respond({ reply: `Do you have any notes or special instructions?`, quickReplies: ["Yes, I have notes","No, continue"], state });
        }
        if (/apart/i.test(msg)) {
          state.building = "Apartment";
          state.step = "collect_floor";
          armFollowUp(state, 10);
          return respond({ reply: `What floor is the apartment on?`, quickReplies: ["1","2","3","4"], state });
        }
        return respond({ reply: `Please choose: House or Apartment?`, quickReplies: ["House", "Apartment"], state });
      }

      case "collect_floor": {
        const fl = numFromText(msg);
        if (!fl) return respond({ reply: `Please tell me which floor the apartment is on (e.g., 1, 2, 3, or 4).`, quickReplies: ["1","2","3","4"], state });
        state.floor = fl;
        if (fl > 3) {
          state.step = "end_for_rep";
          await sendSessionIfEligible(state, "building above 3rd floor");
          await sendFinalTurnLogOnce(state, "building_above_3rd_floor");
          disarmFollowUp(state);
          return respond({ reply: `Since it’s above the 3rd floor, a sales rep will contact you to confirm if service is possible.`, state });
        }
        state.step = "collect_notes";
        state.__notesPrompted = true;
        return respond({ reply: `Do you have any notes or special instructions?`, quickReplies: ["Yes, I have notes","No, continue"], state });
      }

      case "collect_notes": {
        if (!state.__notesPrompted) {
          state.__notesPrompted = true;
          return respond({ reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes","No, continue"], state });
        }

        if (/^\s*yes/i.test(user)) {
          return respond({ reply: "Please type your notes or special instructions:", state });
        }

        if (/^\s*no/i.test(user)) state.notes = "-";
        else state.notes = (user || "").trim() || "-";

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
        try {
          await fetch(ZAPIER_BOOKING_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
            body: encodeForm(bookingPayload)
          });
        } catch (err) { console.error("Booking Zap failed", err); }

        // ONE final Turn Log (booking path)
        await sendFinalTurnLogOnce(state, "booking_complete");

        const parts = [];
        if (state.carpet)     parts.push(`Carpet — ${state.carpet.billable} area(s) (${state.carpet.describedText}) — $${state.carpet.price}`);
        if (state.upholstery) parts.push(`Upholstery — ${state.upholstery.breakdown?.join(", ") || ""} — $${state.upholstery.total}`);
        if (state.duct)       parts.push(`Duct — ${state.duct.pkg} (${state.duct.systems} system${state.duct.systems>1?"s":""}${state.duct.add?.furnace?`, +furnace`:""}${state.duct.add?.dryer?`, +dryer vent`:""}) — $${state.duct.total}`);
        const total = (state.carpet?.price || 0) + (state.upholstery?.total || 0) + (state.duct?.total || 0);
        const summary =
`**Booking summary**
${parts.join("\n")}
**Total:** $${total}

**Name:** ${state.name || "-"}
**Phone:** ${state.phone ? formatPhone(state.phone) : "-"}
**Email:** ${state.email || "-"}
**Address:** ${state.address || "-"}
**Preferred Day:** ${state.date || "-"}
**Arrival Time:** ${state.window || "-"}
**Pets:** ${state.pets || "-"}   **Outdoor Water:** ${state.outdoorWater || "-"}
**Building:** ${state.building || "-"}${state.floor?` (Floor ${state.floor})`:""}
**Notes:** ${state.notes || "-"}

If you would like to make any changes to your work order, please give the dispatcher a call at (678) 929-8202.`;

        state.step = "post_summary_offer";

        return respond({
          reply: summary + "\n\nBefore you go — would you like to hear about " +
            (state.duct ? "our **carpet or upholstery** cleaning as well?"
                        : "our **air duct cleaning** service too?"),
          quickReplies: state.duct ? ["Carpet", "Upholstery", "No thanks"] : ["Tell me about duct cleaning", "No thanks"],
          state
        });
      }

      case "post_summary_offer": {
        if (/no|thanks/i.test(msg)) {
          // final log already sent at booking_complete
          state = { step:"choose_service", faqLog: state.faqLog };
          return respond({ reply:`Got it! If you need anything else, just say “carpet”, “upholstery”, or “ducts”.`, quickReplies: SERVICE_CHOICES, state });
        }
        if (state.duct) {
          if (/carpet/i.test(msg)) { state.step="carpet_details"; return respond({ reply:`Great — tell me the carpet areas (e.g., “4 rooms, hallway, 1 rug”).`, state }); }
          if (/uphol/i.test(msg))  { state.step="upholstery_details"; return respond({ reply:`Great — what upholstery pieces should we add?`, quickReplies: UPH_CHOICES, state }); }
        } else {
          if (/duct|tell me/i.test(msg)) { state.step="duct_package"; return respond({ reply: ductIntroCopy(), quickReplies:["Basic","Deep"], state }); }
        }
        state = { step:"choose_service", faqLog: state.faqLog };
        return respond({ reply:`No problem. If you’d like another quote, pick a service:`, quickReplies: SERVICE_CHOICES, state });
      }

      default: {
        state = { step: "choose_service", faqLog: state.faqLog || [] };
        return respond(intro());
      }
    }
  } catch (err) {
    console.error("chat.js error", err);
    const out = {
      reply: `Sorry — something glitched on my end, but I’m still here. Tell me “carpet”, “upholstery”, or “ducts” and I’ll price it.`,
      state: { step: "choose_service", faqLog: [] },
      error: String(err && err.message || err)
    };
    // Best-effort final log on error
    try { await sendFinalTurnLogOnce((req && req.body && req.body.state) || {}, "error"); } catch(e) {}
    return res.status(200).json(out);
  }
};

/* ========================= ZAP SENDERS (form-encoded; unchanged two) ========================= */
async function sendBookingZapFormEncoded(payload){
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
async function sendSessionZapFormEncoded(payload){
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
