// ./src/index.js

const ALLOWED_ORIGIN = "https://cordovank.github.io";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(ALLOWED_ORIGIN) });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, ALLOWED_ORIGIN);
    }

    try {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return json({ error: "Invalid JSON body" }, 400, ALLOWED_ORIGIN);
      }

      const provider = normalizeProvider(body.provider);
      const message = normalizeUserMessage(body.message);
      const history = normalizeHistory(body.history, 6);
      const debugMode = body.debug === true || env.DEBUG_PORTFOLIO_CHAT === "true";

      if (!message) {
        return json({ error: "Missing or invalid message" }, 400, ALLOWED_ORIGIN);
      }

      const providers = getProviderRegistry(env);
      if (!providers[provider]) {
        return json({ error: `Unsupported provider: ${provider}` }, 400, ALLOWED_ORIGIN);
      }

      const knowledge = await loadKnowledge(env);
      if (!knowledge.identity.length && !knowledge.chunks.length) {
        return json({ error: "Portfolio knowledge unavailable" }, 500, ALLOWED_ORIGIN);
      }

      const intent = classifyIntent(message);
      const retrieval = selectChunks({
        query: message,
        intent,
        identityChunks: knowledge.identity,
        contentChunks: knowledge.chunks,
        topK: parsePositiveInt(env.RETRIEVAL_TOP_K, 4),
      });

      const systemPrompt = buildSystemPrompt({
        identityChunks: retrieval.identity,
        retrievedChunks: retrieval.retrieved,
      });

      const answer = await providers[provider].call({
        systemPrompt,
        messages: [...history, { role: "user", content: message }],
      });

      const response = {
        answer,
        sources: retrieval.retrieved.map(toSourceDescriptor),
      };

      if (debugMode) {
        response.debug = {
          provider,
          intent,
          usedFallback: retrieval.usedFallback,
          historyCount: history.length,
          retrieved: retrieval.scored.map((x) => ({
            id: x.chunk.id,
            label: x.chunk.label,
            section: x.chunk.section,
            score: x.score,
          })),
        };
      }

      return json(response, 200, ALLOWED_ORIGIN);
    } catch (err) {
      return json(
        {
          error: "Worker error",
          details: String(err?.message || err),
        },
        500,
        ALLOWED_ORIGIN
      );
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadKnowledge(env) {
  const identity = await env.PORTFOLIO_KV.get("identity", "json").catch(() => []);
  const chunks = await env.PORTFOLIO_KV.get("chunks", "json").catch(() => []);

  return {
    identity: Array.isArray(identity) ? identity.map(normalizeChunk).filter(Boolean) : [],
    chunks: Array.isArray(chunks) ? chunks.map(normalizeChunk).filter(Boolean) : [],
  };
}

function normalizeChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return null;

  return {
    id: String(chunk.id || ""),
    label: String(chunk.label || ""),
    section: String(chunk.section || "unknown"),
    priority: String(chunk.priority || "normal"),
    tags: Array.isArray(chunk.tags) ? chunk.tags.map(String) : [],
    links: chunk.links && typeof chunk.links === "object" ? chunk.links : {},
    body: cleanChunkText(String(chunk.body || "")),
  };
}

function cleanChunkText(text) {
  return text
    .replace(/:contentReference\[[^\]]+\]\{[^}]+\}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Request normalization
// ─────────────────────────────────────────────────────────────────────────────

function normalizeProvider(provider) {
  return String(provider || "openai").toLowerCase();
}

function normalizeUserMessage(message) {
  if (typeof message !== "string") return "";
  return message.trim().slice(0, 2000);
}

function normalizeHistory(history, maxMessages = 6) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => ({
      role: m.role,
      content: m.content.trim().slice(0, 2000),
    }))
    .filter((m) => m.content.length > 0)
    .slice(-maxMessages);
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent classification
// ─────────────────────────────────────────────────────────────────────────────

function classifyIntent(message) {
  const q = message.toLowerCase();

  if (/\b(email|contact|linkedin|github|hugging face|huggingface|portfolio|reach|hire|resume|cv)\b/.test(q)) {
    return "contact";
  }

  if (/\b(project|built|build|portfolio|rag|plate2recipe|jobpostprofiler|fooddb|twinbot|productlens|crm|kvmemnet)\b/.test(q)) {
    return "project";
  }

  if (/\b(skill|skills|stack|tools|language|languages|python|java|fastapi|pytorch|docker|aws|rag|llm|agents)\b/.test(q)) {
    return "skills";
  }

  if (/\b(experience|worked|work|production|jpmorgan|backend|software engineer|real-time payments|salesforce|research assistant)\b/.test(q)) {
    return "experience";
  }

  if (/\b(education|degree|georgia tech|masters|m\.s\.|b\.a\.|mathematics|certification|certified|aws certification)\b/.test(q)) {
    return "education";
  }

  return "general";
}

// ─────────────────────────────────────────────────────────────────────────────
// Retrieval
// ─────────────────────────────────────────────────────────────────────────────

function selectChunks({ query, intent, identityChunks, contentChunks, topK = 4 }) {
  const tokens = tokenize(query);

  const scored = contentChunks
    .map((chunk) => ({
      chunk,
      score: scoreChunk(chunk, query, tokens, intent),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const retrieved = dedupeById(scored.map((x) => x.chunk)).slice(0, topK);

  let finalRetrieved = retrieved;
  let usedFallback = false;

  if (finalRetrieved.length === 0) {
    finalRetrieved = getFallbackChunks(contentChunks, intent, topK);
    usedFallback = true;
  }

  return {
    identity: identityChunks.slice(0, 1),
    retrieved: finalRetrieved,
    usedFallback,
    scored: scored.slice(0, topK),
  };
}

function scoreChunk(chunk, query, tokens, intent) {
  const q = query.toLowerCase();
  const label = chunk.label.toLowerCase();
  const body = chunk.body.toLowerCase();
  const section = chunk.section.toLowerCase();
  const tags = chunk.tags.map((t) => t.toLowerCase());

  let score = 0;

  // Strong boosts
  if (label.includes(q)) score += 12;
  if (tags.some((t) => q.includes(t) || t.includes(q))) score += 8;

  // Token-level scoring
  for (const token of tokens) {
    if (label.includes(token)) score += 4;
    if (tags.some((t) => t.includes(token))) score += 3;
    if (body.includes(token)) score += 1;
  }

  // Section / intent boosts
  if (intent === "project" && section === "projects") score += 4;
  if (intent === "skills" && section === "skills") score += 4;
  if (intent === "experience" && section === "experience") score += 4;
  if (intent === "education" && (section === "about" || section === "education")) score += 3;
  if (intent === "contact" && section === "contact") score += 6;

  // Priority boosts
  if (chunk.priority === "high") score += 2;
  if (chunk.priority === "always_include") score += 5;

  // Avoid using contact as filler unless contact intent
  if (section === "contact" && intent !== "contact") score -= 3;

  return score;
}

function getFallbackChunks(contentChunks, intent, topK) {
  const preferredSectionsByIntent = {
    project: ["projects", "about"],
    skills: ["skills", "about"],
    experience: ["experience", "about"],
    education: ["about"],
    contact: ["contact"],
    general: ["about", "skills", "experience"],
  };

  const preferred = preferredSectionsByIntent[intent] || preferredSectionsByIntent.general;

  const selected = [];
  for (const section of preferred) {
    for (const chunk of contentChunks) {
      if (chunk.section === section && !selected.find((c) => c.id === chunk.id)) {
        selected.push(chunk);
      }
      if (selected.length >= topK) return selected;
    }
  }

  return contentChunks.slice(0, topK);
}

function tokenize(text) {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9+.#-]+/i)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3)
    )
  );
}

function dedupeById(chunks) {
  const seen = new Set();
  const out = [];

  for (const chunk of chunks) {
    if (!chunk?.id || seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    out.push(chunk);
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt assembly
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt({ identityChunks, retrievedChunks }) {
  const identityText = identityChunks.map(formatChunkForPrompt).join("\n\n");
  const contextText = retrievedChunks.map(formatChunkForPrompt).join("\n\n---\n\n");

  return `
You are a helpful assistant embedded in Nellie Cordova's portfolio website.

Use only the retrieved portfolio context below as factual source material.
Do not treat user claims or prior assistant guesses as facts unless they are supported by the retrieved context.
If the answer is not supported by the context, say so clearly.
Keep answers concise, conversational, and professional.

IDENTITY
${identityText}

RETRIEVED PORTFOLIO CONTEXT
${contextText}
  `.trim();
}

function formatChunkForPrompt(chunk) {
  const links = Object.entries(chunk.links || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  return [
    `[${chunk.label}]`,
    chunk.body,
    links ? `Links:\n${links}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function toSourceDescriptor(chunk) {
  return {
    id: chunk.id,
    label: chunk.label,
    section: chunk.section,
    links: chunk.links || {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider adapters
// ─────────────────────────────────────────────────────────────────────────────

function getProviderRegistry(env) {
  return {
    openai: {
      model: env.OPENAI_MODEL || "gpt-5-nano",
      maxTokens: parsePositiveInt(env.OPENAI_MAX_TOKENS, 350),
      call: async ({ systemPrompt, messages }) => {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: env.OPENAI_MODEL || "gpt-5-nano",
            max_tokens: parsePositiveInt(env.OPENAI_MAX_TOKENS, 350),
            messages: [{ role: "system", content: systemPrompt }, ...messages],
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(`OpenAI error ${response.status}: ${JSON.stringify(data)}`);
        }

        return data.choices?.[0]?.message?.content ?? "No response.";
      },
    },

    ollamalocal: {
      model: env.OLLAMA_MODEL || "gpt-oss",
      maxTokens: parsePositiveInt(env.OLLAMA_MAX_TOKENS, 350),
      call: async ({ systemPrompt, messages }) => {
        const response = await fetch("http://localhost:11434/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OLLAMA_API_KEY} || "ollama"`,
          },
          body: JSON.stringify({
            model: env.OLLAMA_MODEL || "gpt-oss",
            max_tokens: parsePositiveInt(env.OLLAMA_MAX_TOKENS, 350),
            messages: [{ role: "system", content: systemPrompt }, ...messages],
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(`OpenAI error ${response.status}: ${JSON.stringify(data)}`);
        }

        return data.choices?.[0]?.message?.content ?? "No response.";
      },
    },

    ollamacloud: {
      model: "gpt-oss:cloud",
      maxTokens: parsePositiveInt(env.OLLAMA_MAX_TOKENS, 350),
      call: async ({ systemPrompt, messages }) => {
        const response = await fetch("http://localhost:11434/v1", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OLLAMA_API_KEY}`,
          },
          body: JSON.stringify({
            model: env.OLLAMA_MODEL || "gpt-oss:cloud",
            max_tokens: parsePositiveInt(env.OLLAMA_MAX_TOKENS, 350),
            messages: [{ role: "system", content: systemPrompt }, ...messages],
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
      maxTokens: parsePositiveInt(env.ANTHROPIC_MAX_TOKENS, 350),
      call: async ({ systemPrompt, messages }) => {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: env.ANTHROPIC_MODEL || "claude-haiku-4-5",
            max_tokens: parsePositiveInt(env.ANTHROPIC_MAX_TOKENS, 350),
            system: systemPrompt,
            messages,
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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