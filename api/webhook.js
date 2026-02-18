export default async function handler(req, res) {
  // Never cache webhook responses
  res.setHeader("Cache-Control", "no-store");

  console.log("WEBHOOK_VERSION", "2026-02-18_01");
  console.log("WEBHOOK_HIT", req.method, req.url);

  try {
    // ----------------------------
    // 1) Meta verify (GET)
    // ----------------------------
    if (req.method === "GET") {
      const mode = pickQuery(req, "hub.mode");
      const token = pickQuery(req, "hub.verify_token");
      const challenge = pickQuery(req, "hub.challenge");

      // If this is NOT a Meta verification call (no hub.* params),
      // treat it as a simple health check.
      const isVerifyAttempt = !!(mode || token || challenge);

      if (!isVerifyAttempt) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.status(200).send("OK");
      }

      const ok =
        mode === "subscribe" &&
        token &&
        process.env.VERIFY_TOKEN &&
        token === process.env.VERIFY_TOKEN;

      if (ok) {
        console.log("WEBHOOK_VERIFIED");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.status(200).send(challenge || "");
      }

      console.warn("WEBHOOK_VERIFY_DENIED", {
        mode,
        tokenPresent: !!token,
        envVerifyPresent: !!process.env.VERIFY_TOKEN,
      });

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(403).send("Forbidden");
    }

    // ----------------------------
    // 2) Incoming events (POST)
    // ----------------------------
    if (req.method === "POST") {
      const body = await getBody(req);

      console.log("META_WEBHOOK_POST_RECEIVED");
      // Log a compact view first (safer than dumping massive payloads)
      console.log(
        JSON.stringify(
          {
            object: body?.object,
            entryCount: Array.isArray(body?.entry) ? body.entry.length : 0,
          },
          null,
          2
        )
      );

      // If you want the FULL payload while debugging, uncomment:
      // console.log(JSON.stringify(body));

      const tasks = [];

      if (body?.object === "page") {
        for (const entry of body.entry || []) {
          for (const evt of entry.messaging || []) {
            const psid = evt?.sender?.id;

            // Ignore echoes sent by the page (prevents loops)
            if (evt?.message?.is_echo) continue;

            // Accept text OR postback titles/payloads (so you can see something)
            const text =
              evt?.message?.text ||
              evt?.postback?.title ||
              evt?.postback?.payload;

            if (!psid || !text) continue;

            const reply = `✅ Connected. You said: "${String(text)}"`;

            // Queue sends (parallel)
            tasks.push(sendMessengerText(psid, reply));
          }
        }
      } else {
        console.log("NON_PAGE_WEBHOOK_OBJECT", body?.object);
      }

      // Run sends but don't crash the webhook if one send fails
      if (tasks.length) {
        const results = await Promise.allSettled(tasks);
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed) console.warn("SEND_BATCH_PARTIAL_FAILURES", { failed });
      } else {
        console.log("NO_SEND_TASKS_CREATED");
      }

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send("EVENT_RECEIVED");
    }

    // ----------------------------
    // 3) Method not allowed
    // ----------------------------
    res.setHeader("Allow", "GET, POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(405).send("Method Not Allowed");
  } catch (err) {
    console.error("WEBHOOK_FATAL_ERROR", err);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(500).send("Internal Server Error");
  }
}

// ----------------------------
// Helpers
// ----------------------------

function pickQuery(req, key) {
  const v = req?.query?.[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

async function getBody(req) {
  // Next.js usually parses JSON into req.body automatically.
  // But if bodyParser is off or something odd happens, fall back to raw stream.
  if (req.body && typeof req.body === "object") return req.body;

  // If body is a string, try JSON parse
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  // Raw stream fallback
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (e) {
    console.warn("BODY_PARSE_FALLBACK_FAILED");
    return {};
  }
}

async function sendMessengerText(psid, text) {
  const token = process.env.PAGE_ACCESS_TOKEN;

  if (!token) {
    console.error("MISSING_PAGE_ACCESS_TOKEN");
    return;
  }

  const url = `https://graph.facebook.com/v25.0/me/messages?access_token=${encodeURIComponent(
    token
  )}`;

  const payload = {
    messaging_type: "RESPONSE",
    recipient: { id: psid },
    message: { text },
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      console.error("SEND_API_ERROR", resp.status, data);
    } else {
      console.log("SEND_API_OK", data);
    }
  } catch (err) {
    console.error("SEND_API_FETCH_FAILED", err);
  }
}
