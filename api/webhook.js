// pages/api/webhook.js
// Same Day Steamerz — Meta Messenger Webhook entrypoint (FULL)
// Purpose:
// 1) Handle Meta verification (GET hub.*)
// 2) Return OK when you open it in a browser (GET without hub.*)
// 3) Receive Meta events (POST)
// 4) Normalize env var names so chat.js works with your current Vercel variables
// 5) Delegate ALL event handling + Messenger replies to ./chat.js (single source of truth)

let _chatHandlerPromise = null;

async function getChatHandler() {
  if (!_chatHandlerPromise) {
    _chatHandlerPromise = import("./chat").then((m) => m.default || m);
  }
  return _chatHandlerPromise;
}

function normalizeEnvForChatJS() {
  // chat.js expects FB_* names, but your Vercel env currently uses PAGE_ACCESS_TOKEN + VERIFY_TOKEN.
  if (!process.env.FB_PAGE_ACCESS_TOKEN && process.env.PAGE_ACCESS_TOKEN) {
    process.env.FB_PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  }
  if (!process.env.FB_VERIFY_TOKEN && process.env.VERIFY_TOKEN) {
    process.env.FB_VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  }

  // Optional: if you ever store the app secret under APP_SECRET, map it too.
  if (!process.env.FB_APP_SECRET && process.env.APP_SECRET) {
    process.env.FB_APP_SECRET = process.env.APP_SECRET;
  }
}

export default async function handler(req, res) {
  // Never cache webhooks
  res.setHeader("Cache-Control", "no-store");

  console.log("WEBHOOK_VERSION", "2026-02-18_full_envmap_delegate_v1");
  console.log("WEBHOOK_HIT", req.method, req.url);

  // Ensure chat.js sees the variable names it expects
  normalizeEnvForChatJS();

  // =========================
  // 1) Meta verify (GET)
  // =========================
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];

    const hasVerifyParams = !!(mode || token || challenge);

    // If YOU open /api/webhook in the browser (no hub params)
    if (!hasVerifyParams) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send("OK");
    }

    const expectedVerify =
      process.env.FB_VERIFY_TOKEN || process.env.VERIFY_TOKEN || "";

    const ok =
      mode === "subscribe" &&
      token &&
      expectedVerify &&
      token === expectedVerify;

    if (ok) {
      console.log("WEBHOOK_VERIFIED");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(challenge || "");
    }

    console.warn("WEBHOOK_VERIFY_DENIED", {
      mode,
      tokenPresent: !!token,
      expectedPresent: !!expectedVerify,
    });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(403).send("Forbidden");
  }

  // =========================
  // 2) Incoming events (POST)
  // =========================
  if (req.method === "POST") {
    try {
      // Delegate to chat.js (it handles:
      // - object:"page" events
      // - PSID state
      // - Send API reply
      // - ManyChat/web flow)
      const chatHandler = await getChatHandler();
      return chatHandler(req, res);
    } catch (err) {
      console.error("WEBHOOK_DELEGATE_ERROR", err);

      // Still return 200 so Meta doesn't keep retrying
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  // =========================
  // 3) Not allowed
  // =========================
  res.setHeader("Allow", "GET, POST");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.status(405).send("Method Not Allowed");
}
