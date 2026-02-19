// /api/webhook.js
// Same Day Steamerz — Meta Messenger Webhook entrypoint (FULL)
//
// Purpose:
// 1) Handle Meta verification (GET hub.*)
// 2) Return OK when opened in browser (GET without hub.*)
// 3) Receive Meta events (POST) and delegate ALL handling to ./chat.js
// 4) Normalize env var names so chat.js works no matter which naming you used

let _chatHandlerPromise = null;

async function getChatHandler() {
  if (!_chatHandlerPromise) {
    _chatHandlerPromise = import("./chat").then((m) => m.default || m);
  }
  const handler = await _chatHandlerPromise;
  if (typeof handler !== "function") {
    throw new Error("CHAT_HANDLER_NOT_FUNCTION");
  }
  return handler;
}

function normalizeEnv() {
  // Access token compatibility
  if (!process.env.PAGE_ACCESS_TOKEN && process.env.FB_PAGE_ACCESS_TOKEN) {
    process.env.PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
  }
  if (!process.env.FB_PAGE_ACCESS_TOKEN && process.env.PAGE_ACCESS_TOKEN) {
    process.env.FB_PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  }

  // Verify token compatibility
  if (!process.env.VERIFY_TOKEN && process.env.FB_VERIFY_TOKEN) {
    process.env.VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
  }
  if (!process.env.FB_VERIFY_TOKEN && process.env.VERIFY_TOKEN) {
    process.env.FB_VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  }

  // App secret compatibility (optional)
  if (!process.env.APP_SECRET && process.env.FB_APP_SECRET) {
    process.env.APP_SECRET = process.env.FB_APP_SECRET;
  }
  if (!process.env.FB_APP_SECRET && process.env.APP_SECRET) {
    process.env.FB_APP_SECRET = process.env.APP_SECRET;
  }
}

function hasHubParams(query) {
  return Boolean(
    query?.["hub.mode"] || query?.["hub.verify_token"] || query?.["hub.challenge"]
  );
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  normalizeEnv();

  console.log("WEBHOOK_VERSION", "2026-02-18_webhook_delegate_v2");
  console.log("WEBHOOK_HIT", req.method, req.url);

  // =========================
  // 1) Meta verify (GET)
  // =========================
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];

    // If YOU open /api/webhook in browser (no hub params)
    if (!hasHubParams(req.query)) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send("OK");
    }

    const expected = process.env.VERIFY_TOKEN || process.env.FB_VERIFY_TOKEN || "";
    const ok = mode === "subscribe" && token && expected && token === expected;

    if (ok) {
      console.log("WEBHOOK_VERIFIED");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(challenge || "");
    }

    console.warn("WEBHOOK_VERIFY_DENIED", {
      mode,
      tokenPresent: !!token,
      expectedPresent: !!expected,
    });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(403).send("Forbidden");
  }

  // =========================
  // 2) Incoming events (POST)
  // =========================
  if (req.method === "POST") {
    try {
      // Breadcrumb: confirms Meta is actually posting here
      if (req.body?.object) console.log("WEBHOOK_POST_OBJECT", req.body.object);

      const chatHandler = await getChatHandler();
      return await chatHandler(req, res);
    } catch (err) {
      console.error("WEBHOOK_HANDLER_ERROR", err);

      // Always 200 so Meta doesn't retry forever while debugging
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
