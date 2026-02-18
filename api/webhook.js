// pages/api/webhook.js

export default async function handler(req, res) {
  // Always avoid caching for webhooks
  res.setHeader("Cache-Control", "no-store");
  console.log("WEBHOOK_VERSION", "2026-02-18_01");
  console.log("WEBHOOK_HIT", req.method, req.url);

  // ==============
  // 1) Meta verify (GET)
  // ==============
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    const hasVerifyParams = !!mode || !!token || !!challenge;

    const ok =
      mode === "subscribe" &&
      token &&
      process.env.VERIFY_TOKEN &&
      token === process.env.VERIFY_TOKEN;

    // If Meta is verifying
    if (hasVerifyParams) {
      if (ok) {
        console.log("WEBHOOK_VERIFIED");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.status(200).send(challenge || "");
      }

      console.warn("WEBHOOK_VERIFY_DENIED", {
        mode,
        tokenPresent: !!token,
        envVerifyPresent: !!process.env.VERIFY_TOKEN,
      });
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(403).send("Forbidden");
    }

    // If YOU are just opening /api/webhook in the browser
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send("OK");
  }

  // ==============
  // 2) Incoming events (POST)
  // ==============
  if (req.method === "POST") {
    try {
      const body = req.body;

      console.log("META_WEBHOOK_POST_RECEIVED");

      // Log payload (keep while debugging)
      try {
        console.log(JSON.stringify(body));
      } catch {
        console.log("PAYLOAD_LOG_FAILED");
      }

      if (body?.object === "page") {
        for (const entry of body.entry || []) {
          for (const evt of entry.messaging || []) {
            const psid = evt?.sender?.id;

            // Ignore echoes sent by the page (prevents loops)
            if (evt?.message?.is_echo) continue;

            const text = evt?.message?.text;

            // Ignore non-text events (delivery/read/attachments/etc.)
            if (!psid || !text) continue;

            const reply = `✅ Connected. You said: "${text}"`;

            // Send reply
            await sendMessengerText(psid, reply);
          }
        }
      } else {
        console.log("NON_PAGE_WEBHOOK_OBJECT", body?.object);
      }

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send("EVENT_RECEIVED");
    } catch (err) {
      console.error("WEBHOOK_HANDLER_ERROR", err);
      // Still return 200 so Meta doesn't keep retrying forever while you're debugging
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  res.setHeader("Allow", "GET, POST");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.status(405).send("Method Not Allowed");
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

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_type: "RESPONSE",
        recipient: { id: psid },
        message: { text },
      }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      console.error("SEND_API_ERROR", resp.status, data);
    } else {
      console.log("SEND_API_OK", data);
    }
  } catch (err) {
    console.error("SEND_API_FETCH_ERROR", err);
  }
}
