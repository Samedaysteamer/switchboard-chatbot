// Same Day Steamerz — baseline with duct quick replies, notes quick replies,
// sofa/loveseat cushion follow-up, ALWAYS show quick replies on notes prompt,
// stricter smart-correction gating, relaxed address parsing, pet-odor guidance,
// and explicit "we do NOT offer" answers for water damage extraction, tile/grout,
// and hardwood floor cleaning.  (Facebook $100 version)

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
