export default async function handler(req, res) {
  // Prevent caching weirdness (helps avoid 304 behavior on GET verify)
  res.setHeader("Cache-Control", "no-store");

  console.log("WEBHOOK_HIT", req.method, req.url);

  // 1) Meta verify (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFIED");
      return res.status(200).type("text/plain").send(challenge);
    }

    console.warn("WEBHOOK_VERIFY_DENIED", { mode, tokenPresent: !!token });
    return res.status(403).type("text/plain").send("Forbidden");
  }

  // 2) Incoming events (POST)
  if (req.method === "POST") {
    const body = req.body;
    console.log("META_WEBHOOK_POST_RECEIVED");
    console.log(JSON.stringify(body));

    // Only handle Messenger Page payloads
    if (body?.object === "page") {
      for (const entry of body.entry || []) {
        for (const evt of entry.messaging || []) {
          const psid = evt?.sender?.id;
          const text = evt?.message?.text;

          // Ignore non-text events (delivery/read/attachments/etc.)
          if (!psid || !text) continue;

          // TEMP: echo reply to prove the pipe is truly end-to-end
          const reply = `✅ Connected. You said: "${text}"`;

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
}
