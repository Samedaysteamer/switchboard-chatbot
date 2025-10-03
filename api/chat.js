// Same Day Steamerz — production chat with 3 Zapier webhooks
// - TURN LOG (one-time per session *at end*): u9477fj   (given)
// - PARTIAL/SESSION (captured once after phone or special handoffs): env ZAP_SESSION_URL
// - COMPLETE BOOKING: u13zg9e
//
// Notes:
// • We DO NOT zap per turn. We append each turn to state._turns and send ONE final log at session end.
// • Session-end points: booking complete, OOA handoff, >3rd floor handoff, explicit opt-out path,
//   or follow-up timeout. Guarded by state._turnLogSent to prevent duplicates.

const fetch = global.fetch || require("node-fetch");

/* ========================= Webhooks ========================= */
// 🔒 TURN LOG (one-time at session end) — given by Ben
const ZAPIER_TURNLOG_URL = "https://hooks.zapier.com/hooks/catch/3165661/u9477fj/";
// ✅ COMPLETE BOOKING
const ZAPIER_BOOKING_URL = "https://hooks.zapier.com/hooks/catch/3165661/u13zg9e/";
// ✅ PARTIAL / SESSION — supply via env so it never collides with the Turn Log
const ZAPIER_SESSION_URL = process.env.ZAP_SESSION_URL || ""; // e.g. https://hooks.zapier.com/hooks/catch/3165661/xxxxxxxx/

/* ========================= Utilities ========================= */
const SMALL = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20 };
const TENS  = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };

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
const numFromText = (s="") => { const m = s.match(/\d+/); return m ? +m[0] : wordsToNumber(s); };
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

// Cap long strings so Google Sheets / Zap steps don't choke
function safeStr(v, max = 25000) {
  const s = (v == null) ? "" : String(v);
  return s.length > max ? s.slice(0, max) + `\n[TRUNCATED ${s.length - max} chars]` : s;
}

/* ====== Session transcript helpers (single final Turn Log) ====== */
function initSessionState(state) {
  if (!state._sessionId) state._sessionId = Math.random().toString(36).slice(2);
  if (!state._sessionStart) state._sessionStart = new Date().toISOString();
  if (!Array.isArray(state._turns)) state._turns = [];
  return state;
}
function appendTurn(state, { user, bot, stepBefore, stepAfter, quickReplies, intentHandled, error }) {
  initSessionState(state);
  state._turns.push({
    t: new Date().toISOString(),
    user: user || "",
    bot: bot || "",
    stepBefore: stepBefore || "",
    stepAfter: stepAfter || "",
    quick: Array.isArray(quickReplies) ? quickReplies : [],
    intent: intentHandled || "",
    err: error ? String(error) : ""
  });
}
function transcriptToText(turns=[]) {
  const lines = [];
  for (const r of turns) {
    lines.push(`[${r.t}] STEP ${r.stepBefore} → ${r.stepAfter}`);
    if (r.user) lines.push(`U> ${r.user}`);
    if (r.bot)  lines.push(`B> ${r.bot}`);
    if (r.quick && r.quick.length) lines.push(`Q> ${r.quick.join(" | ")}`);
    if (r.intent) lines.push(`I> ${r.intent}`);
    if (r.err)    lines.push(`E> ${r.err}`);
  }
  return safeStr(lines.join("\n"));
}
async function sendTurnLog(payload){
  try {
    await fetch(ZAPIER_TURNLOG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: encodeForm(payload)
    });
  } catch (err) {
    console.error("Turn Log Zap failed", err);
  }
}
async function sendFinalTurnLogOnce(state, reason) {
  try {
    initSessionState(state);
    if (state._turnLogSent) return;
    state._turnLogSent = true;

    const payload = {
      // routing / audit
      variant: process.env.BOT_VARIANT || "",
      session_id: state._sessionId || "",
      session_started_at: state._sessionStart || "",
      session_ended_at: new Date().toISOString(),
      reason: reason || "",

      // contact + job context
      name: displayName(state),
      phone: displayPhone(state),
      email: displayEmail(state),
      address: displayAddress(state),
      zip: state.zip || "",
      date: state.date || "",
      window: state.window || "",
      pets: state.pets || "",
      outdoor_water: state.outdoorWater || "",
      building: state.building || "",
      floor: state.floor || "",

      // services + pricing
      services: selectedServiceForZap(state),
      cleaning_breakdown: buildCleaningBreakdownForZap(state),
      total_price: totalPriceForZap(state),

      // compact + full logs
      snapshot: safeStr(snapshotForSession(state), 2000),
      faq_count: Array.isArray(state.faqLog) ? state.faqLog.length : 0,
      transcript: transcriptToText(state._turns || [])
    };

    await sendTurnLog(payload);
  } catch (e) {
    console.error("Final Turn Log failed", e);
  }
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

// COPY UPDATED to reflect $100 minimum and the 2R + hallway promo
const stanleyRebuttal = () =>
`We’re **Same Day Steamerz** — locally owned with **truck-mounted hot water extraction (~240°F)** and we stand behind every job.

**Why people switch from “big brands”:**
• **Straightforward pricing:** **$50 per area, $100 minimum.**  
• **Promo:** **2 rooms + 1 hallway = $100**.  
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
  if (qi.odor)      return "We can treat **pet odors** with enzyme + hot-water extraction. If urine reached pad/subfloor, results vary; sealing/replacement may be needed. We’ll assess on arrival.";
  if (qi.waterDamage) return "We **don’t offer water-damage/flood extraction** or remediation.";
  if (qi.tileGrout)   return "We **don’t offer tile & grout cleaning** currently.";
  if (qi.hardwood)    return "We **don’t offer hardwood floor cleaning** currently.";

  if (qi.location)  return "We cover **metro ATL and surrounding ZIPs**. Share your **ZIP code** and I’ll confirm.";
  return null;
}
function logFAQ(state, q, a) {
  if (!Array.isArray(state.faqLog)) state.faqLog = [];
  state.faqLog.push({ q, a, at: new Date().toISOString() });
}

/* ========================= Pricing (Carpet) ========================= */
// ⬇️ UPDATED: $100 minimum; and EXACT 2 rooms + 1 hallway bundle = $100
function computeCarpetTotals(detail) {
  const d = { rooms:0, halls:0, stairs:0, extras:0, rugs:0, ...detail };
  const totalAreasBeforeFreebie = d.rooms + d.halls + d.stairs + d.extras + d.rugs;
  const freeHall = (totalAreasBeforeFreebie >= 4 && d.halls > 0) ? 1 : 0;
  const freeRoom = (totalAreasBeforeFreebie >= 6 && d.rooms > 0) ? 1 : 0;
  const chargeableRooms = Math.max(0, d.rooms - freeRoom);
  const chargeableHalls = Math.max(0, d.halls - freeHall);
  const billable = chargeableRooms + chargeableHalls + d.stairs + d.extras + d.rugs;
  let price = Math.max(100, billable * 50);

  // Promo override: exactly 2 rooms + 1 hallway, nothing else => $100
  if (d.rooms === 2 && d.halls === 1 && d.stairs === 0 && d.extras === 0 && d.rugs === 0) {
    price = 100;
  }

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

/* ========================= Summary helpers ========================= */
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
function snapshotForSession(state){
  const parts = [];
  if (state.carpet) parts.push(`Carpet: ${state.carpet.billable} areas (${state.carpet.describedText})`);
  if (state.upholstery) parts.push(`Upholstery: ${state.upholstery.breakdown?.join(", ") || ""}`);
  if (state.duct) parts.push(`Duct: ${state.duct.pkg} x ${state.duct.systems}${state.duct.add?.furnace?`, furnace`:""}${state.duct.add?.dryer?`, dryer`:""}`);
  const total = totalPriceForZap(state);
  return parts.length ? `Snapshot: ${parts.join(" | ")} | Total so far: $${total}` : "";
}

/* ========================= Follow-up helpers ========================= */
function armFollowUp(state, minutes=10) {
  const ms = Math.max(5, minutes) * 60 * 1000;
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
    await sendSessionZapFormEncoded(payload); 
    state._sessionSent = true; 
  } catch(e){ 
    console.error("Session Zap failed", e); 
  }
}
function refreshFollowUpIfEligible(state){
  if (hasContact(state) && state.step !== "collect_notes") {
    armFollowUp(state, 10);
  }
}

/* ========================= Zap senders (booking + session) ========================= */
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
    if (!payload.name2025 && !payload.phone2025 && !payload.email2025) {
      console.warn("SESSION send skipped: no minimally-identifying fields in payload");
      return;
    }
    if (!ZAPIER_SESSION_URL) { 
      console.warn("SESSION URL missing (env ZAP_SESSION_URL). Skipping partial send."); 
      return; 
    }
    if (ZAPIER_SESSION_URL === ZAPIER_TURNLOG_URL) { 
      console.warn("SESSION URL equals TURN LOG URL — blocked to prevent collision."); 
      return; 
    }
    const resp = await fetch(ZAPIER_SESSION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: encodeForm(payload)
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(()=>"(no body)");
      console.error("Session Zap non-200", resp.status, txt);
    }
  } catch (err) {
    console.error("Session Zap failed", err);
  }
}

/* ========================= Reuse prompts (Zap-friendly fields) ========================= */
const displayAddress = s => s.Address || s.address || '';
const displayName    = s => s.name2025 || s.name || '';
const displayEmail   = s => s.email2025 || s.email || '';
const displayPhone   = s => normalizeDigits(s.phone2025 || s.phone || '');

/* ---------- Prompts ---------- */
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

/* ========================= Smart corrections ========================= */
// Gated so "house" only works when we *are* on the building step
function applySmartCorrections(user, state) {
  if (!user || typeof user !== "string") return null;
  const t = user.toLowerCase();

  // phone override
  if (/(phone|number|override|update)/.test(t)) {
    const digits = (user.match(/\d/g) || []).join("");
    if (digits.length === 10) {
      state.phone = digits;
      return `Got it — I updated your phone number to ${formatPhone(state.phone)}.`;
    }
  }

  // Building shortcuts — ONLY when we're asking House vs Apartment
  if (state.step === "collect_building" && /\bhouse\b/.test(t)) {
    state.building = "House";
    state.step = "collect_notes";
    state.__notesPrompted = true;
    return {
      reply: `Do you have any notes or special instructions?`,
      quickReplies: ["Yes, I have notes","No, continue"]
    };
  }
  if (state.step === "collect_building" && /\bapartment\b/.test(t)) {
    state.building = "Apartment";
    state.step = "collect_floor";
    return {
      reply: `What floor is the apartment on? (1, 2, 3, or 4+)`,
      quickReplies: ["1","2","3","4"]
    };
  }

  // floor handler (only if we’re in collect_floor via correction)
  if (state.step === "collect_floor") {
    const fl = numFromText(t);
    if (!fl) {
      return {
        reply: `Please tell me which floor the apartment is on (e.g., 1, 2, 3, or 4).`,
        quickReplies: ["1","2","3","4"]
      };
    }
    state.floor = fl;
    if (fl > 3) {
      state.step = "end_for_rep";
      return `Since it’s above the 3rd floor, a sales rep will contact you to confirm if service is possible.`;
    }
    state.step = "collect_notes";
    state.__notesPrompted = true;
    return {
      reply: `Do you have any notes or special instructions?`,
      quickReplies: ["Yes, I have notes","No, continue"]
    };
  }

  // dynamic carpet tweaks (only if we already priced carpet)
  if (state.carpet && state.carpet.detail) {
    const d = { rooms:0, halls:0, stairs:0, extras:0, rugs:0, ...state.carpet.detail };
    let changed = false;

    const toRooms = t.match(/\bchange\s+(?:it\s+)?to\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+rooms?\b/);
    if (toRooms) { d.rooms = Math.max(0, numFromText(toRooms[1])); changed = true; }

    const addRooms = t.match(/\badd\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*rooms?\b/);
    if (addRooms) { d.rooms += Math.max(1, numFromText(addRooms[1] || "1")); changed = true; }
    const remRooms = t.match(/\b(remove|take)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*rooms?\b/);
    if (remRooms) { d.rooms = Math.max(0, d.rooms - Math.max(1, numFromText(remRooms[2] || "1"))); changed = true; }

    const addH = t.match(/\badd\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*hall/);
    if (addH) { d.halls += Math.max(1, numFromText(addH[1] || "1")); changed = true; }
    const remH = t.match(/\b(remove|take)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*hall/);
    if (remH) { d.halls = Math.max(0, d.halls - Math.max(1, numFromText(remH[2] || "1"))); changed = true; }

    const addS = t.match(/\badd\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(?:stairs?|flights?)\b/);
    if (addS) { d.stairs += Math.max(1, numFromText(addS[1] || "1")); changed = true; }
    const remS = t.match(/\b(remove|take)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(?:stairs?|flights?)\b/);
    if (remS) { d.stairs = Math.max(0, d.stairs - Math.max(1, numFromText(remS[2] || "1"))); changed = true; }

    const addR = t.match(/\badd\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(?:area\s*)?rugs?\b/);
    if (addR) { d.rugs += Math.max(1, numFromText(addR[1] || "1")); changed = true; }
    const remR = t.match(/\b(remove|take)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(?:area\s*)?rugs?\b/);
    if (remR) { d.rugs = Math.max(0, d.rugs - Math.max(1, numFromText(remR[2] || "1"))); changed = true; }

    if (!changed) {
      let m, lastRooms=null, lastHalls=null, lastStairs=null, lastRugs=null;
      const setRoomsRx = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*rooms?\b/g;
      while ((m = setRoomsRx.exec(t))) lastRooms = m[1];
      if (lastRooms != null) { d.rooms = Math.max(0, numFromText(lastRooms)); changed = true; }

      const setHallsRx = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*hall(?:way|ways)?\b/g;
      while ((m = setHallsRx.exec(t))) lastHalls = m[1];
      if (lastHalls != null) { d.halls = Math.max(0, numFromText(lastHalls)); changed = true; }

      const setStairsRx = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:stairs?|flights?)\b/g;
      while ((m = setStairsRx.exec(t))) lastStairs = m[1];
      if (lastStairs != null) { d.stairs = Math.max(0, numFromText(lastStairs)); changed = true; }

      const setRugsRx = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:area\s*)?rugs?\b/g;
      while ((m = setRugsRx.exec(t))) lastRugs = m[1];
      if (lastRugs != null) { d.rugs = Math.max(0, numFromText(lastRugs)); changed = true; }
    }

    if (changed) {
      state.carpet = computeCarpetTotals(d);
      return `Updated: ${state.carpet.billable} area(s) (${state.carpet.describedText}) now totals **$${state.carpet.price}**.`;
    }
  }

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

    // Wrap response to collect transcript (NO zap here)
    const stepBefore = state.step || "choose_service";
    const origStatus = res.status.bind(res);
    res.status = (code) => {
      const r = origStatus(code);
      const origJson = r.json.bind(r);
      r.json = (out) => {
        try {
          const st = (out && out.state) ? out.state : state || {};
          appendTurn(st, {
            user: user || (body.init ? "INIT" : ""),
            bot: out && out.reply ? out.reply : "",
            stepBefore,
            stepAfter: (st && st.step) || "",
            quickReplies: out && out.quickReplies,
            intentHandled: out && out.intentHandled,
            error: out && out.error
          });
          // ensure state with appended _turns is returned to client
          if (out && out.state) out.state = st; else out = { ...(out||{}), state: st };
        } catch (e) {
          console.error("Transcript append failed", e);
        }
        return origJson(out);
      };
      return r;
    };

    // Follow-up timeout: send partial + finalize turn log on next user ping after due
    if (state._followUpArmed && state._followUpDueAt && Date.now() >= state._followUpDueAt && state.step !== "collect_notes") {
      await sendSessionIfEligible(state, "timeout");
      await sendFinalTurnLogOnce(state, "timeout");
      disarmFollowUp(state);
    }

    // Allow client to explicitly finalize (optional)
    if (body.finalize === true) {
      await sendFinalTurnLogOnce(state, "client_finalize");
      return res.status(200).json({ reply: "Session archived. How else can I help?", quickReplies: SERVICE_CHOICES, state: { step:"choose_service", faqLog: state.faqLog } });
    }

    // First load
    if (body.init) return res.status(200).json(intro());

    // Smart corrections FIRST
    const correctionReply = applySmartCorrections(user, state);
    if (correctionReply) {
      if (typeof correctionReply === "string") {
        return res.status(200).json({ reply: correctionReply, state });
      } else {
        return res.status(200).json({ ...correctionReply, state });
      }
    }

    // FAQ any time
    const incomingQuestion = body.intent === "faq" ? (body.question || user) : (isQuestion(user) ? user : null);
    if (incomingQuestion) {
      const ans = answerFAQ(incomingQuestion);
      if (ans) { logFAQ(state, incomingQuestion, ans); return res.status(200).json({ reply: ans, state, intentHandled: "faq" }); }
    }

    // Helper for combined summary
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
          return res.status(200).json({
            reply: "Please choose carpet cleaning, upholstery cleaning, or air duct cleaning.",
            quickReplies: SERVICE_CHOICES, state
          });
        }
        if (choice === "carpet") {
          state.step = "carpet_details";
          return res.status(200).json({ reply: `What areas would you like us to clean? (e.g., “3 rooms, hallway, 2 rugs, stairs”)`, state });
        }
        if (choice === "upholstery") {
          state.step = "upholstery_details";
          return res.status(200).json({ reply: `What upholstery pieces would you like cleaned? (sectional, sofa, loveseat, recliner, ottoman, dining chairs, mattress)`, quickReplies: UPH_CHOICES, state });
        }
        state.step = "duct_package";
        return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic","Deep"], state });
      }

      /* ========== Carpet flow ========== */
      case "carpet_details": {
        const parsed = parseAreas(user);
        if (parsed.billable === 0) {
          return res.status(200).json({ reply: `Please describe the carpet areas again (e.g., “4 rooms, 1 hallway, 1 rug”, or “3 rooms and stairs”).`, state });
        }
        state.carpet = parsed;
        state.step   = "carpet_confirm";
        return res.status(200).json({
          reply: `For ${parsed.billable} area(s) (${parsed.describedText}) the total is **$${parsed.price}**.\n\nMove forward with carpet?`,
          quickReplies: ["Yes, move forward", "Change areas", "No, not now"],
          state
        });
      }

      case "carpet_confirm": {
        if (/change/i.test(msg)) {
          state.step = "carpet_details";
          return res.status(200).json({ reply: `No problem — tell me the carpet areas again.`, state });
        }
        if (/no|not now|skip/i.test(msg)) {
          await sendSessionIfEligible(state, "user opted out before notes");
          await sendFinalTurnLogOnce(state, "opt_out_before_booking");
          state = { step: "choose_service", faqLog: state.faqLog };
          return res.status(200).json({
            reply: `All good – if you’d like a quote later just say “carpet”, “upholstery”, or “ducts”.`,
            quickReplies: SERVICE_CHOICES,
            state
          });
        }
        if (state.upholstery?.total || state.duct?.total) {
          state.step = "confirm_combined_proceed";
          return res.status(200).json({
            reply: preBookingSummary(state),
            quickReplies: ["Proceed", "Change items"],
            state
          });
        }
        state.step = "uph_upsell_offer";
        return res.status(200).json({
          reply: `Nice — since you’re booking carpet, you’re eligible for **$50 off upholstery**. Want to add upholstery cleaning?`,
          quickReplies: ["Yes, add upholstery", "No, skip"],
          state
        });
      }

      case "uph_upsell_offer": {
        if (/no|skip/i.test(msg)) return res.status(200).json(promptAddress(state));
        state.addingUphAfterCarpet = true;
        state.step = "upholstery_details";
        return res.status(200).json({ reply: `Great — what upholstery pieces would you like cleaned?`, quickReplies: UPH_CHOICES, state });
      }

      /* ========== Upholstery flow ========== */
      case "upholstery_details": {
        if (/\bsofa\b/i.test(user) && !/\d/.test(user)) {
          state.step = "upholstery_cushions";
          state._cushionTarget = "sofa";
          state._cushionContext = user;
          return res.status(200).json({
            reply: `How many cushions are on the sofa?`,
            quickReplies: ["1","2","3","4"],
            state
          });
        }
        if (/\bloveseat\b/i.test(user) && !/\d/.test(user)) {
          state.step = "upholstery_cushions";
          state._cushionTarget = "loveseat";
          state._cushionContext = user;
          return res.status(200).json({
            reply: `How many cushions are on the loveseat?`,
            quickReplies: ["1","2","3","4"],
            state
          });
        }

        const parsed = parseUph(user);
        if (!parsed.breakdown.length) {
          return res.status(200).json({ reply: `Please list pieces like “sectional 6 seats”, “two recliners”, or “sofa and ottoman”.`, quickReplies: UPH_CHOICES, state });
        }
        state.upholstery = { total: parsed.total, breakdown: parsed.breakdown };

        if (/\bsectional\b/i.test(user) && !/\d/.test(user)) {
          state.step = "upholstery_sectional_seats";
          return res.status(200).json({ reply: `For the sectional — how many seats/cushions?`, quickReplies: ["3","4","5","6","7"], state });
        }

        state.step = "upholstery_confirm";
        return res.status(200).json({
          reply: `Your upholstery total is **$${parsed.total}** for ${parsed.breakdown.join(", ")}.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items", "Skip"],
          state
        });
      }

      case "upholstery_cushions": {
        const seats = numFromText(msg);
        if (!seats) {
          return res.status(200).json({
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
        return res.status(200).json({
          reply: `Your upholstery total is **$${combined.total}** for ${combined.breakdown.join(", ")}.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items", "Skip"],
          state
        });
      }

      case "upholstery_sectional_seats": {
        const seats = numFromText(msg);
        if (!seats) return res.status(200).json({ reply: `How many seats? (e.g., 4, 5, 6)`, quickReplies: ["3","4","5","6","7"], state });
        const merged = priceUphFromItems([{ type:"sectional", seats }]);
        state.upholstery = { total: merged.total, breakdown: merged.breakdown };
        state.step = "upholstery_confirm";
        return res.status(200).json({
          reply: `Your sectional price is **$${merged.total}**.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items", "Skip"],
          state
        });
      }

      case "upholstery_confirm": {
        if (/change/i.test(msg)) {
          state.step = "upholstery_details";
          return res.status(200).json({
            reply: `No problem — tell me the upholstery pieces again.`,
            quickReplies: UPH_CHOICES,
            state
          });
        }
        if (/skip|no/i.test(msg)) return res.status(200).json(promptAddress(state));

        if (state.carpet?.price || state.duct?.total) {
          state.step = "confirm_combined_proceed";
          return res.status(200).json({
            reply: preBookingSummary(state),
            quickReplies: ["Proceed", "Change items"],
            state
          });
        }
        state.step = "carpet_upsell_offer";
        return res.status(200).json({
          reply: `Since you’re booking upholstery, you qualify for a **free hallway** at 4+ areas, and at **6+** you also get **one room free**. Want me to price carpet too?`,
          quickReplies: ["Yes, add carpet", "No, skip"],
          state
        });
      }

      case "confirm_combined_proceed": {
        if (/proceed|yes/i.test(msg)) return res.status(200).json(promptAddress(state));
        if (/change|edit|update|back/i.test(msg)) {
          const opts = [];
          if (state.carpet)      opts.push("Change carpet");
          if (state.upholstery)  opts.push("Change upholstery");
          if (state.duct)        opts.push("Change duct");
          if (!opts.length)      opts.push("No changes");
          state.step = "confirm_combined_edit_picker";
          return res.status(200).json({
            reply: `What would you like to change?`,
            quickReplies: opts.concat(["Cancel"]),
            state
          });
        }
        return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
      }

      case "confirm_combined_edit_picker": {
        if (/cancel|no changes/i.test(msg)) {
          state.step = "confirm_combined_proceed";
          return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
        }
        if (/change carpet/i.test(msg)) { state.step = "carpet_details"; return res.status(200).json({ reply: `Tell me the carpet areas again.`, state }); }
        if (/change upholstery/i.test(msg)) {
          state.step = "upholstery_details";
          return res.status(200).json({ reply: `Tell me the upholstery pieces again.`, quickReplies: UPH_CHOICES, state });
        }
        if (/change duct/i.test(msg)) {
          state.step = "duct_package";
          return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic","Deep"], state });
        }
        return res.status(200).json({ reply: `Tap one of the options to change, or Cancel to proceed.`, state });
      }

      /* ========== Carpet upsell after upholstery ========== */
      case "carpet_upsell_offer": {
        if (/no|skip/i.test(msg)) return res.status(200).json(promptAddress(state));
        state.addingCarpetAfterUph = true;
        state.step = "carpet_details";
        return res.status(200).json({ reply:`Awesome — how many carpet areas should I price? (e.g., “3 rooms, hallway, 1 rug”).`, state });
      }

      /* ========== Duct flow ========== */
      case "duct_package": {
        if (!/basic|deep/.test(msg)) {
          state.step = "duct_package";
          return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic","Deep"], state });
        }
        state.duct = { pkg: /deep/.test(msg) ? "Deep" : "Basic", systems: 1, add: { furnace:false, dryer:false } };
        state.step = "duct_systems";
        return res.status(200).json({
          reply: `Great — you chose **${state.duct.pkg}**. How many **HVAC systems** do you have?`,
          quickReplies: ["1","2","3","4"],
          state
        });
      }

      case "duct_systems": {
        const n = Math.max(1, numFromText(msg));
        if (!n) return res.status(200).json({ reply: `How many systems should I price for? (e.g., 1 or 2)`, quickReplies: ["1","2","3","4"], state });
        state.duct.systems = n;
        state.step = "duct_add_furnace";
        return res.status(200).json({
          reply: furnaceAddOnCopy(state.duct.pkg),
          quickReplies: ["Add furnace", "No furnace"],
          state
        });
      }

      case "duct_add_furnace": {
        state.duct.add.furnace = /add/.test(msg);
        state.step = "duct_add_dryer";
        return res.status(200).json({ reply: dryerVentCopy, quickReplies: ["Add dryer vent","No add-ons"], state });
      }

      case "duct_add_dryer": {
        state.duct.add.dryer = /add/.test(msg);
        const base = state.duct.pkg === "Deep" ? 500 : 200;
        let total = state.duct.systems * base;
        if (state.duct.add.furnace) total += state.duct.systems * (state.duct.pkg === "Deep" ? 100 : 200);
        if (state.duct.add.dryer)   total += 200;
        state.duct.total = total;

        state.step = "duct_confirm";
        return res.status(200).json({ reply: `Your **${state.duct.pkg}** duct cleaning total is **$${total}** (${state.duct.systems} system${state.duct.systems>1?"s":""}${state.duct.add.furnace?`, +furnace`:""}${state.duct.add.dryer?`, +dryer vent`:""}). Proceed?`, quickReplies: ["Proceed","Change","Skip"], state });
      }

      case "duct_confirm": {
        if (/change/i.test(msg)) { state.step = "duct_systems"; return res.status(200).json({ reply:`No problem — how many systems should I price for?`, quickReplies: ["1","2","3","4"], state }); }
        if (/skip|no/i.test(msg)) return res.status(200).json(promptAddress(state));
        return res.status(200).json(promptAddress(state));
      }

      /* ========== Address → Name → Phone → Email → Date → Window → Pets → Water → Building → Floor → Notes ========== */
      case "confirm_reuse_address": {
        if (/^y/i.test(msg)) return res.status(200).json(promptName(state));
        state.address=""; state.Address=""; state.step = "collect_address";
        return res.status(200).json({ reply: `What’s the full service address? (street + city + state + ZIP — commas optional)`, state });
      }
      case "confirm_reuse_name": {
        if (/^y/i.test(msg)) return res.status(200).json(promptPhone(state));
        state.name=""; state.name2025=""; state.step = "collect_name";
        return res.status(200).json({ reply: `What’s your full name? (First and last name)`, state });
      }
      case "confirm_reuse_phone": {
        if (/^y/i.test(msg)) {
          // If we already have name + phone (reused), emit the partial now
          try { await sendSessionIfEligible(state, "confirm_reuse_phone"); } 
          catch (e) { console.error("Session (confirm_reuse_phone) emit failed", e); }
          return res.status(200).json(promptEmail(state));
        }
        state.phone=""; state.phone2025=""; state.step = "collect_phone";
        return res.status(200).json({ reply: `What’s the best phone number to reach you?`, state });
      }
      case "confirm_reuse_email": {
        if (/^y/i.test(msg)) { state.step="collect_date"; refreshFollowUpIfEligible(state); return res.status(200).json({ reply:`What day would you like the cleaning? (e.g., July 10 or 07/10)`, state }); }
        state.email=""; state.email2025=""; state.step = "collect_email";
        return res.status(200).json({ reply: `What’s your email address?`, state });
      }

      case "collect_address": {
        if (isQuestion(user)) {
          const a = answerFAQ(user);
          if (a) {
            logFAQ(state, user, a);
            return res.status(200).json({ reply: a + `\n\nWhat’s the full service address? (street + city + state + ZIP — commas optional)`, state, intentHandled:"faq" });
          }
          return res.status(200).json({ reply: `I can help with that, but first I need your address. What’s the full service address? (street + city + state + ZIP — commas optional)`, state });
        }

        const zipMatch = user.match(/\b(\d{5})(?:-\d{4})?\b/);
        const hasStreet = /^\s*\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .,'-]*\b/.test(user);
        const hasState = /\b(AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/i.test(user);

        if (!zipMatch || !hasStreet || !hasState) {
          return res.status(200).json({ reply: `Please provide your **full service address** (street + city + state + ZIP). Commas are optional.\nExample: "2314 College St Atlanta GA 30307"`, state });
        }

        const zip = zipMatch[1];

        if (validZipCodes && !validZipCodes.includes(zip)) {
          state.address = user.trim().replace(/\s{2,}/g, " ");
          state.zip = zip;
          state.step = "ooa_collect_phone";
          return res.status(200).json({
            reply: `Thanks! Unfortunately, that address looks **outside our service area**.\nWe can have a team member call to see if we can make it work.\n\nWhat’s the best **phone number** to reach you?`,
            state
          });
        }

        state.address = user.trim().replace(/\s{2,}/g, " ");
        state.Address = state.address;
        state.zip     = zip;
        return res.status(200).json(promptName(state));
      }

      case "ooa_collect_phone": {
        const digits = (user.match(/\d/g) || []).join("");
        if (digits.length !== 10) return res.status(200).json({ reply: `Please enter a valid **10-digit** phone number we can call.`, state });
        state.phone = digits; state.step  = "ooa_collect_name";
        return res.status(200).json({ reply: `Thanks. **Who should we ask for?** (First and last name)`, state });
      }

      case "ooa_collect_name": {
        if (!/\b[a-z][a-z]+(?:[-' ]?[a-z]+)?\s+[a-z][a-z]+\b/i.test(user)) {
          return res.status(200).json({ reply: `Please provide both a **first and last name**.`, state });
        }
        state.name = user.trim();
        const handoffMsg = `Thanks, ${state.name}! We’ll review your address (${state.address}) and call ${formatPhone(state.phone)} to see if we can service your area.`;

        await sendSessionIfEligible(state, "OOA handoff");
        await sendFinalTurnLogOnce(state, "OOA_handoff");

        state = { step: "choose_service", faqLog: [] };
        return res.status(200).json({ reply: handoffMsg, quickReplies: SERVICE_CHOICES, state });
      }

      case "collect_name": {
        if (!/\b[a-z][a-z]+(?:[-' ]?[a-z]+)?\s+[a-z][a-z]+\b/i.test(user)) {
          return res.status(200).json({ reply: `Please provide your **first and last name**.`, state });
        }
        state.name = user.trim();
        return res.status(200).json(promptPhone(state));
      }

      case "collect_phone": {
        const digits = (user.match(/\d/g) || []).join("");
        if (digits.length !== 10) return res.status(200).json({ reply:`Please enter a valid **10-digit** phone number.`, state });
        state.phone = digits;

        // Fire Partial/Session once (name + phone captured)
        try { await sendSessionIfEligible(state, "got phone"); }
        catch (e) { console.error("Session (got phone) emit failed", e); }

        refreshFollowUpIfEligible(state);
        return res.status(200).json(promptEmail(state));
      }

      case "collect_email": {
        if (!/^[\w.\-+]+@[\w.\-]+\.\w{2,}$/i.test(user)) return res.status(200).json({ reply:`Please enter a valid email address.`, state });
        state.email = user.trim();
        state.step  = "collect_date";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply:`What day would you like the cleaning? (e.g., July 10 or 07/10)`, state });
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
        if (!d) return res.status(200).json({ reply:`Please enter a date like “July 10” or “07/10”.`, state });

        const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (midnight < todayMid) return res.status(200).json({ reply:`Let’s pick a date today or later. What date works?`, state });

        state.date = d.toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });
        state.step = "collect_window";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply:`Which time frame works best for you?`, quickReplies: TIME_WINDOWS, state });
      }

      case "collect_window": {
        if (!TIME_WINDOWS.includes(user.trim())) return res.status(200).json({ reply:`Please pick one:`, quickReplies: TIME_WINDOWS, state });
        state.window = user.trim();
        state.step   = "collect_pets";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply:`Are there any pets we should know about?`, quickReplies: ["Yes","No"], state });
      }

      case "collect_pets": {
        state.pets = /^y/i.test(msg) ? "Yes" : "No";
        state.step = "collect_water";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply:`Do you have an outdoor water supply available?`, quickReplies: ["Yes","No"], state });
      }

      case "collect_water": {
        state.outdoorWater = /^y/i.test(msg) ? "Yes" : "No";
        state.step = "collect_building";
        refreshFollowUpIfEligible(state);
        return res.status(200).json({ reply: `Is it a house or apartment?`, quickReplies: ["House", "Apartment"], state });
      }

      case "collect_building": {
        if (/house/i.test(msg)) {
          state.building = "House";
          state.step = "collect_notes";
          state.__notesPrompted = true;
          return res.status(200).json({ reply: `Do you have any notes or special instructions?`, quickReplies: ["Yes, I have notes","No, continue"], state });
        }
        if (/apart/i.test(msg)) {
          state.building = "Apartment";
          state.step = "collect_floor";
          refreshFollowUpIfEligible(state);
          return res.status(200).json({ reply: `What floor is the apartment on?`, quickReplies: ["1","2","3","4"], state });
        }
        return res.status(200).json({ reply: `Please choose: House or Apartment?`, quickReplies: ["House", "Apartment"], state });
      }

      case "collect_floor": {
        const fl = numFromText(msg);
        if (!fl) return res.status(200).json({ reply: `Please tell me which floor the apartment is on (e.g., 1, 2, 3, or 4).`, quickReplies: ["1","2","3","4"], state });
        state.floor = fl;
        if (fl > 3) {
          state.step = "end_for_rep";
          await sendSessionIfEligible(state, "building above 3rd floor");
          await sendFinalTurnLogOnce(state, "building_above_3rd_floor");
          disarmFollowUp(state);
          return res.status(200).json({ reply: `Since it’s above the 3rd floor, a sales rep will contact you to confirm if service is possible.`, state });
        }
        state.step = "collect_notes";
        state.__notesPrompted = true;
        return res.status(200).json({ reply: `Do you have any notes or special instructions?`, quickReplies: ["Yes, I have notes","No, continue"], state });
      }

      case "collect_notes": {
        if (!state.__notesPrompted) {
          state.__notesPrompted = true;
          return res.status(200).json({ reply: "Do you have any notes or special instructions?", quickReplies: ["Yes, I have notes","No, continue"], state });
        }

        if (/^\s*yes/i.test(user)) {
          return res.status(200).json({ reply: "Please type your notes or special instructions:", state });
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
        try { await sendBookingZapFormEncoded(bookingPayload); } catch (err) { console.error("Booking Zap failed", err); }

        // Fire one-time final Turn Log here (booking path)
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

        return res.status(200).json({
          reply: summary + "\n\nBefore you go — would you like to hear about " +
            (state.duct ? "our **carpet or upholstery** cleaning as well?"
                        : "our **air duct cleaning** service too?"),
          quickReplies: state.duct ? ["Carpet", "Upholstery", "No thanks"] : ["Tell me about duct cleaning", "No thanks"],
          state
        });
      }

      case "post_summary_offer": {
        if (/no|thanks/i.test(msg)) {
          // no second final log; it already fired at booking_complete
          state = { step:"choose_service", faqLog: state.faqLog };
          return res.status(200).json({ reply:`Got it! If you need anything else, just say “carpet”, “upholstery”, or “ducts”.`, quickReplies: SERVICE_CHOICES, state });
        }
        if (state.duct) {
          if (/carpet/i.test(msg)) { state.step="carpet_details"; return res.status(200).json({ reply:`Great — tell me the carpet areas (e.g., “4 rooms, hallway, 1 rug”).`, state }); }
          if (/uphol/i.test(msg))  { state.step="upholstery_details"; return res.status(200).json({ reply:`Great — what upholstery pieces should we add?`, quickReplies: UPH_CHOICES, state }); }
        } else {
          if (/duct|tell me/i.test(msg)) { state.step="duct_package"; return res.status(200).json({ reply: ductIntroCopy(), quickReplies:["Basic","Deep"], state }); }
        }
        state = { step:"choose_service", faqLog: state.faqLog };
        return res.status(200).json({ reply:`No problem. If you’d like another quote, pick a service:`, quickReplies: SERVICE_CHOICES, state });
      }

      default: {
        state = { step: "choose_service", faqLog: state.faqLog || [] };
        return res.status(200).json(intro());
      }
    }
  } catch (err) {
    console.error("chat.js error", err);
    const out = {
      reply: `Sorry — something glitched on my end, but I’m still here. Tell me “carpet”, “upholstery”, or “ducts” and I’ll price it.`,
      state: { step: "choose_service", faqLog: [] },
      error: String(err && err.message || err)
    };
    return res.status(200).json(out);
  }
};
