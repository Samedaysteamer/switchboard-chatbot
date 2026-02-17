export default async function handler(req, res) {
  // Always log the hit (so you can’t miss it in Logs)
  console.log("WEBHOOK_HIT", req.method, req.url);

  // 1) Meta verify (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFIED");
      return res.status(200).send(challenge);
    }

    console.log("WEBHOOK_VERIFY_FAILED");
    return res.status(403).send("Forbidden");
  }

  // 2) Incoming events (POST)
  if (req.method === "POST") {
    console.log("META_WEBHOOK_POST_RECEIVED");
    console.log(JSON.stringify(req.body));

    // Respond FAST so Meta doesn’t retry
    return res.status(200).send("EVENT_RECEIVED");
  }

  return res.status(405).send("Method Not Allowed");
}
