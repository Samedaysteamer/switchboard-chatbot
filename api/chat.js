// Same Day Steamerz — robust ManyChat + Web handler (UPDATED)
// (Surgical update: remove sofa internal text, fix duct "No add-ons" adding dryer, remove Skip from price confirms)

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
  if (!VALID_ZIP_SET) return false;
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

function bundleDiscount(state = {}) {
  const hasCarpet = !!(state.carpet && typeof state.carpet.price === "number" && state.carpet.price > 0);
  const hasUph = !!(state.upholstery && typeof state.upholstery.total === "number" && state.upholstery.total > 0);
  const eligible = !!state.addingUphAfterCarpet;
  return (eligible && hasCarpet && hasUph) ? 50 : 0;
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

function subtotalPrice(state) {
  return (state.carpet?.price || 0) + (state.upholstery?.total || 0) + (state.duct?.total || 0);
}

function totalPriceForZap(state) {
  const subtotal = subtotalPrice(state);
  const discount = bundleDiscount(state);
  return Math.max(0, subtotal - discount);
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

  if (payload && payload.error != null) out.error = payload.error;
  if (payload && payload.intentHandled) out.intentHandled = payload.intentHandled;

  return out;
}

/* ========================= Reprompt (fallback prompts) ========================= */
function repromptForStep(state = {}) {
  const s = state.step || "";
  switch (s) {
    case "upholstery_cushions":
      return { reply: "How many seat cushions does it have?", quickReplies: ["1", "2", "3", "4", "5", "6", "7"], state };

    // ✅ PRICE CONFIRM prompts: NO SKIP buttons
    case "upholstery_confirm":
      return { reply: "Proceed with upholstery?", quickReplies: ["Proceed", "Change items"], state };
    case "duct_confirm":
      return { reply: "Proceed?", quickReplies: ["Proceed", "Change"], state };

    default:
      return intro();
  }
}

/* ========================= CORE POST HANDLER ========================= */
async function handleCorePOST(req, res) {
  try {
    const body = req.body || {};
    const userRaw = (typeof body.text === "string" && body.text) || "";
    const user = String(userRaw || "").trim();
    const msg = user.toLowerCase();

    let state = body.state ?? {};
    if (typeof state === "string") {
      try { state = JSON.parse(state); } catch { state = {}; }
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

    switch (state.step) {
      case "choose_service": {
        let choice = null;
        if (/duct|air\s*duct/.test(msg)) choice = "duct";
        if (/(upholstery|sectional|sofa|loveseat|recliner|ottoman|chair|mattress)/.test(msg)) choice = "upholstery";
        if (/(carpet|rooms?|hall|stairs|flight|rugs?)/.test(msg)) choice = "carpet";
        if (!choice) return res.status(200).json({ reply: "Please choose a service.", quickReplies: SERVICE_CHOICES, state });

        if (choice === "upholstery") {
          state.step = "upholstery_details";
          return res.status(200).json({ reply: "What upholstery pieces would you like cleaned?", quickReplies: UPH_CHOICES, state });
        }

        if (choice === "duct") {
          state.step = "duct_package";
          return res.status(200).json({ reply: ductIntroCopy(), quickReplies: ["Basic", "Deep"], state });
        }

        state.step = "carpet_details";
        return res.status(200).json({ reply: "What areas would you like us to clean? (e.g., “3 rooms, hallway, stairs”).", state });
      }

      case "upholstery_details": {
        const t = msg.trim();

        // ✅ Sofa/Loveseat cushion gate prompt — NO internal parenthetical
        if (t === "sofa" || t === "loveseat") {
          state.uphCushionTarget = t;
          state.step = "upholstery_cushions";
          return res.status(200).json({
            reply: `For the ${t} — how many seat cushions does it have?`,
            quickReplies: ["1", "2", "3", "4", "5", "6", "7"],
            state
          });
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
          quickReplies: ["Proceed", "Change items"], // ✅ no Skip
          state
        });
      }

      case "upholstery_cushions": {
        const cushions = numFromText(msg);
        if (!cushions || cushions < 1) {
          return res.status(200).json({
            reply: "How many seat cushions does it have?",
            quickReplies: ["1", "2", "3", "4", "5", "6", "7"],
            state
          });
        }

        const target = (state.uphCushionTarget || "sofa").toLowerCase();

        let items = [];
        if (cushions >= 4) {
          items = [{ type: "sectional", seats: cushions }];
        } else {
          if (target === "loveseat") {
            if (cushions <= 2) items = [{ type: "loveseat", count: 1, seats: cushions }];
            else items = [{ type: "sofa", count: 1, seats: cushions }];
          } else {
            items = [{ type: "sofa", count: 1, seats: cushions }];
          }
        }

        const priced = priceUphFromItems(items);
        state.upholstery = { total: priced.total, breakdown: priced.breakdown };
        state.uphCushionTarget = undefined;

        state.step = "upholstery_confirm";
        const label = priced.breakdown?.[0] || "selected item";
        return res.status(200).json({
          reply: `Your upholstery total is **$${priced.total}** for ${label}.\n\nProceed with upholstery?`,
          quickReplies: ["Proceed", "Change items"], // ✅ no Skip
          state
        });
      }

      case "upholstery_confirm": {
        if (/change/i.test(msg)) {
          state.step = "upholstery_details";
          return res.status(200).json({ reply: "No problem — tell me the upholstery pieces again.", quickReplies: UPH_CHOICES, state });
        }
        return res.status(200).json({ reply: "Got it — continuing.", state });
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
        state.duct.add.furnace = /^add furnace$/i.test(user.trim());
        state.step = "duct_add_dryer";
        return res.status(200).json({ reply: dryerVentCopy, quickReplies: ["Add dryer vent", "No add-ons"], state });
      }

      case "duct_add_dryer": {
        // ✅ HARD SAFEGUARD: exact-match only
        const normalized = user.trim().toLowerCase();
        state.duct.add.dryer = (normalized === "add dryer vent");

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
          quickReplies: ["Proceed", "Change"], // ✅ no Skip
          state
        });
      }

      case "duct_confirm": {
        if (/change/i.test(msg)) {
          state.step = "duct_systems";
          return res.status(200).json({ reply: "No problem — how many systems should I price for?", quickReplies: ["1", "2", "3", "4"], state });
        }
        return res.status(200).json({ reply: "Got it — continuing.", state });
      }

      default:
        return res.status(200).json(intro());
    }
  } catch (err) {
    console.error("chat.js error", err);
    return res.status(200).json({
      reply: "Sorry — something glitched on my end. Tell me “carpet”, “upholstery”, or “ducts” and I’ll price it.",
      state: { step: "choose_service", faqLog: [] },
      error: String((err && err.message) || err)
    });
  }
}

/* ========================= MAIN EXPORT ========================= */
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  return handleCorePOST(req, res);
};
