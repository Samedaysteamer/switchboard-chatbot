// /api/webhook.js

function reply(res, status, body) {
  // Works in Next.js API routes (res.status().send)
  if (typeof res.status === "function") return res.status(status).send(body);

  // Works in plain Node/Vercel handlers (res.statusCode + res.end)
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function getQuery(req) {
  // Next.js API routes
  if (req.query) return req.query;

  // Fallback for runtimes without req.query
  const url = new URL(req.url, "http://localhost");
  return Object.fromEntries(url.searchParams.entries());
}

async function readRawBody(req) {
  // If the platform already parsed it (Next.js often does), prefer that
  if (req.body !== undefined) return req.body;

  // Otherwise read the stream
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        // Try JSON first
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(data);
      }
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  console.log("WEBHOOK_HIT", req.method, url.pathname + url.search);

  // 1) Meta verify (GET)
  if (req.method === "GET") {
    const q = getQuery(req);
    const mode = q["hub.mode"];
    const token = q["hub.verify_token"];
    const challenge = q["hub.challenge"];

    console.log("VERIFY_CHECK", {
      mode,
      token_received: token ? "present" : "missing",
      token_matches_env: token === process.env.VERIFY_TOKEN,
      challenge_present: challenge ? "yes" : "no",
    });

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      console.log("VERIFY_OK");
      return reply(res, 200, String(challenge || ""));
    }

    console.log("VERIFY_FAIL");
    return reply(res, 403, "Forbidden");
  }

  // 2) Incoming events (POST)
  if (req.method === "POST") {
    const body = await readRawBody(req);

    console.log("META_WEBHOOK_POST_RECEIVED");
    console.log("HEADERS", {
      "content-type": req.headers["content-type"],
      "x-hub-signature-256": req.headers["x-hub-signature-256"] ? "present" : "missing",
    });

    // Log body safely
    try {
      console.log("JSON_BODY:", typeof body === "string" ? body.slice(0, 2000) : body);
    } catch (e) {
      console.log("BODY_LOG_FAIL", e?.message);
    }

    // Respond FAST so Meta doesn’t retry
    return reply(res, 200, "EVENT_RECEIVED");
  }

  return reply(res, 405, "Method Not Allowed");
}
