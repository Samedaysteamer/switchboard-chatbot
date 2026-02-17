export default async function handler(req, res) {
  console.log("WEBHOOK_HIT", req.method, req.url);

  // 1) Verification
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    return res.status(403).send("Forbidden");
  }

  // 2) Incoming Messages
  if (req.method === "POST") {
    const body = req.body;

    console.log("META_WEBHOOK_POST_RECEIVED");
    console.log(JSON.stringify(body));

    if (body.object === "page") {
      for (const entry of body.entry) {
        for (const event of entry.messaging) {
          if (event.message && event.sender && event.sender.id) {
            const senderPsid = event.sender.id;

            // 🔁 SEND MESSAGE BACK TO USER
            await fetch(
              `https://graph.facebook.com/v24.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  recipient: { id: senderPsid },
                  message: { text: "Message received. Bot is live." }
                })
              }
            );
          }
        }
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  }

  return res.status(405).send("Method Not Allowed");
}
