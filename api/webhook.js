export const config = {
  api: {
    bodyParser: true,
  },
};

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    console.log("WEBHOOK_VERSION", "2026-02-18_SAFE_BUILD");
    console.log("WEBHOOK_HIT", req.method, req.url);

    // -------------------------
    // 1) META VERIFY (GET)
    // -------------------------
    if (req.method === "GET") {
      const mode = req.query?.["hub.mode"];
      const token = req.query?.["hub.verify_token"];
      const challenge = req.query?.["hub.challenge"];

      const ok =
        mode === "subscribe" &&
        token &&
        process.env.VERIFY_TOKEN &&
        token === process.env.VERIFY_TOKEN;

      if (ok) {
        console.log("WEBHOOK_VERIFIED");
        return res.status(200).type("text/plain").send(challenge || "");
      }

      console.warn("WEBHOOK_VERIFY_DENIED", {
        mode,
        tokenPresent: !!token,
        envVerifyPresent: !!process.env.VERIFY_TOKEN,
      });

      return res.status(403).type("text/plain").send("Forbidden");
    }

    // -------------------------
    // 2) INCOMING EVENTS (POST)
    // -------------------------
    if (req.method === "POST") {
      console.log("META_WEBHOOK_POST_RECEIVED");

      const body = req.body || {};

      try {
        console.log("META_PAYLOAD", JSON.stringify(body));
      } catch (e) {
        console.warn("PAYLOAD_STRINGIFY_FAILED");
      }

      if (body.object === "page") {
        const entries = Array.isArray(body.entry) ? body.entry : [];

        for (const entry of entries) {
          const events = Array.isArray(entry.messaging)
            ? entry.messaging
            : [];

          for (const evt of events) {
            const psid = evt?.sender?.id;

            // Ignore echoes
            if (evt?.message?.is_echo) continue;

            const text = evt?.message?.text;

            if (!psid || !text) continue;

            const reply = `✅ Connected. You said: "${text}"`;

            await safeSendMessengerText(psid, reply);
          }
        }
      } else {
        console.log("NON_PAGE_OBJECT", body.object);
      }

      return res.status(200).type("text/plain").send("EVENT_RECEIVED");
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).type("text/plain").send("Method Not Allowed");
  } catch (err) {
    console.error("WEBHOOK_FATAL_ERROR", err);
    return res.status(200).type("text/plain").send("SAFE_FAIL");
  }
}

// ------------------------------------
// SAFE SEND FUNCTION (CRASH-PROOF)
// ------------------------------------
async function safeSendMessengerText(psid, text) {
  try {
    const token = process.env.PAGE_ACCESS_TOKEN;

    if (!token) {
      console.error("MISSING_PAGE_ACCESS_TOKEN");
      return;
    }

    const url = `https://graph.facebook.com/v24.0/me/messages?access_token=${encodeURIComponent(
      token
    )}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_type: "RESPONSE",
        recipient: { id: psid },
        message: { text },
      }),
    });

    let data = {};
    try {
      data = await response.json();
    } catch (e) {
      console.warn("SEND_JSON_PARSE_FAILED");
    }

    if (!response.ok) {
      console.error("SEND_API_ERROR", response.status, data);
    } else {
      console.log("SEND_API_OK", data);
    }
  } catch (err) {
    console.error("SEND_FUNCTION_ERROR", err);
  }
}
