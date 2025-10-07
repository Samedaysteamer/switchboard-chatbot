// Same Day Steamerz — baseline with duct quick replies, notes quick replies,
// sofa/loveseat cushion follow-up, ALWAYS show quick replies on notes prompt,
// stricter smart-correction gating, relaxed address parsing, pet-odor guidance,
// and explicit "we do NOT offer" answers for water damage extraction, tile/grout,
// and hardwood floor cleaning.  (Facebook $100 version, with MC dedupe + robust input)

/* ========================= Utilities ========================= */
const SMALL = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20
};
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
const numFromText = (s="") => {
  const m = s.match(/\d+/);
  return m ? +m[0] : wordsToNumber(s);
};
const isQuestion = (t="") =>
  /\?$/.test(t.trim()) ||
  /^(what|when|how|who|where|why|do|does|can|is|are|should|could|would|are y|am i)\b/i.test(t);

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

    // Additional intents you requested
    odor: /(odor|odour|smell|urine|pee|pet\s*odor|pet\s*smell)/.test(t),
    waterDamage: /(water\s*damage|flood(?:ed|ing)?|standing\s*water|water\s*extraction)/.test(t),
    tileGrout: /\btile\b.*\bgrout\b|\bgrout\b.*\btile\b|tile\s*clean|grout\s*clean/i.test(t),
    hardwood: /(hard\s*wood|hardwood|wood\s*floor).*(clean|refinish|buff)?/i.test(t),
  };
}

// === UPDATED COPY FOR FACEBOOK $100 VERSION ===
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
• Removes dust, debris, and allergens so your HVAC can breathe and your air quality improves.

**2) Deep — $500 per system**  
• Everything in Basic, **plus** the **return side + trunks**, register cleaning, and **EPA-registered sanitizer** fogged through ducts to neutralize odor-causing bacteria/mildew.  
• Best for **allergies, odors, concerns about mold/bacteria, ducts not cleaned in years, or post-construction/remodel**.

Ready to choose a package?`);
}

const furnaceAddOnCopy = (pkg) =>
`**Furnace Cleaning — Recommended add-on (${pkg === "Deep" ? "+$100" : "+$200"} per system)**  
We open the main air return cabinet to remove built-up dust and dirt, then **sanitize the interior** to help prevent mold and bacteria buildup and keep airflow strong. Add it now?`;

const dryerVentCopy =
`**Dryer Vent Cleaning — $200**  
• Helps **prevent dryer fires** by removing flammable lint  
• Restores airflow so clothes **dry faster**  
• Reduces strain on the dryer and can **extend appliance life**  
Add dryer vent cleaning?`;

/* ========================= FAQ Answers ========================= */
function answerFAQ(text="") {
  const qi = detectQuickIntents(text);
  if (qi.stanley) return stanleyRebuttal();
  if (qi.special) return specialCopy();

  if (qi.sameDay)   return "We often have **same-day or next-day availability**. Tell me your address and I’ll check the earliest arrival window for your area.";
  if (qi.drytime)   return "Dry time is usually **4–8 hours**, depending on airflow, humidity, and carpet thickness.";
  if (qi.stain)     return "We treat most stains (coffee, wine, pet accidents, etc.). Some like **bleach or burns** may be permanent.";
  if (qi.petsKids)  return "Yes — all products are **pet- and child-safe** when used as directed.";
  if (qi.furniture) return "We don’t move large furniture (beds, dressers, entertainment centers, sectionals). Please clear small items.";
  if (qi.process)   return "We pre-spray, then clean with **truck-mounted hot water extraction** (~240°F), followed by a fiber rinse and free deodorizer.";
  if (qi.prep)      return "Please vacuum areas, ensure parking/access for hoses, and have water supply available.";
  if (qi.leather)   return "We **do not clean leather upholstery** — only fabric (sectionals, sofas, loveseats, recliners, etc.).";
  if (qi.upholsteryDry) return "Upholstery dry time: synthetics in hours; natural fibers (cotton/linen) longer. Good airflow helps.";
  if (qi.furnace)   return "Furnace cabinet cleaning opens the main return, removes buildup, and sanitizes. It’s **+$200 (Basic) or +$100 (Deep)** with duct cleaning.";
  if (qi.dryerVent) return "Dryer vent cleaning is **$200** (standard run). It removes flammable lint to **reduce fire risk**.";

  if (qi.odor) {
    return (
"We can treat **pet odors** with a specialized enzyme solution and hot-water carpet cleaning. Results depend on severity: if urine soaked through the **pad** into the **subfloor**, cleaning can improve but may not fully remove the odor — sometimes **replacement or sealing** is needed. Most customers clean first to see if it solves the issue; we’ll assess on arrival."
    );
  }
  if (qi.waterDamage) return "We **don’t offer water-damage/flood extraction** or remediation. We handle **standard carpet/upholstery cleaning**. For emergencies, a local restoration company is recommended.";
  if (qi.tileGrout)   return "We **don’t currently offer tile & grout cleaning.**";
  if (qi.hardwood)    return "We **don’t currently offer hardwood floor cleaning.**";

  if (qi.location)  return "We cover **metro ATL and surrounding ZIPs**. Share your **ZIP code** and I’ll confirm service in your area.";
  return null;
}
function logFAQ(state, q, a) {
  if (!Array.isArray(state.faqLog)) state.faqLog = [];
  state.faqLog.push({ q, a, at: new Date().toISOString() });
}

/* ========================= Pricing (Carpet) ========================= */
// === UPDATED FOR FACEBOOK $100 VERSION ===
// $100 minimum; and EXACT 2 rooms + 1 hallway bundle = $100
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
  if (d.rooms) parts.push(`${d.rooms} room${d.rooms>1?"s":""}${freeRoom ? " (1 free)" : ""}`);
  if (d.halls) parts.push(`${d.halls} hallway${d.halls>1?"s":""}${freeHall ? " (1 free)" : ""}`);
  if (d.stairs) parts.push(`${d.stairs} flight${d.stairs>1?"s":""} of stairs`);
  if (d.rugs) parts.push(`${d.rugs} rug${d.rugs>1?"s":""}`);
  if (d.extras) parts.push(`${d.extras} extra area${d.extras>1?"s":""}`);

  return {
    billable,
    price,
    describedText: parts.join(", "),
    detail: { ...d, freeHall, freeRoom }
  };
}

function parseAreas(text="") {
  const t = text.toLowerCase();

  // rooms / bedrooms
  let rooms = 0;
  for (const m of t.matchAll(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s*(?:rooms?|bedrooms?)/g)) {
    rooms += numFromText(m[1]);
  }
  if (rooms === 0 && /\brooms?\b/.test(t)) rooms = 1;

  // hallways
  let halls = 0;
  const mh = t.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*hall(?:way|ways)?/);
  if (mh) halls = numFromText(mh[1]);
  else if (/\bhall(?:way|ways)?\b/.test(t)) halls = 1;

  // stairs/flights
  let stairs = 0;
  const ms = t.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:flights?|stairs?)/);
  if (ms) stairs = numFromText(ms[1]);
  else if (/\b(?:flights?|stairs?)\b/.test(t)) stairs = 1;

  // rugs
  let rugs = 0;
  const mr = t.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:area\s*)?rugs?\b/);
  if (mr) rugs = numFromText(mr[1]);
  else if (/\b(?:area\s*)?rugs?\b/.test(t)) rugs = 1;

  // extras (other common rooms)
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
    if (m) {
      items.push({ type: key, count: numFromText(m[1]) });
    } else if (new RegExp(`\\b${key}s?\\b`).test(t)) {
      items.push({ type: key, count: 1 });
    }
  }

  return items.length ? priceUphFromItems(items) : { total:0, breakdown:[], items:[] };
}

/* ========================= Booking summary builder ========================= */
function bookingSummary(state) {
  const parts = [];
  if (state.carpet)     parts.push(`Carpet — ${state.carpet.billable} area(s) (${state.carpet.describedText}) — $${state.carpet.price}`);
  if (state.upholstery) parts.push(`Upholstery — ${state.upholstery.breakdown?.join(", ") || ""} — $${state.upholstery.total}`);
  if (state.duct)       parts.push(`Duct — ${state.duct.pkg} (${state.duct.systems} system${state.duct.systems>1?"s":""}${state.duct.add?.furnace?`, +furnace`:""}${state.duct.add?.dryer?`, +dryer vent`:""}) — $${state.duct.total}`);

  const total =
    (state.carpet?.price || 0) +
    (state.upholstery?.total || 0) +
    (state.duct?.total || 0);

  return `**Booking summary**
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
}

/* === Helpers to build Chatbase-style Zap payloads (form-encoded) === */
function buildCleaningBreakdownForZap(state){
  const lines = [];
  if (state.carpet) lines.push(`Carpet — ${state.carpet.billable} area(s) (${state.carpet.describedText}) — $${state.carpet.price}`);
  if (state.upholstery) lines.push(`Upholstery — ${state.upholstery.breakdown?.join(", ") || ""} — $${state.upholstery.total}`);
  if (state.duct) lines.push(`Duct — ${state.duct.pkg} (${state.duct.systems} system${state.duct.systems>1?"s":""}${state.duct.add?.furnace?`, +furnace`:""}${state.duct.add?.dryer?`, +dryer vent`:""}) — $${state.duct.total}`);
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
function encodeForm(data){
  return Object.keys(data).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? "")).join("&");
}
function snapshotForSession(state){
  const parts = [];
  if (state.carpet) parts.push(`Carpet: ${state.carpet.billable} areas (${state.carpet.describedText})`);
  if (state.upholstery) parts.push(`Upholstery: ${state.upholstery.breakdown?.join(", ") || ""}`);
  if (state.duct) parts.push(`Duct: ${state.duct.pkg} x ${state.duct.systems}${state.duct.add?.furnace?`, furnace`:""}${state.duct.add?.dryer?`, dryer`:""}`);
  const total = totalPriceForZap(state);
  return parts.length ? `Snapshot: ${parts.join(" | ")} | Total so far: $${total}` : "";
}

/* ========================= Follow-up flags ========================= */
function armFollowUp(state, minutes=10) {
  const ms = Math.max(5, minutes) * 60 * 1000;
  state._followUpArmed = true;
  state._followUpDueAt = Date.now() + ms;
}
function disarmFollowUp(state) {
  state._followUpArmed = false;
  state._followUpDueAt = 0;
}

/* ========= Session trigger helpers ========= */
function hasContact(state){ 
  return !!(state.name && state.phone && /^\d{10}$/.test(state.phone)); 
}

async function sendSessionIfEligible(state, reason){
  if (!hasContact(state)) return;
  if (state._sessionSent) return; // debounce so it only fires once
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
    armFollowUp(state, 10); // set to 1 for faster SMS testing
  }
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

  // dynamic carpet tweaks
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
/* ========================= Reuse prompts (UPDATED for Zap + 2025 fields) ========================= */
const normalizeDigits = (s='') => String(s).replace(/\D+/g,'');
const formatPhone = digits => (digits && digits.length===10)
  ? `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`
  : digits;

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

/* ========== ManyChat v2 formatter (NEW) ========== */
function toManyChatV2(payload) {
  // If already v2 or invalid, just return as-is
  if (payload && payload.version === "v2") return payload;

  // Normalize text
  const texts = [];
  if (typeof payload === "string") {
    texts.push(payload);
  } else if (payload && typeof payload.reply === "string") {
    texts.push(payload.reply);
  } else if (payload && typeof payload.text === "string") {
    texts.push(payload.text);
  }

  // Normalize quick replies
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

  const messages = (texts.length ? texts : [""]).map(t => ({ type: "text", text: t }));

  const out = { version: "v2", content: { messages } };
  if (qrs.length) out.content.quick_replies = qrs;

  // pass through state (so you can map it to a ManyChat custom field if desired)
  if (payload && payload.state != null) out.state = payload.state;
  if (payload && payload.error != null) out.error = payload.error;
  if (payload && payload.intentHandled) out.intentHandled = payload.intentHandled;

  return out;
}

/* ========================= Lightweight session store (per user) ========================= */
const __SESSION_STORE = new Map();
function userKeyFrom(body, req){
  return (
    body?.user_id ||
    body?.user?.id ||
    body?.contact?.id ||
    body?.sender?.id ||
    body?.psid ||
    body?.subscriber_id ||
    req?.headers?.['x-forwarded-for'] ||
    "anon"
  ) + "";
}
function getStateFor(body, req){
  // Prefer incoming state; otherwise try in-memory by user key; fallback to default.
  let s = body.state;
  if (typeof s === "string") { try { s = JSON.parse(s); } catch { s = null; } }
  if (!s) s = __SESSION_STORE.get(userKeyFrom(body, req));
  if (!s) s = { step: "choose_service", faqLog: [] };
  if (!Array.isArray(s.faqLog)) s.faqLog = [];
  return s;
}
function saveState(body, req, s){
  try { __SESSION_STORE.set(userKeyFrom(body, req), s); } catch {}
}
function emptyForChannel(isMC){
  return isMC ? { version:"v2", content:{ messages:[] } } : {};
}
function textSignatureOf(payload){
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  if (payload.reply) return payload.reply;
  if (payload.text) return payload.text;
  if (payload.content && Array.isArray(payload.content.messages)) {
    return payload.content.messages.map(m => m?.text || "").join("\n");
  }
  return "";
}

/* ========================= API Handler ========================= */
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body   = req.body || {};

    // Normalize user text across web + ManyChat
    const userRaw = (
      body.text ??
      body.message ??
      body.input ??
      (body.reply && (body.reply.title || body.reply.id)) ??
      body.reply_title ??
      body.reply_id ??
      body.payload ??
      ""
    ).toString();

    const user    = userRaw.trim();
    const msg     = user.toLowerCase();

    // Determine channel (ManyChat vs other)
    const fromManyChat = (body.channel === "messenger") || (body.source === "manychat");

    // Pull/initialize session state
    let state = getStateFor(body, req);

    // Wrap res.json to: (1) auto MC v2 when needed, (2) dedupe by signature, (3) persist state
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      try {
        // compute dedupe sig
        const sigText = textSignatureOf(data);
        const sig = `${state.step}|${(sigText||"").slice(0,120)}`;
        const now = Date.now();
        if (state._lastPromptSig === sig && (now - (state._lastPromptAt||0)) < 3500) {
          // duplicate within 3.5s → swallow output
          return originalJson(fromManyChat ? toManyChatV2(emptyForChannel(true)) : emptyForChannel(false));
        }
        state._lastPromptSig = sig;
        state._lastPromptAt  = now;

        saveState(body, req, state);
        if (fromManyChat) return originalJson(toManyChatV2(data));
        return originalJson(data);
      } catch (e) {
        // best-effort
        return originalJson(data);
      }
    };

    // Timeout follow-up check (legacy session arm/disarm pattern)
    if (state._followUpArmed && state._followUpDueAt && Date.now() >= state._followUpDueAt && state.step !== "collect_notes") {
      await sendSessionIfEligible(state, "timeout");
      disarmFollowUp(state);
    }

    // First touch / explicit init -> greet
    if (body.init || !state.step) {
      const p = intro();
      Object.assign(state, p.state || {});
      saveState(body, req, state);
      return res.status(200).json(p);
    }

    // If MC re-calls block without any new user payload, send empty envelope
    if (!user && fromManyChat) {
      saveState(body, req, state);
      return res.status(200).json(emptyForChannel(true));
    }

    // Smart corrections FIRST
    const correctionReply = applySmartCorrections(user, state);
    if (correctionReply) {
      saveState(body, req, state);
      if (typeof correctionReply === "string") {
        return res.status(200).json({ reply: correctionReply, state });
      } else {
        return res.status(200).json({ ...correctionReply, state });
      }
    }

    // FAQ any time (auto-detect + explicit)
    const incomingQuestion = body.intent === "faq" ? (body.question || user) : (isQuestion(user) ? user : null);
    if (incomingQuestion) {
      const ans = answerFAQ(incomingQuestion);
      if (ans) { logFAQ(state, incomingQuestion, ans); saveState(body, req, state); return res.status(200).json({ reply: ans, state, intentHandled: "faq" }); }
    }

    /* ---------------- Router helpers ---------------- */
    function preBookingSummary(state) {
      const parts = [];
      if (state.carpet) {
        parts.push(`Carpet — ${state.carpet.billable} area(s) (${state.carpet.describedText}) — $${state.carpet.price}`);
      }
      if (state.upholstery) {
        const uphText = state.upholstery.breakdown?.length ? state.upholstery.breakdown.join(", ") : "selected items";
        parts.push(`Upholstery — ${uphText} — $${state.upholstery.total}`);
      }
      if (state.duct) {
        parts.push(
          `Duct — ${state.duct.pkg} (${state.duct.systems} system${state.duct.systems>1?"s":""}` +
          `${state.duct.add?.furnace?`, +furnace`:""}${state.duct.add?.dryer?`, +dryer vent`:""}) — $${state.duct.total}`
        );
      }
      const total =
        (state.carpet?.price || 0) +
        (state.upholstery?.total || 0) +
        (state.duct?.total || 0);

      return `**Quick summary so far**
${parts.join("\n")}
**Combined total:** $${total}

Proceed with booking?`;
    }
    /* ---------------- Router ---------------- */
    switch (state.step) {
      /* ========== Choose service ========== */
      case "choose_service": {
        let choice = null;
        if (/duct|air\s*duct/.test(msg)) choice = "duct";
        if (/(upholstery|sectional|sofa|loveseat|recliner|ottoman|chair|mattress)/.test(msg)) choice = "upholstery";
        if (/(carpet|rooms?|hall|stairs|flight|rugs?)/.test(msg)) choice = "carpet";
        if (!choice) {
          saveState(body, req, state);
          return res.status(200).json({
            reply: "Please choose carpet cleaning, upholstery cleaning, or air duct cleaning.",
            quickReplies: SERVICE_CHOICES, state
          });
        }
        if (choice === "carpet") {
          state.step = "carpet_details";
          saveState(body, req, state);
          return res.status(200).json({ reply: `What areas would you like us to clean for your carpet cleaning service? (For example: “3 rooms, hallway, 2 rugs, stairs”).`, state });
        }
        if (choice === "upholstery") {
          state.step = "upholstery_details";
          saveState(body, req, state);
          return res.status(200).json({ reply: `What upholstery pieces would you like cleaned? (e.g., sectional, sofa, loveseat, recliner, ottoman, dining chairs, mattress)`, quickReplies: UPH_CHOICES, state });
        }
        state.step = "duct_package";
        saveState(body, req, state);
        return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic","Deep"], state });
      }

      /* ========== Carpet flow ========== */
      case "carpet_details": {
        const parsed = parseAreas(user);
        if (parsed.billable === 0) {
          saveState(body, req, state);
          return res.status(200).json({ reply: `Please describe the carpet areas again (e.g., “4 rooms, 1 hallway, 1 rug”, or “3 rooms and stairs”).`, state });
        }
        state.carpet = parsed;
        state.step   = "carpet_confirm";
        saveState(body, req, state);
        return res.status(200).json({
          reply: `For ${parsed.billable} area(s) (${parsed.describedText}) the total is **$${parsed.price}**.\n\nMove forward with carpet?`,
          quickReplies: ["Yes, move forward", "Change areas", "No, not now"],
          state
        });
      }

      case "carpet_confirm": {
        if (/change/i.test(msg)) {
          state.step = "carpet_details";
          saveState(body, req, state);
          return res.status(200).json({ reply: `No problem — tell me the carpet areas again.`, state });
        }
        if (/no|not now|skip/i.test(msg)) {
          await sendSessionIfEligible(state, "user opted out before notes");
          const keepFaq = state.faqLog;
          state = { step: "choose_service", faqLog: keepFaq };
          saveState(body, req, state);
          return res.status(200).json({
            reply: `All good – if you’d like a quote later just say “carpet”, “upholstery”, or “ducts”.`,
            quickReplies: SERVICE_CHOICES,
            state
          });
        }
        if (state.upholstery?.total || state.duct?.total) {
          state.step = "confirm_combined_proceed";
          saveState(body, req, state);
          return res.status(200).json({
            reply: preBookingSummary(state),
            quickReplies: ["Proceed", "Change items"],
            state
          });
        }
        state.step = "uph_upsell_offer";
        saveState(body, req, state);
        return res.status(200).json({
          reply: `Nice — since you’re booking carpet, you’re eligible for **$50 off upholstery**. Want to add upholstery cleaning?`,
          quickReplies: ["Yes, add upholstery", "No, skip"],
          state
        });
      }

      case "uph_upsell_offer": {
        if (/no|skip/i.test(msg)) { saveState(body, req, state); return res.status(200).json(promptAddress(state)); }
        state.addingUphAfterCarpet = true;
        state.step = "upholstery_details";
        saveState(body, req, state);
        return res.status(200).json({ reply: `Great — what upholstery pieces would you like cleaned?`, quickReplies: UPH_CHOICES, state });
      }

      /* ========== Upholstery flow ========== */
      case "upholstery_details": {
        if (/\bsofa\b/i.test(user) && !/\d/.test(user)) {
          state.step = "upholstery_cushions";
          state._cushionTarget = "sofa";
          state._cushionContext = user;
          saveState(body, req, state);
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
          saveState(body, req, state);
          return res.status(200).json({
            reply: `How many cushions are on the loveseat?`,
            quickReplies: ["1","2","3","4"],
            state
          });
        }

        const parsed = parseUph(user);
        if (!parsed.breakdown.length) {
          saveState(body, req, state);
          return res.status(200).json({ reply: `Please list pieces like “sectional 6 seats”, “two recliners”, or “sofa and ottoman”.`, quickReplies: UPH_CHOICES, state });
        }
        state.upholstery = { total: parsed.total, breakdown: parsed.breakdown };

        if (/\bsectional\b/i.test(user) && !/\d/.test(user)) {
          state.step = "upholstery_sectional_seats";
          saveState(body, req, state);
          return res.status(200).json({ reply: `For the sectional — how many seats/cushions?`, quickReplies: ["3","4","5","6","7"], state });
        }

        state.step = "upholstery_confirm";
        saveState(body, req, state);
        return res.status(200).json({
          reply: `Your upholstery total is **$${parsed.total}** for ${parsed.breakdown.join(", ")}.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items", "Skip"],
          state
        });
      }

      case "upholstery_cushions": {
        const seats = numFromText(msg);
        if (!seats) {
          saveState(body, req, state);
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
        saveState(body, req, state);
        return res.status(200).json({
          reply: `Your upholstery total is **$${combined.total}** for ${combined.breakdown.join(", ")}.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items", "Skip"],
          state
        });
      }

      case "upholstery_sectional_seats": {
        const seats = numFromText(msg);
        if (!seats) { saveState(body, req, state); return res.status(200).json({ reply: `How many seats? (e.g., 4, 5, 6)`, quickReplies: ["3","4","5","6","7"], state }); }
        const merged = priceUphFromItems([{ type:"sectional", seats }]);
        state.upholstery = { total: merged.total, breakdown: merged.breakdown };
        state.step = "upholstery_confirm";
        saveState(body, req, state);
        return res.status(200).json({
          reply: `Your sectional price is **$${merged.total}**.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items", "Skip"],
          state
        });
      }

      case "upholstery_confirm": {
        if (/change/i.test(msg)) {
          state.step = "upholstery_details";
          saveState(body, req, state);
          return res.status(200).json({
            reply: `No problem — tell me the upholstery pieces again.`,
            quickReplies: UPH_CHOICES,
            state
          });
        }
        if (/skip|no/i.test(msg)) { saveState(body, req, state); return res.status(200).json(promptAddress(state)); }

        if (state.carpet?.price || state.duct?.total) {
          state.step = "confirm_combined_proceed";
          saveState(body, req, state);
          return res.status(200).json({
            reply: preBookingSummary(state),
            quickReplies: ["Proceed", "Change items"],
            state
          });
        }
        state.step = "carpet_upsell_offer";
        saveState(body, req, state);
        return res.status(200).json({
          reply: `Since you’re booking upholstery, you qualify for a **free hallway** if you clean 4+ areas, and at **6+ areas** you also get **one room free**. Want me to price carpet too?`,
          quickReplies: ["Yes, add carpet", "No, skip"],
          state
        });
      }

      case "confirm_combined_proceed": {
        if (/proceed|yes/i.test(msg)) { saveState(body, req, state); return res.status(200).json(promptAddress(state)); }
        if (/change|edit|update|back/i.test(msg)) {
          const opts = [];
          if (state.carpet)      opts.push("Change carpet");
          if (state.upholstery)  opts.push("Change upholstery");
          if (state.duct)        opts.push("Change duct");
          if (!opts.length)      opts.push("No changes");
          state.step = "confirm_combined_edit_picker";
          saveState(body, req, state);
          return res.status(200).json({
            reply: `What would you like to change?`,
            quickReplies: opts.concat(["Cancel"]),
            state
          });
        }
        saveState(body, req, state);
        return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
      }

      case "confirm_combined_edit_picker": {
        if (/cancel|no changes/i.test(msg)) {
          state.step = "confirm_combined_proceed";
          saveState(body, req, state);
          return res.status(200).json({ reply: preBookingSummary(state), quickReplies: ["Proceed", "Change items"], state });
        }
        if (/change carpet/i.test(msg)) { state.step = "carpet_details"; saveState(body, req, state); return res.status(200).json({ reply: `Tell me the carpet areas again.`, state }); }
        if (/change upholstery/i.test(msg)) {
          state.step = "upholstery_details";
          saveState(body, req, state);
          return res.status(200).json({ reply: `Tell me the upholstery pieces again.`, quickReplies: UPH_CHOICES, state });
        }
        if (/change duct/i.test(msg)) {
          state.step = "duct_package";
          saveState(body, req, state);
          return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic","Deep"], state });
        }
        saveState(body, req, state);
        return res.status(200).json({ reply: `Tap one of the options to change, or Cancel to proceed.`, state });
      }

      /* ========== Carpet upsell after upholstery ========== */
      case "carpet_upsell_offer": {
        if (/no|skip/i.test(msg)) { saveState(body, req, state); return res.status(200).json(promptAddress(state)); }
        state.addingCarpetAfterUph = true;
        state.step = "carpet_details";
        saveState(body, req, state);
        return res.status(200).json({ reply:`Awesome — how many carpet areas should I price? (e.g., “3 rooms, hallway, 1 rug”).`, state });
      }

      /* ========== Duct flow ========== */
      case "duct_package": {
        if (!/basic|deep/.test(msg)) {
          saveState(body, req, state);
          return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic","Deep"], state });
        }
        state.duct = { pkg: /deep/.test(msg) ? "Deep" : "Basic", systems: 1, add: { furnace:false, dryer:false } };
        state.step = "duct_systems";
        saveState(body, req, state);
        return res.status(200).json({
          reply: `Great — you chose **${state.duct.pkg}**. How many **HVAC systems** do you have?`,
          quickReplies: ["1","2","3","4"],
          state
        });
      }

      case "duct_systems": {
        const n = Math.max(1, numFromText(msg));
        if (!n) { saveState(body, req, state); return res.status(200).json({ reply: `How many systems should I price for? (e.g., 1 or 2)`, quickReplies: ["1","2","3","4"], state }); }
        state.duct.systems = n;
        state.step = "duct_add_furnace";
        saveState(body, req, state);
        return res.status(200).json({
          reply: furnaceAddOnCopy(state.duct.pkg),
          quickReplies: ["Add furnace", "No furnace"],
          state
        });
      }

      case "duct_add_furnace": {
        state.duct.add.furnace = /add/.test(msg);
        state.step = "duct_add_dryer";
        saveState(body, req, state);
        return res.status(200).json({
          reply: dryerVentCopy,
          quickReplies: ["Add dryer vent", "No add-ons"],
          state
        });
      }

      case "duct_add_dryer": {
        state.duct.add.dryer = /add/.test(msg);
        const base = state.duct.pkg === "Deep" ? 500 : 200;
        let total = state.duct.systems * base;
        if (state.duct.add.furnace) total += state.duct.systems * (state.duct?.pkg === "Deep" ? 100 : 200);
        if (state.duct.add.dryer)   total += 200;
        state.duct.total = total;

        state.step = "duct_confirm";
        saveState(body, req, state);
        return res.status(200).json({ reply: `Your **${state.duct.pkg}** duct cleaning total is **$${total}** (${state.duct.systems} system${state.duct.systems>1?"s":""}${state.duct.add.furnace?`, +furnace`:""}${state.duct.add.dryer?`, +dryer vent`:""}). Proceed?`, quickReplies: ["Proceed", "Change", "Skip"], state });
      }

      case "duct_confirm": {
        if (/change/i.test(msg)) { state.step = "duct_systems"; saveState(body, req, state); return res.status(200).json({ reply:`No problem — how many systems should I price for?`, quickReplies: ["1","2","3","4"], state }); }
        if (/skip|no/i.test(msg)) { saveState(body, req, state); return res.status(200).json(promptAddress(state)); }
        saveState(body, req, state);
        return res.status(200).json(promptAddress(state));
      }

      /* ========== Address → Name → Phone → Email → Date → Details → Notes → Summary ========== */
      case "confirm_reuse_address": {
        if (/^y/i.test(msg)) { saveState(body, req, state); return res.status(200).json(promptName(state)); }
        state.address = ""; state.Address = ""; state.step = "collect_address";
        saveState(body, req, state);
        return res.status(200).json({ reply: `What’s the full service address? (street + city + state + ZIP — commas optional)`, state });
      }
      case "confirm_reuse_name": {
        if (/^y/i.test(msg)) { saveState(body, req, state); return res.status(200).json(promptPhone(state)); }
        state.name = ""; state.name2025 = ""; state.step = "collect_name";
        saveState(body, req, state);
        return res.status(200).json({ reply: `What’s your full name? (First and last name)`, state });
      }
      case "confirm_reuse_phone": {
        if (/^y/i.test(msg)) { saveState(body, req, state); return res.status(200).json(promptEmail(state)); }
        state.phone = ""; state.phone2025 = ""; state.step = "collect_phone";
        saveState(body, req, state);
        return res.status(200).json({ reply: `What’s the best phone number to reach you?`, state });
      }
      case "confirm_reuse_email": {
        if (/^y/i.test(msg)) { state.step="collect_date"; refreshFollowUpIfEligible(state); saveState(body, req, state); return res.status(200).json({ reply:`What day would you like the cleaning? (e.g., July 10 or 07/10)`, state }); }
        state.email = ""; state.email2025 = ""; state.step = "collect_email";
        saveState(body, req, state);
        return res.status(200).json({ reply: `What’s your email address?`, state });
      }

      case "collect_address": {
        if (isQuestion(user)) {
          const a = answerFAQ(user);
          if (a) {
            logFAQ(state, user, a);
            saveState(body, req, state);
            return res.status(200).json({
              reply: a + `\n\nWhat’s the full service address? (street + city + state + ZIP — commas optional)`,
              state,
              intentHandled: "faq"
            });
          }
          saveState(body, req, state);
          return res.status(200).json({
            reply: `I can help with that, but first I need your address. What’s the full service address? (street + city + state + ZIP — commas optional)`,
            state
          });
        }

        const zipMatch = user.match(/\b(\d{5})(?:-\d{4})?\b/);
        const hasStreet = /^\s*\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .,'-]*\b/.test(user);
        const hasState = /\b(AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/i.test(user);

        if (!zipMatch || !hasStreet || !hasState) {
          saveState(body, req, state);
          return res.status(200).json({
            reply: `Please provide your **full service address** (street + city + state + ZIP). Commas are optional.\nExample: "2314 College St Atlanta GA 30307"`,
            state
          });
        }

        const zip = zipMatch[1];
        state.address = user.trim().replace(/\s{2,}/g, " ");
        state.Address = state.address;
        state.zip     = zip;

        if (validZipCodes && !validZipCodes.includes(zip)) {
          state.step = "ooa_collect_phone";
          saveState(body, req, state);
          return res.status(200).json({
            reply:
              `Thanks! Unfortunately, that address looks **outside our service area**.\n` +
              `We can have a team member call to see if we can make it work.\n\n` +
              `What’s the best **phone number** to reach you?`,
            state
          });
        }

        saveState(body, req, state);
        return res.status(200).json(promptName(state));
      }

      case "ooa_collect_phone": {
        const digits = (user.match(/\d/g) || []).join("");
        if (digits.length !== 10) { saveState(body, req, state); return res.status(200).json({ reply: `Please enter a valid **10-digit** phone number we can call.`, state }); }
        state.phone = digits; state.step  = "ooa_collect_name";
        saveState(body, req, state);
        return res.status(200).json({ reply: `Thanks. **Who should we ask for?** (First and last name)`, state });
      }

      case "ooa_collect_name": {
        if (!/\b[a-z][a-z]+(?:[-' ]?[a-z]+)?\s+[a-z][a-z]+\b/i.test(user)) {
          saveState(body, req, state);
          return res.status(200).json({ reply: `Please provide both a **first and last name**.`, state });
        }
        state.name = user.trim();
        const handoffMsg = `Thanks, ${state.name}! We’ll review your address (${state.address}) and call ${formatPhone(state.phone)} to see if we can service your area.`;

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

        const keepFaq = state.faqLog;
        state = { step: "choose_service", faqLog: keepFaq };
        saveState(body, req, state);
        return res.status(200).json({ reply: handoffMsg, quickReplies: SERVICE_CHOICES, state });
      }

      case "collect_name": {
        if (!/\b[a-z][a-z]+(?:[-' ]?[a-z]+)?\s+[a-z][a-z]+\b/i.test(user)) {
          saveState(body, req, state);
          return res.status(200).json({ reply: `Please provide your **first and last name**.`, state });
        }
        state.name = user.trim();
        saveState(body, req, state);
        return res.status(200).json(promptPhone(state));
      }

      case "collect_phone": {
        const digits = (user.match(/\d/g) || []).join("");
        if (digits.length !== 10) { saveState(body, req, state); return res.status(200).json({ reply:`Please enter a valid **10-digit** phone number.`, state }); }
        state.phone = digits;

        // >>> fire Session/Partial once, at "got phone"
        try { await sendSessionIfEligible(state, "got phone"); } catch (e) { /* noop */ }

        refreshFollowUpIfEligible(state); // start follow-up window once we have name+phone
        saveState(body, req, state);
        return res.status(200).json(promptEmail(state));
      }

      case "collect_email": {
        if (!/^[\w.\-+]+@[\w.\-]+\.\w{2,}$/i.test(user)) { saveState(body, req, state); return res.status(200).json({ reply:`Please enter a valid email address.`, state }); }
        state.email = user.trim();
        state.step  = "collect_date";
        refreshFollowUpIfEligible(state);
        saveState(body, req, state);
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
        if (!d) { saveState(body, req, state); return res.status(200).json({ reply:`Please enter a date like “July 10” or “07/10”.`, state }); }

        const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (midnight < todayMid) { saveState(body, req, state); return res.status(200).json({ reply:`Let’s pick a date today or later. What date works?`, state }); }

        state.date = d.toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });
        state.step = "collect_window";
        refreshFollowUpIfEligible(state);
        saveState(body, req, state);
        return res.status(200).json({ reply:`Which time frame works best for you?`, quickReplies: TIME_WINDOWS, state });
      }

      case "collect_window": {
        if (!TIME_WINDOWS.includes(user.trim())) { saveState(body, req, state); return res.status(200).json({ reply:`Please pick one:`, quickReplies: TIME_WINDOWS, state }); }
        state.window = user.trim();
        state.step   = "collect_pets";
        refreshFollowUpIfEligible(state);
        saveState(body, req, state);
        return res.status(200).json({ reply:`Are there any pets we should know about?`, quickReplies: ["Yes","No"], state });
      }

      case "collect_pets": {
        state.pets = /^y/i.test(msg) ? "Yes" : "No";
        state.step = "collect_water";
        refreshFollowUpIfEligible(state);
        saveState(body, req, state);
        return res.status(200).json({ reply:`Do you have an outdoor water supply available?`, quickReplies: ["Yes","No"], state });
      }

      case "collect_water": {
        state.outdoorWater = /^y/i.test(msg) ? "Yes" : "No";
        state.step = "collect_building";
        refreshFollowUpIfEligible(state);
        saveState(body, req, state);
        return res.status(200).json({ reply: `Is it a house or apartment?`, quickReplies: ["House", "Apartment"], state });
      }

      case "collect_building": {
        if (/house/i.test(msg)) {
          state.building = "House";
          state.step = "collect_notes";
          state.__notesPrompted = true;
          saveState(body, req, state);
          return res.status(200).json({ reply: `Do you have any notes or special instructions?`, quickReplies: ["Yes, I have notes","No, continue"], state });
        }
        if (/apart/i.test(msg)) {
          state.building = "Apartment";
          state.step = "collect_floor";
          refreshFollowUpIfEligible(state);
          saveState(body, req, state);
          return res.status(200).json({ reply: `What floor is the apartment on?`, quickReplies: ["1","2","3","4"], state });
        }
        saveState(body, req, state);
        return res.status(200).json({ reply: `Please choose: House or Apartment?`, quickReplies: ["House", "Apartment"], state });
      }

      case "collect_floor": {
        const fl = numFromText(msg);
