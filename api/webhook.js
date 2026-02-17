export default async function handler(req, res) {
  const host =
    req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const url = new URL(req.url, `https://${host}`);

  // Always log the hit (so you can’t miss it in Logs)
  console.log("WEBHOOK_HIT", req.method, url.pathname + url.search);

  // 1) Meta verify (GET)
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end(challenge || "");
      return;
    }

    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain");
    res.end("Forbidden");
    return;
  }

  // 2) Incoming events (POST)
  if (req.method === "POST") {
    const rawBody = await readRawBody(req);

    console.log("META_WEBHOOK_POST_RECEIVED");
    console.log("RAW_BODY:", rawBody);

    // If it’s JSON, log the parsed version too
    try {
      const parsed = JSON.parse(rawBody || "{}");
      console.log("JSON_BODY:", JSON.stringify(parsed));
    } catch (e) {
      console.log("JSON_PARSE_FAILED");
    }

    // Respond FAST so Meta doesn’t retry
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("EVENT_RECEIVED");
    return;
  }

  res.statusCode = 405;
  res.setHeader("Content-Type", "text/plain");
  res.end("Method Not Allowed");
}

function readRawBody(req) {
  // If Vercel already parsed it (sometimes), use it
  if (req.body && typeof req.body === "object") return Promise.resolve(JSON.stringify(req.body));
  if (typeof req.body === "string") return Promise.resolve(req.body);

  // Otherwise read the raw stream
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
