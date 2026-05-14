import { state, saveState } from "./state.js";
import { audit } from "./audit.js";
import { now } from "./utils.js";
import { frontierTimeoutMs, frontierFirstTokenMs } from "./config.js";
import { copyProxyResponseHeaders, proxyRequestHeaders, usageMetric } from "./proxy.js";

// ---------------------------------------------------------------------------
// In-memory frontier backend stats (reset on restart)
// ---------------------------------------------------------------------------

// { [backendId]: { inflightRequests, totalRequests, totalInputTokens, totalOutputTokens, estimatedCostUsd, recentRequests: [{at, type}] } }
const _stats = {};

export function getFrontierStats(backendId) {
  if (!_stats[backendId]) {
    _stats[backendId] = {
      inflightRequests: 0,
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
      recentRequests: [] // {at: isoString, type: "frontier"|"local", backendId?}
    };
  }
  return _stats[backendId];
}

export function getAllFrontierStats() {
  return _stats;
}

// ---------------------------------------------------------------------------
// Per-route local vs frontier request counters (last hour)
// Rolling window tracked via recentRequests on each route's stats entry.
// ---------------------------------------------------------------------------

// { [routeName]: { recentRequests: [{at, type}] } }
const _routeStats = {};

export function getRouteStats(routeName) {
  if (!_routeStats[routeName]) {
    _routeStats[routeName] = { recentRequests: [] };
  }
  return _routeStats[routeName];
}

function recordRouteRequest(routeName, type) {
  const stats = getRouteStats(routeName);
  const cutoff = Date.now() - 60 * 60 * 1000;
  stats.recentRequests = stats.recentRequests.filter((r) => new Date(r.at).getTime() > cutoff);
  stats.recentRequests.push({ at: now(), type });
}

export function getRouteHourlyBreakdown(routeName) {
  const stats = getRouteStats(routeName);
  const cutoff = Date.now() - 60 * 60 * 1000;
  const recent = stats.recentRequests.filter((r) => new Date(r.at).getTime() > cutoff);
  return {
    localRequests: recent.filter((r) => r.type === "local").length,
    frontierRequests: recent.filter((r) => r.type === "frontier").length,
    total: recent.length
  };
}

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

function trackFrontierUsage(backend, responseBody) {
  const stats = getFrontierStats(backend.id);
  if (!responseBody?.usage) return;
  const input = usageMetric(responseBody.usage.prompt_tokens ?? responseBody.usage.input_tokens);
  const output = usageMetric(responseBody.usage.completion_tokens ?? responseBody.usage.output_tokens);
  stats.totalInputTokens += input;
  stats.totalOutputTokens += output;
  if (backend.costPer1kInputTokens) stats.estimatedCostUsd += (input / 1000) * backend.costPer1kInputTokens;
  if (backend.costPer1kOutputTokens) stats.estimatedCostUsd += (output / 1000) * backend.costPer1kOutputTokens;
}

// ---------------------------------------------------------------------------
// Proxy to frontier backend
// ---------------------------------------------------------------------------

/**
 * Forward a request to an OpenAI-compatible frontier backend.
 * Rewrites req.body.model to backend.model, injects auth + extra headers,
 * merges requestDefaults, and proxies the response (streaming or not).
 *
 * Known limitation: if the backend errors after streaming has begun
 * (headers already sent), the partial stream is closed and the error is
 * logged. Fallback is only possible before the first byte is sent.
 */
export async function proxyToFrontier(backend, req, res, routeName) {
  if (!backend) {
    res.status(500).json({ error: { message: "Frontier backend not found", type: "server_error" } });
    return;
  }

  const stats = getFrontierStats(backend.id);
  stats.inflightRequests++;
  stats.totalRequests++;

  if (routeName) recordRouteRequest(routeName, "frontier");

  // Build request body — merge requestDefaults (caller wins on conflict), rewrite model
  const incomingBody = req.body && typeof req.body === "object" ? req.body : {};
  const defaults = backend.requestDefaults && typeof backend.requestDefaults === "object"
    ? backend.requestDefaults : {};
  const outgoingBody = { ...defaults, ...incomingBody, model: backend.model };

  // Build headers — strip hop-by-hop, drop caller's Authorization, inject ours
  const headers = proxyRequestHeaders(req);
  headers["authorization"] = `Bearer ${backend.apiKey || ""}`;
  headers["content-type"] = "application/json";
  if (backend.extraHeaders && typeof backend.extraHeaders === "object") {
    Object.entries(backend.extraHeaders).forEach(([k, v]) => {
      headers[k.toLowerCase()] = v;
    });
  }

  // Build target URL — baseUrl is the OpenAI-compatible root (e.g. https://openrouter.ai/api/v1).
  // The interceptor is only mounted on /v1/chat/completions, so we always append that endpoint,
  // stripping the /v1 prefix already included in req.path to avoid doubling it.
  const basePath = String(backend.baseUrl || "").replace(/\/$/, "");
  const endpoint = req.path.replace(/^\/v1/, "") || "/chat/completions";
  const targetUrl = `${basePath}${endpoint}`;

  const abortController = new AbortController();
  req.on("aborted", () => { if (!res.writableEnded) abortController.abort(); });
  res.on("close", () => { if (!res.writableEnded) abortController.abort(); });

  const headersTimeoutMs = Number(backend.headersTimeoutMs || frontierTimeoutMs);
  const firstTokenMs = frontierFirstTokenMs;
  let headersTimedOut = false;

  const headersTimer = setTimeout(() => {
    if (!res.headersSent) {
      headersTimedOut = true;
      abortController.abort();
    }
  }, headersTimeoutMs);

  const startedAt = Date.now();
  let finalized = false;

  function finalize() {
    if (finalized) return;
    finalized = true;
    clearTimeout(headersTimer);
    stats.inflightRequests = Math.max(0, stats.inflightRequests - 1);
  }

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(outgoingBody),
      signal: abortController.signal
    });

    clearTimeout(headersTimer);

    if (!upstreamRes.ok && !res.headersSent) {
      const errText = await upstreamRes.text().catch(() => "");
      let errBody;
      try { errBody = JSON.parse(errText); } catch { errBody = { error: { message: errText || upstreamRes.statusText, type: "upstream_error" } }; }
      finalize();
      res.status(upstreamRes.status).json(errBody);
      return;
    }

    const isStreaming = String(outgoingBody.stream) === "true" || outgoingBody.stream === true;

    if (!isStreaming) {
      // Non-streaming: buffer entire response
      const responseText = await upstreamRes.text();
      finalize();
      let parsed;
      try { parsed = JSON.parse(responseText); } catch { parsed = null; }
      if (parsed) {
        trackFrontierUsage(backend, parsed);
        res.status(upstreamRes.status);
        copyProxyResponseHeaders(upstreamRes.headers, res);
        res.json(parsed);
      } else {
        res.status(upstreamRes.status);
        copyProxyResponseHeaders(upstreamRes.headers, res);
        res.type("text/plain").send(responseText);
      }
      audit("orchestration.frontier.complete", {
        backendId: backend.id, backendName: backend.name,
        routeName, latencyMs: Date.now() - startedAt, streaming: false
      });
      return;
    }

    // Streaming: buffer the entire SSE stream then forward as SSE
    // (same pattern as proxyToInstance — buffer lets us track usage from final chunk)
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    copyProxyResponseHeaders(upstreamRes.headers, res);
    res.status(upstreamRes.status);

    let firstTokenTimer = setTimeout(() => {
      if (!res.writableEnded) {
        console.warn(`[frontier] first token timeout (${firstTokenMs}ms) backend=${backend.name}`);
        abortController.abort();
      }
    }, firstTokenMs);

    const reader = upstreamRes.body?.getReader();
    if (!reader) {
      clearTimeout(firstTokenTimer);
      finalize();
      if (!res.writableEnded) res.end();
      return;
    }

    const decoder = new TextDecoder();
    let sseBuffer = "";
    let firstToken = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstToken) {
          firstToken = true;
          clearTimeout(firstTokenTimer);
        }
        const chunk = decoder.decode(value, { stream: true });
        sseBuffer += chunk;
        if (!res.writableEnded) res.write(chunk);
      }
    } catch (streamErr) {
      clearTimeout(firstTokenTimer);
      if (!res.writableEnded) res.end();
      finalize();
      console.warn(`[frontier] stream error backend=${backend.name}:`, streamErr?.message);
      return;
    }

    clearTimeout(firstTokenTimer);
    if (!res.writableEnded) res.end();
    finalize();

    // Extract usage from last data chunk for cost tracking
    const lines = sseBuffer.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload);
        if (chunk?.usage) { trackFrontierUsage(backend, chunk); break; }
      } catch { /* skip */ }
    }

    audit("orchestration.frontier.complete", {
      backendId: backend.id, backendName: backend.name,
      routeName, latencyMs: Date.now() - startedAt, streaming: true
    });

  } catch (err) {
    finalize();
    if (headersTimedOut) {
      if (!res.headersSent) res.status(504).json({ error: { message: "Frontier backend timed out", type: "timeout" } });
      else if (!res.writableEnded) res.end();
      return;
    }
    if (!res.headersSent) {
      res.status(502).json({ error: { message: `Frontier proxy error: ${err?.message || "unknown"}`, type: "proxy_error" } });
    } else if (!res.writableEnded) {
      res.end();
    }
    console.error(`[frontier] error backend=${backend.name}:`, err?.message);
  }
}
