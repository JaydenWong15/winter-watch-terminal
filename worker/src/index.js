// Winter Watch Terminal — Cloudflare Worker key proxy (TAPI template, Anthropic Messages API)
// + a small shared decision log (Approve/Reject), so Duty and Senior Engineers see the
// same history regardless of whose browser they're using.
//
// The page calls this Worker; the Worker holds the API key as the Cloudflare secret
// ANTHROPIC_API_KEY. The key is never in this file or on GitHub.
//
// Safeguards: origin lock (CORS), model allowlist, max_tokens cap, effort allowlist,
// body size limits, per-visitor hourly rate limit in KV (binding RATE).
// The real money cap is the spend limit on the Anthropic workspace that owns the key.
// Honest limit: the decision log is a single read-modify-write KV value — fine at this
// scale (a handful of engineers, a few decisions a day), but not safe under heavy
// concurrent writes; it is not a system of record.

// ===== CONFIG =====
const ALLOWED_ORIGIN = "https://jaydenwong15.github.io";
const ALLOWED_MODELS = ["claude-haiku-5-5"];
const MAX_TOKENS = 16000;
const MAX_BODY_BYTES = 200_000;
const HOURLY_LIMIT = 20; // AI calls per visitor per hour
const DECISIONS_HOURLY_LIMIT = 100; // decision-log writes per visitor per hour (no LLM cost, just abuse guard)
const DECISIONS_MAX = 100; // keep the most recent N decisions
const ALLOWED_EFFORT = ["low", "medium"];
const UPSTREAM = "https://api.anthropic.com/v1/messages";
// ==================

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Expose-Headers": "x-proxy-remaining",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(status, body, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors(origin), ...extra }
  });
}

function error(status, message, origin, extra = {}) {
  return json(status, { error: { type: "proxy_error", message } }, origin, extra);
}

async function checkRateLimit(env, ip, prefix, limit) {
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `${prefix}:${ip}:${hour}`;
  const used = parseInt((await env.RATE.get(key)) || "0", 10);
  if (used >= limit) return { ok: false, used };
  await env.RATE.put(key, String(used + 1), { expirationTtl: 7200 });
  return { ok: true, used };
}

async function handleMessages(request, env, origin) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return error(413, "Request too large.", origin);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return error(400, "Invalid JSON.", origin); }
  if (!ALLOWED_MODELS.includes(body.model)) return error(400, `Only ${ALLOWED_MODELS.join(", ")} allowed through the shared key.`, origin);
  if (!Array.isArray(body.messages) || body.messages.length === 0) return error(400, "No messages.", origin);
  const effort = body.output_config && body.output_config.effort;
  if (effort && !ALLOWED_EFFORT.includes(effort)) return error(400, `Effort must be ${ALLOWED_EFFORT.join(" or ")}.`, origin);
  if (!env.ANTHROPIC_API_KEY) return error(503, "The shared key has not been set up yet.", origin);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rl = await checkRateLimit(env, ip, "rl", HOURLY_LIMIT);
  if (!rl.ok) return error(429, `Hourly limit reached (${HOURLY_LIMIT} requests per visitor per hour). Try again later.`, origin, { "x-proxy-remaining": "0" });

  const forward = {
    model: body.model,
    max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS),
    system: body.system,
    messages: body.messages
  };
  if (body.output_config) {
    forward.output_config = {};
    if (effort) forward.output_config.effort = effort;
  }

  const upstream = await fetch(UPSTREAM, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(forward)
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "x-proxy-remaining": String(HOURLY_LIMIT - rl.used - 1),
      ...cors(origin)
    }
  });
}

async function handleGetDecisions(env, origin) {
  const raw = await env.RATE.get("decisions:list");
  const list = raw ? JSON.parse(raw) : [];
  return json(200, list, origin);
}

async function handlePostDecisions(request, env, origin) {
  const raw = await request.text();
  if (raw.length > 5_000) return error(413, "Request too large.", origin);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return error(400, "Invalid JSON.", origin); }
  if (!["s1", "s2"].includes(body.section)) return error(400, "section must be s1 or s2.", origin);
  if (!["approve", "override", "reject"].includes(body.action)) return error(400, "Invalid action.", origin);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rl = await checkRateLimit(env, ip, "decrl", DECISIONS_HOURLY_LIMIT);
  if (!rl.ok) return error(429, "Too many decision-log writes this hour.", origin);

  const entry = {
    ts: new Date().toISOString(),
    section: body.section,
    action: body.action,
    verdict: typeof body.verdict === "string" ? body.verdict.slice(0, 80) : null,
    routes: Number.isFinite(body.routes) ? body.routes : null,
    route: typeof body.route === "string" ? body.route.slice(0, 80) : null,
  };

  const raw2 = await env.RATE.get("decisions:list");
  const list = raw2 ? JSON.parse(raw2) : [];
  list.unshift(entry);
  await env.RATE.put("decisions:list", JSON.stringify(list.slice(0, DECISIONS_MAX)));

  return json(201, entry, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (origin !== ALLOWED_ORIGIN) return error(403, "This service only answers its own page.", origin);

    if (request.method === "POST" && url.pathname === "/v1/messages") return handleMessages(request, env, origin);
    if (request.method === "GET" && url.pathname === "/decisions") return handleGetDecisions(env, origin);
    if (request.method === "POST" && url.pathname === "/decisions") return handlePostDecisions(request, env, origin);

    return error(404, "Not found.", origin);
  }
};
