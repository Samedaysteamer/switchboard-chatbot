 export default async function handler(req, res) {
  // 1) META VERIFY (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  // 2) INCOMING EVENTS (POST)
  if (req.method === "POST") {
    console.log("META_WEBHOOK_POST_RECEIVED");
    console.log(JSON.stringify(req.body));

    // IMPORTANT: Respond FAST so Meta doesn’t retry
    return res.sendStatus(200);
  }

  return res.sendStatus(405);
}
