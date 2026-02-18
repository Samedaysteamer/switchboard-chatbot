// api/webhook.js
// Vercel Serverless Function (CommonJS) — matches your /api/chat.js style.

const crypto = require("crypto");

// Use native fetch if available; otherwise lazy-load node-fetch
const fetchFn =
  global.fetch?.bind(global) ||
  (async (...args) => {
    const mod = await import("node-fetch");
    return mod.default(...args);
  });

// -------------------------
// Lightweight state store
// -------------------------
// For TESTING: in-memory works but resets on deploy/cold starts.
// For PRODUCTION: set KV_REST_API_URL + KV_REST_API_TOKEN to use Upstash/Vercel KV REST.
const memoryStore = new Map();

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  const resp = await fetchFn(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  // Upstash REST returns { result: "..." }
  if (!data || data.result == null) return null;

  try {
    return JSON.parse(data.result);
  } catch {
    return null;
  }
}

async function kvSet(key, value, ttlSeconds = 60 * 60 * 24 * 14) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;

  const resp = await fetchFn(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      value: JSON.stringify(value),
      ex: ttlSeconds,
    }),
  });

  return resp.ok;
}

async function getState(psid) {
  const key = `state:${psid}`;
  const fromKv = await kvGet(key);
  if (fromKv) return fromKv;

  return memoryStore.get(key) || null;
}

async function setState(psid, state) {
  const key = `state:${psid}`;
  // Try KV first; if not configured, fall back to memory.
  const ok = await kvSet(key, state);
  if (!ok) memoryStore.set(key, state);
}

// -------------------------
// Helpers
// -------------------------
function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https")
    .toString()
    .split(",")[0]
    .trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host).toString();
  return `${proto}://${host}`;
}

function safeJson(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function extractReply(chatData) {
  // Your /api/chat.js might return different shapes depending on source.
  return (
    chatData?.reply_text ||
    chatData?.reply ||
    // Some wrappers return { content: { messages:[{text:""}] } }
    (Array.isArray(chatData?.content?.messages)
      ? chatData.content.messages.map((m) => m?.text).filter(Boolean).join("\n")
      : "") ||
    ""
  );
}

function isEchoEvent(evt) {
  // Prevent the bot replying to its own messages
  return !!evt?.message?.is_echo;
}

async function sendMessengerText(psid, text) {
  const token = process.env.PAGE_ACCESS_TOKEN;
  if (!token) {
    console.error("MISSING_PAGE_ACCESS_TOKEN");
    return;
  }

  const url = `https://graph.facebook.com/v24.0/me/messages?access_token=${encodeURIComponent(
    token
  )}`;

  const resp = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_type: "RESPONSE",
      recipient: { id: psid },
      message: { text },
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) console.error("SEND_API_ERROR", resp.status, data);
  else console.log("SEND_API_OK", data);
}

// -------------------------
// Main handler
// -------------------------
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  console.log("WEBHOOK_HIT", req.method, req.url);

  // 1) Meta verify (GET)
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFIED");
      return res.status(200).type("text/plain").send(challenge);
    }

    console.warn("WEBHOOK_VERIFY_DENIED", { mode, tokenPresent: !!token });
    return res.status(403).type("text/plain").send("Forbidden");
  }

  // 2) Incoming events (POST)
  if (req.method === "POST") {
    const body = safeJson(req.body);
    console.log("META_WEBHOOK_POST_RECEIVED");
    // keep logs readable
    console.log(JSON.stringify(body)?.slice(0, 4000));

    const baseUrl = getBaseUrl(req);

    if (body?.object === "page") {
      for (const entry of body.entry || []) {
        for (const evt of entry.messaging || []) {
          const psid = evt?.sender?.id;

          // Ignore delivery/read, echoes, attachments, etc.
          if (!psid) continue;
          if (isEchoEvent(evt)) continue;

          const text = evt?.message?.text;
          if (!text) continue;

          // Load state
          const state = (await getState(psid)) || null;

          // Call your brain (/api/chat) with { text, state }
          let chatData = null;
          try {
            const chatResp = await fetchFn(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text,
                state,
                source: "webhook",
              }),
            });

            chatData = await chatResp.json().catch(() => null);

            if (!chatResp.ok) {
              console.error("CHAT_ENDPOINT_ERROR", chatResp.status, chatData);
              await sendMessengerText(
                psid,
                "⚠️ Bot error talking to brain endpoint. Check logs."
              );
              continue;
            }
          } catch (e) {
            console.error("CHAT_FETCH_FAILED", e);
            await sendMessengerText(
              psid,
              "⚠️ Bot error calling brain endpoint. Check logs."
            );
            continue;
          }

          const reply = extractReply(chatData) || "✅ Connected (no reply text).";
          const newState = chatData?.state ?? state;

          // Save state
          await setState(psid, newState);

          // Reply to user
          await sendMessengerText(psid, reply);
        }
      }
    } else {
      console.log("NON_PAGE_WEBHOOK_OBJECT", body?.object);
    }

    // Respond 200 so Meta doesn't retry
    return res.status(200).type("text/plain").send("EVENT_RECEIVED");
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).type("text/plain").send("Method Not Allowed");
};
