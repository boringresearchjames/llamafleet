import { Readable } from "stream";
import { state, saveState } from "./state.js";
import { audit } from "./audit.js";
import { now } from "./utils.js";

// ---------------------------------------------------------------------------
// Per-request metrics
// ---------------------------------------------------------------------------

export function updateInstanceRequestMetrics(instance, delta = 0) {
  if (!instance || !Number.isFinite(delta) || delta === 0) return;
  const current = Number(instance.inflightRequests || 0);
  const nextInflight = Math.max(0, current + delta);
  instance.inflightRequests = nextInflight;
  const maxInflight = Math.max(1, Number(instance.maxInflightRequests || 1));
  instance.queueDepth = Math.max(0, nextInflight - maxInflight);
  if (delta > 0) instance.lastActivityAt = now();
  instance.updatedAt = now();
}

export function usageMetric(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

export function updateInstanceUsageMetrics(instance, responsePayload) {
  if (!instance || !responsePayload || typeof responsePayload !== "object") return;
  const usage = responsePayload.usage;
  if (!usage || typeof usage !== "object") return;
  const promptTokens = usageMetric(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = usageMetric(usage.completion_tokens ?? usage.output_tokens);
  const inferredTotal = usageMetric(usage.total_tokens);
  const totalTokens = inferredTotal > 0 ? inferredTotal : (promptTokens + completionTokens);
  instance.totalPromptTokens = usageMetric(instance.totalPromptTokens) + promptTokens;
  instance.totalCompletionTokens = usageMetric(instance.totalCompletionTokens) + completionTokens;
  instance.totalTokens = usageMetric(instance.totalTokens) + totalTokens;
  instance.lastActivityAt = now();
  instance.updatedAt = now();
}

export function markProxyCompletion(instance) {
  if (!instance) return;
  instance.completedRequests = usageMetric(instance.completedRequests) + 1;
  instance.lastActivityAt = now();
  instance.updatedAt = now();
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

export function copyProxyResponseHeaders(upstreamHeaders, res) {
  const hopByHop = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "content-length"
  ]);
  upstreamHeaders.forEach((value, key) => {
    if (hopByHop.has(String(key).toLowerCase())) return;
    res.setHeader(key, value);
  });
}

export function proxyRequestHeaders(req) {
  const hopByHop = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"
  ]);
  const headers = {};
  Object.entries(req.headers || {}).forEach(([key, value]) => {
    const name = String(key || "").toLowerCase();
    if (!name || hopByHop.has(name)) return;
    if (name === "authorization") return;
    if (value === undefined || value === null || value === "") return;
    headers[name] = value;
  });
  headers.accept = req.headers.accept || "application/json";
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  return headers;
}

// ---------------------------------------------------------------------------
// Proxy core
// ---------------------------------------------------------------------------

export async function proxyToInstance(instance, req, res, targetUrl) {
  const method = String(req.method || "GET").toUpperCase();
  const bodyAllowed = !["GET", "HEAD"].includes(method);
  const headers = proxyRequestHeaders(req);

  let body;
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  const isJsonRequest = contentType.includes("application/json");
  if (bodyAllowed) {
    body = isJsonRequest
      ? (req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : undefined)
      : req;
  }

  const abortController = new AbortController();
  req.on("aborted", () => { if (!res.writableEnded) abortController.abort(); });
  res.on("close", () => { if (!res.writableEnded) abortController.abort(); });

  // Headers-received timeout. We only abort if upstream hasn't even started
  // responding within this window — once a stream is flowing (chat completions
  // can legitimately take minutes), we let it run as long as the client is
  // still connected. Override per-deployment with PROXY_HEADERS_TIMEOUT_MS.
  const headersTimeoutMs = Number(process.env.PROXY_HEADERS_TIMEOUT_MS || 60_000);
  const headersTimer = setTimeout(() => {
    if (!res.headersSent) abortController.abort();
  }, headersTimeoutMs);

  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    updateInstanceRequestMetrics(instance, -1);
  };

  updateInstanceRequestMetrics(instance, 1);

  const isDiagnosticChat = method === "POST"
    && String(targetUrl || "").toLowerCase().includes("chat/completions");

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
      duplex: bodyAllowed && !isJsonRequest ? "half" : undefined,
      signal: abortController.signal
    });
    clearTimeout(headersTimer);

    res.status(upstream.status);
    copyProxyResponseHeaders(upstream.headers, res);

    const upstreamContentType = String(upstream.headers.get("content-type") || "").toLowerCase();
    const isJson = upstreamContentType.includes("application/json");
    const isSse = upstreamContentType.includes("text/event-stream");

    if (!upstream.body || (isJson && !isSse)) {
      const raw = await upstream.text();
      markProxyCompletion(instance);
      if (isJson && raw) {
        try { updateInstanceUsageMetrics(instance, JSON.parse(raw)); } catch { /* transparent */ }
      }
      if (isDiagnosticChat) {
        const preview = String(raw || "").replace(/\s+/g, " ").slice(0, 280);
        audit("proxy.chat.response", {
          instanceId: instance.id,
          status: upstream.status,
          contentType: upstreamContentType,
          responseBytes: String(raw || "").length,
          preview
        });
      }
      saveState(state);
      finalize();
      return res.send(raw);
    }

    if (isDiagnosticChat) {
      audit("proxy.chat.stream", {
        instanceId: instance.id,
        status: upstream.status,
        contentType: upstreamContentType
      });
    }

    const stream = Readable.fromWeb(upstream.body);
    stream.on("end", finalize);
    stream.on("error", () => { finalize(); if (!res.writableEnded) res.end(); });
    res.on("close", finalize);
    stream.pipe(res);
  } catch (error) {
    clearTimeout(headersTimer);
    finalize();
    if (abortController.signal.aborted) return;
    res.status(502).json({
      error: { message: String(error.message || error), type: "server_error", param: null, code: "upstream_error" }
    });
  }
}
