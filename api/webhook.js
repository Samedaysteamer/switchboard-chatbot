export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  console.log("WEBHOOK_VERSION", "2026-02-18_FIXED");
  console.log("WEBHOOK_HIT", req.method, req.url);

  // ===============================
  // 1) META VERIFICATION (GET)
  // ===============================
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    const ok =
      mode === "subscribe" &&
      token &&
      process.env.VERIFY_TOKEN &&
      token === process.env.VERIFY_TOKEN;

    if (ok) {
      console.log("WEBHOOK_VERIFIED");

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      return res.end(challenge);
    }

    console.warn("WEBHOOK_VERIFY_DENIED", {
      mode,
      tokenPresent: !!token,
      envVerifyPresent: !!process.env.VERIFY_TOKEN,
    });

    res.statusCode = 403;
    return res.end("Forbidden");
  }

  // ===============================
  // 2) INCOMING EVENTS (POST)
  // ===============================
  if (req.method === "POST") {
    try {
      const body = req.body;
      console.log("META_WEBHOOK_POST_RECEIVED");
      console.log(JSON.stringify(body));

      if (body?.object === "page") {
        for (const entry of body.entry || []) {
          for (const evt of entry.messaging || []) {
            const psid = evt?.sender?.id;

            // Ignore echoes
            if (evt?.message?.is_echo) continue;

            const text = evt?.message?.text;

            if (!psid || !text) continue;

            const reply = `✅ Connected. You said: "${text}"`;
            await sendMessengerText(psid, reply);
          }
        }
      } else {
        console.log("NON_PAGE_WEBHOOK_OBJECT", body?.object);
      }

      res.statusCode = 200;
      return res.end("EVENT_RECEIVED");
    } catch (err) {
      console.error("WEBHOOK_POST_ERROR", err);
      res.statusCode = 500;
      return res.end("ERROR");
    }
  }

  res.statusCode = 405;
  return res.end("Method Not Allowed");
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
    console.error("SEND_API_EXCEPTION", err);
  }
}
