export default {
  async fetch(request, env) {
    const allowedOrigin = "https://cordovank.github.io";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(allowedOrigin) });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, allowedOrigin);
    }

    try {
      const body = await request.json();
      const messages = body.messages;
      const provider = (body.provider || "openai").toLowerCase();

      if (!Array.isArray(messages) || messages.length === 0) {
        return json({ error: "Missing messages array" }, 400, allowedOrigin);
      }

      const providers = getProviderRegistry(env);

      if (!providers[provider]) {
        return json({ error: `Unsupported provider: ${provider}` }, 400, allowedOrigin);
      }

      const result = await providers[provider].call(messages);

      return json({ answer: result }, 200, allowedOrigin);
    } catch (err) {
      return json(
        { error: "Worker error", details: String(err) },
        500,
        allowedOrigin
      );
    }
  },
};

function getProviderRegistry(env) {
  return {
    openai: {
      model: env.OPENAI_MODEL || "gpt-5-nano",
      maxTokens: parsePositiveInt(env.OPENAI_MAX_TOKENS, 300),
      call: async (messages) => {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: env.OPENAI_MODEL || "gpt-5-nano",
            max_tokens: parsePositiveInt(env.OPENAI_MAX_TOKENS, 300),
            messages,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(`OpenAI error ${response.status}: ${JSON.stringify(data)}`);
        }

        return data.choices?.[0]?.message?.content ?? "No response.";
      },
    },

    anthropic: {
      model: env.ANTHROPIC_MODEL || "claude-haiku-4-5",
      maxTokens: parsePositiveInt(env.ANTHROPIC_MAX_TOKENS, 300),
      call: async (messages) => {
        const systemMessages = messages.filter((m) => m.role === "system");
        const nonSystemMessages = messages.filter((m) => m.role !== "system");

        const system = systemMessages.map((m) => m.content).join("\n\n");

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: env.ANTHROPIC_MODEL || "claude-haiku-4-5",
            max_tokens: parsePositiveInt(env.ANTHROPIC_MAX_TOKENS, 300),
            system,
            messages: nonSystemMessages,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(`Anthropic error ${response.status}: ${JSON.stringify(data)}`);
        }

        return data.content?.[0]?.text ?? "No response.";
      },
    },
  };
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(origin),
  });
}