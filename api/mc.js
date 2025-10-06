// api/mc.js — ManyChat (Content v2) adapter for your chat engine
const fetch = global.fetch || require("node-fetch");

// helper: slug
const slug = s => String(s || "")
  .toLowerCase()
  .trim()
  .replace(/\s+/g, "_")
  .replace(/[^a-z0-9_]/g, "");

function toMCv2(messages = []) {
  if (!Array.isArray(messages)) messages = [messages];

  const v2 = messages.map(m => {
    // text
    const msg = { type: "text", text: m.text || m.message || "" };

    // quick replies normalization
    const qrs = m.quickReplies || m.quick_replies || [];
    const normalized = (qrs || []).map(q => {
      if (typeof q === "string") {
        const title = q;
        return { type: "reply", reply: { id: slug(title), title } };
      }
      const title = q.title || q.text || q.label || String(q);
      const id = q.payload || q.value || slug(title);
      return { type: "reply", reply: { id, title } };
    });
    if (normalized.length) msg.quick_replies = normalized;

    return msg;
  });

  return {
    version: "v2",
    content: { messages: v2.length ? v2 : [{ type: "text", text: "..." }] }
  };
}

export default async function handler(req, res) {
  try {
    const body = req.body || {};
    const base = process.env.PUBLIC_BASE_URL || "https://switchboard-chatbot.vercel.app";

    // Call your existing chat engine and pass a messenger hint
    const r = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, channel: "messenger", source: "manychat" })
    });

    const data = await r.json();
    const msgs = data?.content?.messages || data?.messages || [];
    return res.status(200).json(toMCv2(msgs));
  } catch (e) {
    console.error("MC adapter error:", e);
    // Safe fallback that still passes ManyChat’s v2 validator
    return res.status(200).json({
      version: "v2",
      content: { messages: [{ type: "text", text: "Thanks! One moment..." }] }
    });
  }
}
