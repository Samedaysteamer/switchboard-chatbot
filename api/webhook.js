export default async function handler(req, res) {
  // Build stamp so you ALWAYS know which deployment handled the hit
  const build = {
    deployment: process.env.VERCEL_DEPLOYMENT_ID || "unknown",
    sha: process.env.VERCEL_GIT_COMMIT_SHA || "unknown",
    ref: process.env.VERCEL_GIT_COMMIT_REF || "unknown",
    url: process.env.VERCEL_URL || "unknown",
  };

  // Robust URL parsing (no url.parse deprecation weirdness)
  const fullUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);

  console.log("WEBHOOK_HIT", {
    method: req.method,
    path: fullUrl.pathname,
    query: fullUrl.search,
    build,
  });

  // Helper: read raw body if req.body isn't populated
  async function readBody() {
    if (req.body !== undefined && req.body !== null && req.body !== "") return req.body;

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }

  // 1) Meta verify (GET)
  if (req.method === "GET") {
    const mode = fullUrl.searchParams.get("hub.mode");
    const token = fullUrl.searchParams.get("hub.verify_token");
    const challenge = fullUrl.searchParams.get("hub.challenge");

    console.log("WEBHOOK_VERIFY_CHECK", { mode, tokenProvided: !!token });

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFY_OK", { challenge });
      return res.status(200).send(challenge || "");
    }

    console.log("WEBHOOK_VERIFY_FAIL", { mode, token });
    return res.status(403).send("Forbidden");
  }

  // 2) Incoming events (POST)
  if (req.method === "POST") {
    const signature = req.headers["x-hub-signature-256"];
    const body = await readBody();

    console.log("META_WEBHOOK_POST_RECEIVED", {
      signaturePresent: !!signature,
      bodyPreview:
        typeof body === "string"
          ? body.slice(0, 300)
          : JSON.stringify(body).slice(0, 300),
    });

    // Respond FAST so Meta doesn’t retry
    return res.status(200).send("EVENT_RECEIVED");
  }

  // Optional: let HEAD succeed (some systems ping with HEAD)
  if (req.method === "HEAD") {
    return res.status(200).end();
  }

  return res.status(405).send("Method Not Allowed");
}
