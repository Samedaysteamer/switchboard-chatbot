export default async function handler(req, res) {
  try {
    console.log("WEBHOOK_VERSION", "2026-02-18_FIXED");
    console.log("WEBHOOK_HIT", req.method, req.url);

    // ----------------------------
    // 1️⃣ META VERIFICATION (GET)
    // ----------------------------
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
        return res.status(200).send(challenge);
      }

      console.warn("WEBHOOK_VERIFY_DENIED", {
        mode,
        tokenPresent: !!token,
        envVerifyPresent: !!process.env.VERIFY_TOKEN,
      });

      return res.status(403).send("Forbidden");
    }

    // ----------------------------
    // 2️⃣ INCOMING EVENTS (POST)
    // ----------------------------
    if (req.method === "POST") {
      console.log("META_WEBHOOK_POST_RECEIVED");

      const body = req.body;
      console.log(JSON.stringify(body));

      if (body?.object === "page") {
        for (const entry of body.entry || []) {
          for (const evt of entry.messaging || []) {
            const psid = evt?.sender?.id;

            // Ignore echoes (prevents loops)
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

      return res.status(200).send("EVENT_RECEIVED");
    }

    // ----------------------------
    // 3️⃣ METHOD NOT ALLOWED
    // ----------------------------
    return res.status(405).send("Method Not Allowed");
  } catch (err) {
    console.error("WEBHOOK_FATAL_ERROR", err);
    return res.status(500).send("Internal Server Error");
  }
}

async function sendMessengerText(psid, text) {
  try {
    const token = process.env.PAGE_ACCESS_TOKEN;

    if (!token) {
      console.error("MISSING_PAGE_ACCESS_TOKEN");
      return;
    }

    const url = `https://graph.facebook.com/v24.0/me/messages?access_token=${encodeURIComponent(
      token
    )}`;

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
    console.error("SEND_MESSAGE_FATAL_ERROR", err);
  }
}
