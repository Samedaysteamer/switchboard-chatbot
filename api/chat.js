function _deriveFromHistory(state = {}) {
  const hist = Array.isArray(state._history) ? state._history : [];
  if (!hist.length) return {};

  const text = hist
    .slice(-40)
    .map(m => `${m.role || ""}: ${String(m.content || "")}`)
    .join("\n");

  const out = {};

  // Email
  const em = text.match(/[\w.\-+]+@[\w.\-]+\.\w{2,}/i);
  if (em) out.email = em[0].trim().toLowerCase();

  // Phone
  const ph = text.match(/\b(?:\+?1[\s\-\.]?)?(\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4})\b/);
  if (ph) {
    const d = extractTenDigit(ph[0]);
    if (d) out.phone = d;
  }

  // ✅ NAME (NEW) — tries explicit "Name:" first, then last reasonable full-name user reply
  const nameLine =
    text.match(/\bname\s*[:\-]\s*([A-Z][a-z]+(?:[-' ][A-Z][a-z]+)+)\b/) ||
    text.match(/\bmy\s+name\s+is\s+([A-Z][a-z]+(?:[-' ][A-Z][a-z]+)+)\b/i) ||
    text.match(/\bthis\s+is\s+([A-Z][a-z]+(?:[-' ][A-Z][a-z]+)+)\b/i);

  if (nameLine) {
    out.name = (nameLine[1] || nameLine[0]).toString().replace(/^.*?(?:is|:)\s*/i, "").trim();
  } else {
    for (let i = hist.length - 1; i >= 0; i--) {
      const m = hist[i];
      if (!m || m.role !== "user") continue;
      const v = String(m.content || "").trim();
      if (!v) continue;

      // reject obvious non-name inputs
      if (/@/.test(v)) continue;
      if (/\d/.test(v)) continue;
      if (v.length > 60) continue;
      if (/^(yes|no|house|apartment|finalize|proceed|basic|deep|carpet|upholstery|ducts?)$/i.test(v)) continue;

      // allow 2+ words with letters/apostrophes/hyphens/periods
      if (/^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)+$/.test(v)) {
        out.name = v;
        break;
      }
    }
  }

  // ZIP
  const zip = text.match(/\b\d{5}\b/);
  if (zip) out.zip = zip[0];

  // Window
  if (/(^|\b)8\s*(?:am)?\s*(?:-|to|–)\s*12\s*(?:pm)?(\b|$)/i.test(text)) out.window = "8 to 12";
  if (/(^|\b)1\s*(?:pm)?\s*(?:-|to|–)\s*5\s*(?:pm)?(\b|$)/i.test(text)) out.window = "1 to 5";

  // Building
  if (/\bapartment\b/i.test(text)) out.building = "Apartment";
  if (/\bhouse\b/i.test(text)) out.building = "House";

  // Pets
  if (/\bno\s+pets?\b/i.test(text) || /\bpets?\s*[:\-]\s*no\b/i.test(text)) out.pets = "No";
  if (/\byes\b.*\bpets?\b/i.test(text) || /\bpets?\s*[:\-]\s*yes\b/i.test(text)) out.pets = "Yes";

  // Outdoor water
  if (/\bno\b.*\boutdoor\s+water\b/i.test(text) || /\boutdoor\s+water\b.*\bno\b/i.test(text)) out.outdoorWater = "No";
  if (/\boutdoor\s+water\b.*\b(yes|available|access)\b/i.test(text) || /\bwater\s+spig(?:ot|got)\b/i.test(text)) out.outdoorWater = "Yes";

  // Address (best-effort)
  const addr =
    text.match(/\b\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .,'-]*\s+(?:[A-Za-z .'-]+)\s+(?:GA|Georgia)\s+\d{5}\b/i) ||
    text.match(/\b\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .,'-]*,\s*[A-Za-z .'-]+,\s*(?:GA|Georgia)\s+\d{5}\b/i);
  if (addr) out.address = addr[0].trim();

  // Date
  const dateLine = text.match(/(?:preferred\s*day|date|cleaning\s*date)\s*[:\-]?\s*([A-Za-z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
  if (dateLine) out.date = dateLine[1].trim();
  else {
    const md = text.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
    if (md) out.date = md[1].trim();
  }

  // Notes
  const notesLine = text.match(/\bnotes?\s*[:\-]\s*([^\n]{1,140})/i);
  if (notesLine) out.notes = notesLine[1].trim();

  // Total
  const totals = [...text.matchAll(/\b(?:total|new\s+combined\s+total)\s*[:\-]?\s*\$?\s*(\d{2,5})\b/ig)];
  if (totals.length) out.total_price = _toNumber(totals[totals.length - 1][1]);

  // Services inference
  const hasCarpet = /\bcarpet\b/i.test(text);
  const hasUph = /\bupholstery\b|\bcouch\b|\bsofa\b|\bloveseat\b|\bsectional\b/i.test(text);
  const hasDuct = /\bduct\b|\bair\s+duct\b|\bfurnace\b|\bdryer\s+vent\b/i.test(text);
  const svcs = [];
  if (hasCarpet) svcs.push("Carpet");
  if (hasUph) svcs.push("Upholstery");
  if (hasDuct) svcs.push("Air Duct");
  if (svcs.length) out.selected_service = svcs.join(" + ");

  const bd = [];
  if (hasCarpet) bd.push("Carpet cleaning");
  if (hasUph) bd.push("Upholstery cleaning");
  if (hasDuct) bd.push("Air duct cleaning");
  if (bd.length) out.Cleaning_Breakdown = bd.join(" + ");

  return out;
}
