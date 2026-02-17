export default async function handler(req, res) {
  console.log("WEBHOOK_HIT", req.method, req.url);

  // 1) Meta verify (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // 2) Incoming events (POST)
  if (req.method === "POST") {
    // respond FAST so Meta doesn’t retry
    res.status(200).send("EVENT_RECEIVED");

    try {
      const entry = req.body?.entry?.[0];
      const messaging = entry?.messaging?.[0];
      const senderId = messaging?.sender?.id;
      const text = messaging?.message?.text;

      console.log("META_WEBHOOK_POST_RECEIVED");
      console.log("SENDER", senderId);
      console.log("IN_TEXT", text);

      // If it’s not a normal text message, do nothing (still already 200’d)
      if (!senderId || !text) return;

      // TEMP reply (proves the pipe works)
      const replyText = `Got it: "${text}"`;

      const url = `https://graph.facebook.com/v24.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`;

      const payload = {
        recipient: { id: senderId },
        messaging_type: "RESPONSE",
        message: { text: replyText },
      };

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await resp.json();

      if (!resp.ok) {
        console.log("SEND_API_ERROR", data);
      } else {
        console.log("SENT_OK", data);
      }
    } catch (err) {
      console.log("WEBHOOK_POST_HANDLER_ERROR", String(err));
    }

    return;
  }

  return res.status(405).send("Method Not Allowed");
}
