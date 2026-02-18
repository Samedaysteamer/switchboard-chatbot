// /api/webhook.js

export default async function handler(req, res) {
  // Never cache webhook responses
  res.setHeader("Cache-Control", "no-store");

  console.log("WEBHOOK_VERSION", "2026-02-18_02");
  console.log("WEBHOOK_HIT", req.method, req.url);

  try {
    // 1) Meta verify (GET)
    if (req.method === "GET") {
      const query = getQuery(req);

      const mode = query["hub.mode"];
      const token = query["hub.verify_token"];
      const challenge = query["hub.challenge"];

      // If this is NOT a Meta verification request, treat it as a healthcheck
      if (!mode && !token && !challenge) {
        return sendText(res, 200, "OK");
      }

      const expected = (process.env.VERIFY_TOKEN || "").trim();
      const provided = (token || "").toString().trim();

      const ok = mode === "subscribe" && expected && provided === expected;

      if (ok) {
        console.log("WEBHOOK_VERIFIED");
        return sendText(res, 200, challenge || "");
      }

      console.warn("WEBHOOK_VERIFY_DENIED", {
        mode,
        tokenPresent: !!token,
        envVerifyPresent: !!process.env.VERIFY_TOKEN,
        tokenMatched: !!expected && provided === expected,
      });

      return sendText(res, 403, "Forbidden");
    }

    // 2) Incoming events (POST)
    if (req.method === "POST") {
      const body = await getBody(req);

      console.log("META_WEBHOOK_POST_RECEIVED");
      // During debug only — can be large
      try {
        console.log(JSON.stringify(body));
      } catch {
        console.log("BODY_UNSTRINGIFIABLE");
      }

      if (body?.object === "page") {
        for (const entry of body.entry || []) {
          for (const evt of entry.messaging || []) {
            const psid = evt?.sender?.id;

            // Ignore echoes sent by the page (prevents loops)
            if (evt?.message?.is_echo) continue;

            const text = evt?.message?.text;

            // Ignore non-text events (delivery/read/attachments/etc.)
            if (!psid || !text) continue;

            const reply = `✅ Connected. You said: "${text}"`;
            await sendMessengerText(psid, reply);
          }
        }
      } else {
        console.log("NON_PAGE_WEBHOOK_OBJECT", body?.object);
      }

      return sendText(res, 200, "EVENT_RECEIVED");
    }

    // 3) Anything else
    res.setHeader("Allow", "GET, POST");
    return sendText(res, 405, "Method Not Allowed");
  } catch (err) {
    console.error("WEBHOOK_FATAL_ERROR", err);
    // Always respond something (prevents function hanging)
    return sendText(res, 500, "Internal Server Error");
  }
}

/**
 * Send a plain text response (Vercel/Next safe — no Express-only methods).
 */
function sendText(res, statusCode, text) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(typeof text === "string" ? text : String(text ?? ""));
}

/**
 * Robust query parsing across runtimes.
 */
function getQuery(req) {
  // If runtime provides req.query (common on Vercel/Next), use it.
  if (req.query && typeof req.query === "object") return req.query;

  // Fallback: parse from URL
  const url = safeURL(req.url);
  const out = {};
  for (const [k, v] of url.searchParams.entries()) out[k] = v;
  return out;
}

function safeURL(maybePath) {
  try {
    return new URL(maybePath || "/", "http://localhost");
  } catch {
    return new URL("/", "http://localhost");
  }
}

/**
 * Robust body parsing:
 * - Uses req.body if already parsed
 * - Otherwise reads raw stream and attempts JSON parse
 */
async function getBody(req) {
  if (req.body !== undefined) {
    // Some runtimes give string bodies; normalize
    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body);
      } catch {
        return req.body;
      }
    }
    return req.body;
  }

  // Raw stream fallback
  const raw = await readRawBody(req);
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readRawBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

async function sendMessengerText(psid, text) {
  const token = process.env.PAGE_ACCESS_TOKEN;

  if (!token) {
    console.error("MISSING_PAGE_ACCESS_TOKEN");
    return;
  }

  const graphVersion = process.env.GRAPH_VERSION || "v25.0";
  const url = `https://graph.facebook.com/${graphVersion}/me/messages?access_token=${encodeURIComponent(
    token
  )}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
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
    console.error("SEND_API_FATAL", err?.name || err, err);
  } finally {
    clearTimeout(timeout);
  }
}
