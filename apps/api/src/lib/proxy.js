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
// MiniMax XML tool call transformation
// ---------------------------------------------------------------------------
// MiniMax models output tool calls as <minimax:tool_call><invoke name="...">
// <parameter name="...">value</parameter></invoke></minimax:tool_call> XML.
// llama-server's peg-native chat format parser sometimes fails to convert this
// to OpenAI tool_calls format, causing clients to receive raw XML in content.
// On the next turn the client sends the XML back as history and llama-server
// rejects it ("Failed to parse input at pos N: <minimax:tool_call>").
// These helpers detect and convert the XML to OpenAI tool_calls format in the
// proxy layer so clients always see a clean OpenAI-compatible response.

/**
 * Parse <minimax:tool_call> XML blocks from an assistant content string.
 * Returns { textBefore, toolCalls } or null if no tool calls are present.
 */
function parseMinimaxXmlToolCalls(content) {
  if (!content || !content.includes("<minimax:tool_call>")) return null;
  const tagStart = content.indexOf("<minimax:tool_call>");
  const textBefore = content.slice(0, tagStart).trim() || null;
  const toolCalls = [];
  const invokeRe = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  let m;
  while ((m = invokeRe.exec(content)) !== null) {
    const fnName = m[1];
    const paramsBlock = m[2];
    const params = {};
    const paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let p;
    while ((p = paramRe.exec(paramsBlock)) !== null) {
      params[p[1]] = p[2];
    }
    toolCalls.push({
      id: `call_${Math.random().toString(36).slice(2, 11)}`,
      type: "function",
      function: { name: fnName, arguments: JSON.stringify(params) }
    });
  }
  return toolCalls.length > 0 ? { textBefore, toolCalls } : null;
}

// ---------------------------------------------------------------------------
// MiniMax-M3 tool call transformation
// ---------------------------------------------------------------------------
// MiniMax-M3 (llama.cpp PR #24523) emits tool calls in a different shape than
// the older <minimax:tool_call> models: the wrapper is <tool_call>, arguments
// are direct child tags (<filePath>val</filePath>) instead of
// <parameter name="...">, and — due to the PR's incomplete detokenizer — every
// XML fragment is wrapped in a "<]minimax[>[ ... ]" control-token marker, e.g.
//   <]minimax[>[<tool_call>]<]minimax[>[<invoke name="write">]<]minimax[>[<filePath>globe.svg]...
// llama-server's own chat parser then 500s with "Failed to parse input at pos
// N: <]minimax[>...". These helpers strip the control tokens, reconstruct the
// underlying XML, and parse it into OpenAI tool_calls.

const MINIMAX_M3_CONTROL = "<]minimax[>";

/**
 * Detect MiniMax-M3 style tool-call markup (<invoke name="..."> not wrapped in
 * the older <minimax:tool_call> tag).
 */
function hasMinimaxM3ToolCall(content) {
  return typeof content === "string"
    && content.includes("<invoke name=")
    && !content.includes("<minimax:tool_call>");
}

/**
 * Strip MiniMax-M3's "<]minimax[>[ fragment ]" control-token wrappers and
 * reconstruct the underlying tool-call XML. Fragments without the control
 * token (e.g. clean output from a fixed build) pass through unchanged.
 */
function cleanMinimaxM3ControlTokens(raw) {
  if (typeof raw !== "string" || !raw.includes(MINIMAX_M3_CONTROL)) return raw;
  return raw
    .split(MINIMAX_M3_CONTROL)
    .map((seg, i) => {
      if (i === 0) return seg; // preamble before the first control token
      let s = seg;
      if (s.startsWith("[")) s = s.slice(1);
      if (s.endsWith("]")) s = s.slice(0, -1);
      return s;
    })
    .join("");
}

/**
 * Parse MiniMax-M3 tool-call XML from an assistant content string.
 * Returns { textBefore, toolCalls } or null if no tool calls are present.
 */
function parseMinimaxM3ToolCalls(content) {
  if (!hasMinimaxM3ToolCall(content)) return null;
  const clean = cleanMinimaxM3ControlTokens(content);
  const tcStart = clean.indexOf("<tool_call>");
  const textBefore = (tcStart > 0 ? clean.slice(0, tcStart) : "").trim() || null;
  const toolCalls = [];
  const invokeRe = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  let m;
  while ((m = invokeRe.exec(clean)) !== null) {
    const fnName = m[1];
    const paramsBlock = m[2];
    const params = {};
    // Arguments are direct child tags: <name>value</name>. The backreference
    // keeps multi-line / XML-bearing values (e.g. SVG in <content>) intact.
    const paramRe = /<([A-Za-z_][\w.:-]*)>([\s\S]*?)<\/\1>/g;
    let p;
    while ((p = paramRe.exec(paramsBlock)) !== null) {
      params[p[1]] = p[2];
    }
    toolCalls.push({
      id: `call_${Math.random().toString(36).slice(2, 11)}`,
      type: "function",
      function: { name: fnName, arguments: JSON.stringify(params) }
    });
  }
  return toolCalls.length > 0 ? { textBefore, toolCalls } : null;
}

/**
 * Find the earliest index of any MiniMax tool-call marker (M2 or M3) in a
 * string, or -1 if none is present.
 */
function minimaxToolCallStart(text) {
  if (typeof text !== "string") return -1;
  const indices = [];
  const i2 = text.indexOf("<minimax:tool_call>");
  if (i2 >= 0) indices.push(i2);
  if (hasMinimaxM3ToolCall(text)) {
    for (const idx of [text.indexOf(MINIMAX_M3_CONTROL), text.indexOf("<tool_call>"), text.indexOf("<invoke name=")]) {
      if (idx >= 0) indices.push(idx);
    }
  }
  return indices.length ? Math.min(...indices) : -1;
}

/** True if the string contains MiniMax tool-call markup (M2 or M3). */
function hasMinimaxToolCall(text) {
  return typeof text === "string"
    && (text.includes("<minimax:tool_call>") || hasMinimaxM3ToolCall(text));
}

/** Parse either MiniMax M2 or M3 tool-call markup into { textBefore, toolCalls }. */
function parseAnyMinimaxToolCalls(content) {
  return parseMinimaxXmlToolCalls(content) || parseMinimaxM3ToolCalls(content);
}

/**
 * Transform a parsed non-streaming chat completion response object.
 * Converts any <minimax:tool_call> XML in choice content to tool_calls.
 */
function transformMinimaxNonStreaming(parsed) {
  if (!parsed || !Array.isArray(parsed.choices)) return parsed;
  let changed = false;
  const choices = parsed.choices.map((choice) => {
    const msg = choice?.message;
    if (!msg) return choice;
    // Check both content and reasoning_content for XML (M2 or M3 format).
    const contentHasXml = hasMinimaxToolCall(msg.content);
    const reasoningHasXml = hasMinimaxToolCall(msg.reasoning_content);
    if (!contentHasXml && !reasoningHasXml) return choice;
    const xmlSource = contentHasXml ? msg.content : msg.reasoning_content;
    const parsed2 = parseAnyMinimaxToolCalls(xmlSource);
    if (!parsed2) return choice;
    changed = true;
    const newMsg = { ...msg, tool_calls: parsed2.toolCalls };
    if (contentHasXml) {
      newMsg.content = parsed2.textBefore;
    } else {
      // XML was in reasoning_content — strip it, keep content as-is
      const xmlStart = minimaxToolCallStart(msg.reasoning_content);
      const cleanedReasoning = xmlStart > 0 ? msg.reasoning_content.slice(0, xmlStart).trim() : null;
      if (cleanedReasoning) newMsg.reasoning_content = cleanedReasoning;
      else delete newMsg.reasoning_content;
    }
    return { ...choice, message: newMsg, finish_reason: "tool_calls" };
  });
  return changed ? { ...parsed, choices } : parsed;
}

/**
 * Try to recover MiniMax tool-call XML embedded in a llama-server "Failed to
 * parse input at pos N: <minimax:tool_call>..." error.  When --jinja is in
 * use, llama-server's chat-template post-parser sometimes rejects the model's
 * own output (raw XML) and returns this error instead of completing the
 * response.  We extract the XML payload and synthesize a successful chat
 * completion containing the parsed tool_calls.
 *
 * Input: parsed JSON error body from upstream (object).
 * Output: synthesized chat-completion object on success, or null if the error
 *   does not match.
 */
function recoverFromMinimaxParseError(parsed, modelName) {
  const message = parsed?.error?.message || parsed?.message || "";
  if (typeof message !== "string") return null;
  const xmlStart = minimaxToolCallStart(message);
  if (xmlStart < 0) return null;
  const xmlPayload = message.slice(xmlStart);
  const parsed2 = parseAnyMinimaxToolCalls(xmlPayload);
  if (!parsed2 || parsed2.toolCalls.length === 0) return null;
  return {
    id: `chatcmpl-recover-${Math.random().toString(36).slice(2, 11)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName || "unknown",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: parsed2.textBefore || null,
        tool_calls: parsed2.toolCalls
      },
      finish_reason: "tool_calls",
      logprobs: null
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

/**
 * Build an SSE stream string for a synthesized chat completion (used when we
 * recover from a parse error in streaming mode).
 */
function synthesizeMinimaxSseFromCompletion(completion) {
  const base = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model };
  const choiceBase = { index: 0, logprobs: null };
  const events = [];
  const choice = completion.choices[0];
  const textBefore = choice?.message?.content;
  const toolCalls = choice?.message?.tool_calls || [];
  if (textBefore) {
    events.push({ ...base, choices: [{ ...choiceBase, delta: { role: "assistant", content: textBefore }, finish_reason: null }] });
  }
  toolCalls.forEach((tc, i) => {
    events.push({ ...base, choices: [{ ...choiceBase, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }, finish_reason: null }] });
    events.push({ ...base, choices: [{ ...choiceBase, delta: { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] }, finish_reason: null }] });
  });
  events.push({ ...base, choices: [{ ...choiceBase, delta: {}, finish_reason: "tool_calls" }] });
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

/**
 * Scan an SSE buffer for an error event that contains a MiniMax parse-error
 * message with embedded XML, and synthesize a proper completion stream from
 * it.  Returns the rewritten SSE text or null if no recovery is needed.
 */
function recoverMinimaxSseParseError(sseText, modelName) {
  if (!sseText.includes("Failed to parse input")) return null;
  if (!sseText.includes("<minimax:tool_call>") && !sseText.includes(MINIMAX_M3_CONTROL)) return null;
  // Walk every data: line to find the first event with an error.message containing the XML.
  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      const recovered = recoverFromMinimaxParseError(obj, modelName);
      if (recovered) return synthesizeMinimaxSseFromCompletion(recovered);
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Transform a buffered SSE response string.
 * Accumulates all content deltas, detects <minimax:tool_call>, then re-emits
 * synthetic SSE events in proper OpenAI tool_calls streaming format.
 * Returns the original text unchanged if no tool calls are detected.
 */
function transformMinimaxSseBuffer(sseText) {
  if (!sseText.includes("<minimax:tool_call>") && !sseText.includes(MINIMAX_M3_CONTROL)) return sseText;

  // Reconstruct the full content and a representative chunk skeleton.
  let skeleton = null;
  let accContent = "";
  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      if (!skeleton) skeleton = chunk;
      const delta = chunk?.choices?.[0]?.delta;
      // Accumulate both content and reasoning_content — MiniMax M2.7 (reasoning model)
      // may emit tool call XML inside reasoning_content rather than content.
      if (typeof delta?.content === "string") accContent += delta.content;
      if (typeof delta?.reasoning_content === "string") accContent += delta.reasoning_content;
    } catch { /* skip malformed */ }
  }

  const parsed2 = parseAnyMinimaxToolCalls(accContent);
  if (!parsed2 || !skeleton) return sseText;

  const { textBefore, toolCalls } = parsed2;
  const base = { id: skeleton.id, object: skeleton.object, created: skeleton.created, model: skeleton.model };
  const choiceBase = { index: 0, logprobs: null };
  const events = [];

  // Emit text-before as a content delta (if any)
  if (textBefore) {
    events.push({ ...base, choices: [{ ...choiceBase, delta: { role: "assistant", content: textBefore }, finish_reason: null }] });
  }

  // Emit each tool call header then its arguments
  toolCalls.forEach((tc, i) => {
    events.push({ ...base, choices: [{ ...choiceBase, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }, finish_reason: null }] });
    events.push({ ...base, choices: [{ ...choiceBase, delta: { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] }, finish_reason: null }] });
  });

  // Finish event
  events.push({ ...base, choices: [{ ...choiceBase, delta: {}, finish_reason: "tool_calls" }] });

  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

/**
 * Extract text from a message content field that may be a string or an array of
 * OpenAI content parts (e.g. [{type:"text",text:"..."}]).
 * Returns a plain string (joining all text parts) or null.
 */
function flattenContent(content) {
  if (!content) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === "text" ? String(part.text ?? "") : ""))
      .join("");
  }
  return null;
}

/**
 * Sanitize incoming request messages for MiniMax.
 * If any assistant message has raw <minimax:tool_call> XML in its content
 * (string or array-of-parts), convert it to a proper OpenAI tool_calls array
 * so llama-server's peg-native parser does not choke when building the prompt.
 * Returns a new messages array if any changes were made, or the original if not.
 */
// Strip ALL <minimax:tool_call>...</minimax:tool_call> blocks (and any
// trailing unterminated block) from a string. Returns the cleaned text (or
// null if nothing remains after trimming).
function stripMinimaxXml(text) {
  if (typeof text !== "string") return text;
  const hasM2 = text.includes("<minimax:tool_call>");
  const hasM3 = hasMinimaxM3ToolCall(text);
  if (!hasM2 && !hasM3) return text;
  let cleaned = text;
  if (hasM3) {
    // Reconstruct from control tokens, then drop the <tool_call> block(s).
    cleaned = cleanMinimaxM3ControlTokens(cleaned)
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "");
    const orphanM3 = cleaned.indexOf("<tool_call>");
    if (orphanM3 >= 0) cleaned = cleaned.slice(0, orphanM3);
  }
  if (cleaned.includes("<minimax:tool_call>")) {
    cleaned = cleaned.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, "");
    // Drop any trailing unterminated XML block (model output cut off mid-call).
    const orphan = cleaned.indexOf("<minimax:tool_call>");
    if (orphan >= 0) cleaned = cleaned.slice(0, orphan);
  }
  cleaned = cleaned.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function sanitizeMessagesForMinimax(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const sanitized = messages.map((msg) => {
    if (!msg) return msg;
    const flatContent = flattenContent(msg?.content);
    const flatReasoning = typeof msg?.reasoning_content === "string" ? msg.reasoning_content : null;
    const contentHasXml = hasMinimaxToolCall(flatContent);
    const reasoningHasXml = hasMinimaxToolCall(flatReasoning);
    if (!contentHasXml && !reasoningHasXml) return msg;

    changed = true;
    const out = { ...msg };

    // For assistant role: if there are no existing tool_calls, try to parse
    // the XML into tool_calls. If parsing fails or tool_calls are already set,
    // we still strip the XML so llama-server's chat parser doesn't choke.
    if (msg.role === "assistant" && !Array.isArray(msg.tool_calls)) {
      const xmlSource = contentHasXml ? flatContent : flatReasoning;
      const parsed2 = parseAnyMinimaxToolCalls(xmlSource);
      if (parsed2) out.tool_calls = parsed2.toolCalls;
    }

    if (contentHasXml) {
      const cleaned = stripMinimaxXml(flatContent);
      if (cleaned) out.content = cleaned; else delete out.content;
    }
    if (reasoningHasXml) {
      const cleanedReasoning = stripMinimaxXml(flatReasoning);
      if (cleanedReasoning) out.reasoning_content = cleanedReasoning; else delete out.reasoning_content;
    }
    return out;
  });
  return changed ? sanitized : messages;
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
    if (isJsonRequest && req.body && Object.keys(req.body).length > 0) {
      // Sanitize any <minimax:tool_call> XML that may be in assistant message content
      // from a prior exchange. peg-native chokes on raw XML in incoming message history.
      const sanitizedMessages = sanitizeMessagesForMinimax(req.body.messages);
      const reqBody = sanitizedMessages !== req.body.messages
        ? { ...req.body, messages: sanitizedMessages }
        : req.body;
      body = JSON.stringify(reqBody);
      // Final defensive sweep: scrub any remaining <minimax:tool_call> XML
      // anywhere in the serialised body (e.g. embedded in tools[] descriptions,
      // tool_calls[].function.arguments, system prompts, tool role messages).
      // We must encode the replacement as a JSON string fragment because we're
      // operating on the serialised JSON body directly.
      if (body.includes("<minimax:tool_call>")) {
        // Strip well-formed blocks, including their JSON-escaped newlines.
        body = body.replace(/<minimax:tool_call>[\s\S]*?<\\?\/minimax:tool_call>/g, "");
        // Strip any remaining unterminated occurrences.
        body = body.replace(/<minimax:tool_call>/g, "");
      }
      // MiniMax-M3: scrub control tokens and any reconstructed <tool_call>
      // blocks that survived message sanitisation. Gated on the M3 control
      // token so other models' <tool_call> JSON is never touched.
      if (body.includes(MINIMAX_M3_CONTROL)) {
        body = body.split(MINIMAX_M3_CONTROL).join("");
        body = body.replace(/<tool_call>[\s\S]*?<\\?\/tool_call>/g, "");
      }
    } else {
      body = isJsonRequest ? undefined : req;
    }
  }

  const abortController = new AbortController();
  req.on("aborted", () => { if (!res.writableEnded) abortController.abort(); });
  res.on("close", () => { if (!res.writableEnded) abortController.abort(); });

  // Headers-received timeout. We only abort if upstream hasn't even started
  // responding within this window — once a stream is flowing (chat completions
  // can legitimately take minutes), we let it run as long as the client is
  // still connected. Override per-instance with headersTimeoutMs, or globally
  // with PROXY_HEADERS_TIMEOUT_MS env var.
  const headersTimeoutMs = Number(instance.headersTimeoutMs || process.env.PROXY_HEADERS_TIMEOUT_MS || 60_000);
  let headersTimedOut = false;
  const headersTimer = setTimeout(() => {
    if (!res.headersSent) {
      headersTimedOut = true;
      console.warn(`[proxy] headers timeout (${headersTimeoutMs}ms) instanceId=${instance.id} url=${targetUrl}`);
      abortController.abort();
    }
  }, headersTimeoutMs);

  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    // GET /v1/instances replaces state.instances entries with new objects on every
    // poll (via .map+spread), so `instance` may be a stale reference by the time
    // finalize() runs. Look up the live object by ID to ensure the decrement lands.
    const liveInstance = state.instances.find((x) => x.id === instance.id) || instance;
    updateInstanceRequestMetrics(liveInstance, -1);
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
      let responseSent = raw;
      if (isJson && raw) {
        try {
          const parsed = JSON.parse(raw);
          updateInstanceUsageMetrics(instance, parsed);
          if (!upstream.ok && isDiagnosticChat) {
            // Recovery: llama-server's --jinja chat-template post-parser
            // sometimes rejects the model's own MiniMax XML output. Extract
            // the XML from the error message and synthesize a proper
            // tool_calls completion so the client can act on it.
            const recovered = recoverFromMinimaxParseError(parsed, req.body?.model);
            if (recovered) {
              res.status(200);
              responseSent = JSON.stringify(recovered);
            }
          } else {
            // Convert <minimax:tool_call> XML to OpenAI tool_calls format if present.
            const transformed = isDiagnosticChat ? transformMinimaxNonStreaming(parsed) : parsed;
            if (transformed !== parsed) responseSent = JSON.stringify(transformed);
          }
        } catch { /* transparent */ }
      }
      if (isDiagnosticChat) {
        const preview = String(responseSent || "").replace(/\s+/g, " ").slice(0, 280);
        audit("proxy.chat.response", {
          instanceId: instance.id,
          status: upstream.status,
          contentType: upstreamContentType,
          responseBytes: String(responseSent || "").length,
          preview
        });
      }
      saveState(state);
      finalize();
      return res.send(responseSent);
    }

    if (isDiagnosticChat) {
      audit("proxy.chat.stream", {
        instanceId: instance.id,
        status: upstream.status,
        contentType: upstreamContentType
      });
    }

    const stream = Readable.fromWeb(upstream.body);

    // First-token timeout: if no bytes arrive from upstream within this window
    // after the stream opens, the model is likely stuck (KV cache exhaustion,
    // Qwen3 think-loop deadlock, etc.). We abort and send an SSE error event so
    // the client gets a clean error instead of a hung connection.
    const firstTokenMs = Number(process.env.PROXY_FIRST_TOKEN_TIMEOUT_MS || 90_000);
    let firstTokenReceived = false;
    const firstTokenTimer = setTimeout(() => {
      if (firstTokenReceived || res.writableEnded) return;
      console.warn(`[proxy] first-token timeout (${firstTokenMs}ms) instanceId=${instance.id} url=${targetUrl}`);
      stream.destroy();
      try {
        const errPayload = JSON.stringify({
          error: {
            message: `Upstream generation timeout: no tokens produced within ${firstTokenMs}ms`,
            type: "server_error",
            code: "generation_timeout"
          }
        });
        res.write(`data: ${errPayload}\n\ndata: [DONE]\n\n`);
      } catch { /* headers may already be flushed */ }
      res.end();
      finalize();
    }, firstTokenMs);

    // Buffer the entire SSE response for chat/completions so we can detect and
    // transform <minimax:tool_call> XML before it reaches the client.
    // We always buffer on chat endpoints (not just when tools are declared in
    // the current request) because MiniMax can emit XML whenever it was trained
    // to use tools, regardless of whether the client re-declared them.
    if (isDiagnosticChat) {
      const chunks = [];
      stream.on("data", (chunk) => {
        if (!firstTokenReceived) {
          firstTokenReceived = true;
          clearTimeout(firstTokenTimer);
        }
        chunks.push(chunk);
      });
      stream.on("end", () => {
        clearTimeout(firstTokenTimer);
        markProxyCompletion(instance);
        const sseText = Buffer.concat(chunks).toString("utf8");
        // First check if the stream contains a llama-server parse error with
        // recoverable XML payload; if so, replace the entire stream with a
        // synthesized success completion.
        const recovered = recoverMinimaxSseParseError(sseText, req.body?.model);
        const transformed = recovered ?? transformMinimaxSseBuffer(sseText);
        if (!res.writableEnded) {
          res.write(transformed);
          res.end();
        }
        finalize();
      });
      stream.on("error", () => { clearTimeout(firstTokenTimer); finalize(); if (!res.writableEnded) res.end(); });
      res.on("close", () => { clearTimeout(firstTokenTimer); finalize(); });
    } else {
      stream.on("data", () => {
        if (!firstTokenReceived) {
          firstTokenReceived = true;
          clearTimeout(firstTokenTimer);
        }
      });
      stream.on("end", () => { clearTimeout(firstTokenTimer); finalize(); });
      stream.on("error", () => { clearTimeout(firstTokenTimer); finalize(); if (!res.writableEnded) res.end(); });
      res.on("close", () => { clearTimeout(firstTokenTimer); finalize(); });
      stream.pipe(res);
    }
  } catch (error) {
    clearTimeout(headersTimer);
    finalize();
    if (abortController.signal.aborted) {
      if (!res.writableEnded && !res.destroyed && !res.headersSent) {
        const msg = headersTimedOut
          ? `Upstream did not respond within ${headersTimeoutMs}ms`
          : "Upstream request aborted";
        res.status(504).json({
          error: { message: msg, type: "server_error", param: null, code: "gateway_timeout" }
        });
      } else if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
      return;
    }
    res.status(502).json({
      error: { message: String(error.message || error), type: "server_error", param: null, code: "upstream_error" }
    });
  }
}
