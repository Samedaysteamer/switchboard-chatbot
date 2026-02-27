async function openaiChat(messages, { jsonMode = false, maxTokens = 450 } = {}) {
  if (!OPENAI_API_KEY) throw new Error("Missing OpenAI API key.");

  const _fetch = global.fetch || require("node-fetch");

  const attempt = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

    const payload = {
      model: OPENAI_MODEL,
      temperature: OPENAI_TEMPERATURE,
      max_tokens: maxTokens,
      messages
    };
    if (jsonMode) payload.response_format = { type: "json_object" };

    try {
      const resp = await _fetch(`${OPENAI_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      // If OpenAI returns a transient failure, throw so we can retry once
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const code = resp.status;
        const err = new Error(`OpenAI HTTP ${code}: ${text.slice(0, 200)}`);
        err.status = code;
        throw err;
      }

      const data = await resp.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content || "";
      return String(content || "").trim();
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    return await attempt();
  } catch (e) {
    const status = e?.status;
    const msg = String(e?.message || "");
    const retryable =
      msg.includes("aborted") ||
      msg.includes("AbortError") ||
      status === 429 ||
      (typeof status === "number" && status >= 500);

    if (!retryable) throw e;

    // small backoff then retry once
    await new Promise(r => setTimeout(r, 350));
    return await attempt();
  }
}
