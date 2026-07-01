import { Readable } from "stream";
import { state, saveState } from "./state.js";
import { audit } from "./audit.js";
import { now } from "./utils.js";
import { compressMessages, mergeCompressionConfig } from "./compress.js";

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
  if (delta > 0) {
    instance.lastActivityAt = now();
    instance.currentRequestTokens = 0;
    instance.currentRequestStartedAt = Date.now();
  }
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
      // Apply recursive XML→JSON conversion in case the value is structured
      params[p[1]] = xmlToJsonValue(p[2]);
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
  if (typeof content !== "string") return false;
  // Check both raw bracket syntax and XML-converted syntax (from error recovery)
  return (content.includes("[invoke name=") || content.includes("<invoke name="))
    && !content.includes("[minimax:tool_call]");
}

// XML tag strings that M3 uses for tool calls.  When code files that describe
// this format (e.g. proxy.js itself) land in context during codebase exploration,
// M3 can confuse the descriptions for real invocation templates and emit a
// garbled tool call.  We escape these patterns in non-assistant messages so
// M3 treats them as inert text rather than XML triggers.
const MINIMAX_XML_LITERAL_MAP = [
  // M3 control token — must be first so it's escaped before the XML patterns below.
  // When proxy.js source lands in context, the literal "<]minimax[>" string would
  // otherwise be tokenized as an M3 special token and cause peg-native to fail
  // with "Failed to parse input at pos 7".
  ["<]minimax[>",          "[minimax_ctrl]"],
  ["<minimax:tool_call>",  "[minimax:tool_call]"],
  ["</minimax:tool_call>", "[/minimax:tool_call]"],
  ["<tool_call>",          "[tool_call]"],
  ["</tool_call>",         "[/tool_call]"],
  ["<invoke name=",        "[invoke name="],
  ["</invoke>",            "[/invoke]"],
  ["<parameter name=",     "[parameter name="],
  ["</parameter>",         "[/parameter]"],
];

function escapeMinimaxXmlLiterals(text) {
  if (typeof text !== "string") return text;
  let s = text;
  for (const [from, to] of MINIMAX_XML_LITERAL_MAP) {
    if (s.includes(from)) s = s.split(from).join(to);
  }
  return s;
}

/**
 * Convert M3 bracket syntax to XML angle brackets.
 * [tag] → <tag>    [/tag] → </tag>    [tag attr] → <tag attr>
 * <xml> stays unchanged.  [tool_call] stays as [tool_call].
 */
function convertM3ToXml(s) {
  if (typeof s !== "string") return s;
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "[") {
      if (s.slice(i, i + 11) === "[tool_call]") {
        out.push("[tool_call]");
        i += 11;
        continue;
      }
      let end = s.indexOf("]", i + 1);
      if (end === -1) end = s.length;
      const tagContent = s.slice(i + 1, end);
      i = end + (s[end] === ">" ? 1 : 0) + 1;
      const isClosing = tagContent.startsWith("/");
      out.push("<" + tagContent + ">");
      continue;
    }
    out.push(s[i]);
    i++;
  }
  return out.join("");
}

/**
 * Strip MiniMax-M3's "[ fragment ]" control-token wrappers and
 * reconstruct the underlying tool-call XML. Fragments without the control
 * token (e.g. clean output from a fixed build) pass through unchanged.
 * Uses regex extraction to handle all M3 variants including llama-server
 * error messages with escaped quotes and preamble text.
 */
function cleanMinimaxM3ControlTokens(raw) {
  if (typeof raw !== "string") return raw;
  if (MINIMAX_M3_CONTROL === "") {
    // llama.cpp wraps each M3 fragment in "[ ... ]" brackets, separated by "][".
    // We find the first "[tool_call" in the raw text, then extract only the
    // M3 content from that point onward, converting wrapper brackets to XML.
    const tcIdx = raw.indexOf("[tool_call");
    if (tcIdx < 0) return raw;
    const m3Only = raw.slice(tcIdx);
    // Split on "][" to get segments
    const segments = m3Only.split("][");
    const out = [];
    for (const seg of segments) {
      // Check for [tool_call] marker BEFORE stripping wrapper brackets
      if (seg.startsWith("[[tool_call") || seg.startsWith("[tool_call")) {
        // llama.cpp wraps [tool_call] in "[ ... ]" so after splitting on
        // "][" the first segment is "[[tool_call]\n]" — output the marker
        // cleanly and skip the normal bracket-stripping logic
        out.push("[tool_call]");
        continue;
      }
      // Handle different wrapper patterns from llama.cpp's detokenizer:
      //   [[...]] — control token wrapper (e.g. [[tool_call]\n])
      //   [...]> — M3 opening tag with > closer
      //   [...] — M3 closing tag with ] closer
      //   [</tag>] — clean XML inside wrapper
      //   [tag attr]> — M3 opening tag
      //   No brackets — clean XML passes through
      if (seg.startsWith("[[")) {
        // Double-bracket wrapper: strip first [ and trailing ] if present
        let inner = seg.slice(1);
        if (inner.endsWith("]")) inner = inner.slice(0, -1);
        out.push(convertM3Syntax(inner));
      } else if (seg.startsWith("[</")) {
        // Clean XML closing tag inside single wrapper: [</tag>]
        out.push(seg.slice(1, -1));
      } else if (seg.startsWith("[<")) {
        // Clean XML opening tag inside single wrapper: [<tag>val]
        out.push(seg.slice(1, -1));
      } else if (seg.includes("[")) {
        // M3 bracket syntax: convert to XML
        out.push(convertM3Syntax(seg));
      } else {
        out.push(seg.replace(/\s+$/, ""));
      }
    }
    return out.join("");
  }
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
 * Convert M3 bracket syntax in a segment to XML angle brackets.
 * [tag] → <tag>    [/tag] → </tag>    [tag attr]> → <tag attr>
 * [tool_call] → [tool_call]    <xml> stays unchanged.
 * Handles M3's two closer styles: ] for closing tags and > for opening tags.
 */
function convertM3Syntax(segment) {
  const out = [];
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === "[") {
      if (segment.slice(i, i + 11) === "[tool_call]") {
        out.push("[tool_call]");
        i += 11;
        continue;
      }
      // Find the closing delimiter: prefer ] over > (M3 closing tags like [/tag]
      // have ] while opening tags like [tag attr]> use > as the closer).
      let bracketEnd = segment.indexOf("]", i + 1);
      let gtEnd = segment.indexOf(">", i + 1);
      if (bracketEnd >= 0 && (gtEnd === -1 || bracketEnd <= gtEnd)) {
        // ] comes first or no > found — M3 closing tag [/tag]
        const tagContent = segment.slice(i + 1, bracketEnd);
        out.push("<" + tagContent + ">");
        i = bracketEnd + 1;
      } else if (gtEnd >= 0) {
        // > comes first — M3 opening tag [tag attr]>
        const tagContent = segment.slice(i + 1, gtEnd);
        out.push("<" + tagContent + ">");
        i = gtEnd + 1;
      } else {
        // No ] or > found — consume to end
        out.push("<" + segment.slice(i + 1) + ">");
        i = segment.length;
      }
      continue;
    }
    out.push(segment[i]);
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// XML → JSON recursive converter (for nested M3 tool-call argument values)
// ---------------------------------------------------------------------------
// M3 outputs complex arguments as nested XML, e.g.:
//   <questions><item><question>…</question><options><item>…</item></options></item></questions>
// The flat regex approach extracts the raw XML string as the arg value, but
// clients expect proper JSON arrays/objects. This converter handles:
//   - pure text               → string
//   - all-<item> children     → JSON array  (each child recursed)
//   - mixed named children    → JSON object (same-name siblings → array)
//   - self-closing tags       → null

/**
 * Extract the top-level XML child elements from a string, depth-tracking
 * same-name opening/closing tags so nested identical tags are handled
 * correctly (e.g. <item> inside <item>).
 * Returns [{tag, content}, …] or null if no element children are found.
 */
function extractXmlChildren(xml) {
  const text = (xml || "").trim();
  const children = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf("<", pos);
    if (start === -1) break;
    const gt = text.indexOf(">", start + 1);
    if (gt === -1) break;
    const inner = text.slice(start + 1, gt);
    // Skip closing / comment / PI tags
    if (inner.startsWith("/") || inner.startsWith("!") || inner.startsWith("?")) {
      pos = gt + 1; continue;
    }
    // Self-closing
    if (inner.endsWith("/")) {
      children.push({ tag: inner.slice(0, -1).trim().split(/[\s>]/)[0], content: "" });
      pos = gt + 1; continue;
    }
    const tagName = inner.trim().split(/[\s>]/)[0];
    if (!tagName) { pos = gt + 1; continue; }
    const openTag  = `<${tagName}`;
    const closeTag = `</${tagName}>`;
    let depth = 1;
    let scan = gt + 1;
    let closePos = -1;
    while (depth > 0 && scan < text.length) {
      const co = text.indexOf(closeTag, scan);
      const op = text.indexOf(openTag,  scan);
      if (co === -1) { scan = text.length; break; }
      if (op !== -1 && op < co) {
        // Make sure it's really the same tag (next char is > or whitespace or /)
        const nextCh = text[op + openTag.length];
        if (nextCh === ">" || nextCh === " " || nextCh === "\t" || nextCh === "\n" || nextCh === "/") {
          depth++;
          scan = op + openTag.length;
          continue;
        }
      }
      depth--;
      if (depth === 0) { closePos = co; break; }
      scan = co + closeTag.length;
    }
    if (closePos === -1) {
      // Unclosed tag — treat rest as content
      children.push({ tag: tagName, content: text.slice(gt + 1).trim() });
      break;
    }
    children.push({ tag: tagName, content: text.slice(gt + 1, closePos).trim() });
    pos = closePos + closeTag.length;
  }
  return children.length > 0 ? children : null;
}

/**
 * Recursively convert an XML string (M3 tool argument value) to a JS value.
 * Returns a string, array, or plain object — ready for JSON.stringify.
 */
function xmlToJsonValue(xml) {
  const text = (xml || "").trim();
  if (!text) return "";
  const children = extractXmlChildren(text);
  if (!children) {
    // Coerce primitive literals so schema validation passes.
    if (text === "true")  return true;
    if (text === "false") return false;
    if (text === "null")  return null;
    if (text !== "" && !Number.isNaN(Number(text))) return Number(text);
    return text;
  }
  // All <item> siblings → array
  if (children.every(c => c.tag === "item")) {
    return children.map(c => xmlToJsonValue(c.content));
  }
  // Single non-item child: M3 may have emitted unescaped HTML/code inside a
  // string-typed parameter (e.g. <content><script>…</script></content>).
  // Treat the whole thing as a string by stripping all tags.
  if (children.length === 1) {
    return text.replace(/<[^>]*>/g, "").trim();
  }
  // 2+ distinct named siblings → object (duplicate names become arrays)
  const obj = {};
  for (const { tag, content } of children) {
    const val = xmlToJsonValue(content);
    if (Object.prototype.hasOwnProperty.call(obj, tag)) {
      if (!Array.isArray(obj[tag])) obj[tag] = [obj[tag]];
      obj[tag].push(val);
    } else {
      obj[tag] = val;
    }
  }
  return obj;
}

/**
 * Parse MiniMax-M3 tool-call XML from an assistant content string.
 * Returns { textBefore, toolCalls } or null if no tool calls are present.
 */
function parseMinimaxM3ToolCalls(content) {
  // Normalize escaped quotes first — after JSON.parse, M3 XML attributes
  // in error messages contain literal \" which must be unescaped before
  // any pattern matching or bracket conversion.  Must handle \\\\ before \"
  // so \\\\\" → \\" → " (not \\" → \" which would be wrong).
  const unescaped = content.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
  if (!hasMinimaxM3ToolCall(unescaped)) return null;
  const clean = cleanMinimaxM3ControlTokens(unescaped);
  const tcStart = clean.indexOf("<tool_call>");
  const textBefore = (tcStart > 0 ? clean.slice(0, tcStart) : "").trim() || null;
  const toolCalls = [];
  const invokeRe = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  let m;
  while ((m = invokeRe.exec(clean)) !== null) {
    const fnName = m[1];
    const paramsBlock = m[2];
    const params = {};
    // Extract top-level argument tags. We use extractXmlChildren (depth-aware)
    // rather than a flat regex so nested structures like <questions><item>…</item>
    // </questions> are correctly attributed to the right argument name.
    const topLevel = extractXmlChildren(paramsBlock);
    if (topLevel) {
      for (const { tag, content } of topLevel) {
        // Recursively convert nested XML (arrays, objects) to JSON values.
        params[tag] = xmlToJsonValue(content);
      }
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
    for (const idx of [
      MINIMAX_M3_CONTROL ? text.indexOf(MINIMAX_M3_CONTROL) : -1,
      text.indexOf("[[tool_call"),
      text.indexOf("[tool_call]"),
      text.indexOf("[invoke name=")
    ]) {
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
    // Strip bare </mm:think> that M3 emits on non-thinking turns (no opening tag).
    // It appears in content between tool results and should be invisible to clients.
    let cleanedMsg = msg;
    if (typeof msg.content === "string" && msg.content.includes("</mm:think>")) {
      const stripped = msg.content
        .replace(/<mm:think>[\s\S]*?<\/mm:think>/g, "")  // full think blocks
        .replace(/<\/mm:think>/g, "")                     // orphaned close tags
        .trim();
      if (stripped !== msg.content) {
        changed = true;
        cleanedMsg = { ...msg, content: stripped || null };
      }
    }
    // Check both content and reasoning_content for XML (M2 or M3 format).
    const contentHasXml = hasMinimaxToolCall(cleanedMsg.content);
    const reasoningHasXml = hasMinimaxToolCall(cleanedMsg.reasoning_content);
    if (!contentHasXml && !reasoningHasXml) return changed ? { ...choice, message: cleanedMsg } : choice;
    const xmlSource = contentHasXml ? cleanedMsg.content : cleanedMsg.reasoning_content;
    const parsed2 = parseAnyMinimaxToolCalls(xmlSource);
    if (!parsed2) return changed ? { ...choice, message: cleanedMsg } : choice;
    changed = true;
    const newMsg = { ...cleanedMsg, tool_calls: parsed2.toolCalls };
    if (contentHasXml) {
      newMsg.content = parsed2.textBefore;
    } else {
      // XML was in reasoning_content — strip it, keep content as-is
      const xmlStart = minimaxToolCallStart(cleanedMsg.reasoning_content);
      const cleanedReasoning = xmlStart > 0 ? cleanedMsg.reasoning_content.slice(0, xmlStart).trim() : null;
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
  // llama-server may return the error as a bare JSON string (not an object).
  // Extract the message text from whichever structure it comes in.
  let message = "";
  if (typeof parsed === "string") {
    message = parsed;
  } else if (parsed?.error) {
    // llama-server may return error as a string: {"error":"Failed..."}
    // or as an object: {"error":{"message":"Failed..."}}
    message = typeof parsed.error === "string" ? parsed.error : (parsed.error.message || parsed.error || "");
  } else {
    message = parsed?.message || "";
  }
  if (typeof message !== "string") return null;
  // Normalize escaped quotes that appear after JSON.parse of the error
  // response.  llama-server embeds M3 XML inside the error message; the
  // quotes around attribute values become literal \" (backslash-quote) after
  // JSON.parse.  Replace \" with " so the XML regex can match attribute
  // values.  Also collapse double-backslashes from the original request.
  message = message.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
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
  if (!sseText.includes("[minimax:tool_call]") && !sseText.includes(MINIMAX_M3_CONTROL) && !sseText.includes("[tool_call]")) return null;
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
    } catch { /* fall through to raw-text extraction */ }
    // Fallback: extract error message directly from raw SSE data text
    // (llama-server sometimes sends raw text errors with unescaped quotes
    // that break JSON parsing).  Look for the "Failed to parse input..."
    // pattern and extract the embedded M3 XML.
    if (trimmed.includes("Failed to parse input")) {
      const xmlStart = minimaxToolCallStart(trimmed);
      if (xmlStart >= 0) {
        const xmlPayload = trimmed.slice(xmlStart);
        const parsed2 = parseAnyMinimaxToolCalls(xmlPayload);
        if (parsed2 && parsed2.toolCalls.length > 0) {
          return synthesizeMinimaxSseFromCompletion({
            id: `chatcmpl-recover-${Math.random().toString(36).slice(2, 11)}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: modelName || "unknown",
            choices: [{
              index: 0,
              message: { role: "assistant", content: parsed2.textBefore || null, tool_calls: parsed2.toolCalls },
              finish_reason: "tool_calls",
              logprobs: null
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          });
        }
      }
    }
  }
  return null;
}

/**
 * Strip stray MiniMax-M3 control-token wrapper artifacts ("<]minimax[>[ ... ]")
 * from a plain (already-extracted) delta text fragment before it is streamed
 * to the client as reasoning_content. M3's detokenizer can wrap ordinary
 * thinking-phase text in this marker too, not just tool-call XML — Phase 2
 * checks every content chunk for it (and buffers/converts on detection), but
 * Phase 1 (reasoning) never did, so it leaked straight into visible
 * reasoning_content as literal punctuation (e.g. trailing "]]"). Thinking
 * text never legitimately contains a real <invoke>, so it's always safe to
 * just strip the wrapper here rather than buffer it. No-op for clean text.
 */
function stripStrayM3Wrapper(text) {
  if (typeof text !== "string" || !text.includes(MINIMAX_M3_CONTROL)) return text;
  return cleanMinimaxM3ControlTokens(text);
}

/**
 * Detect and recover llama-server's own "Failed to parse input at pos N"
 * error when it arrives as a standalone SSE event mid-stream (in place of the
 * expected finish_reason:"tool_calls" event). This happens when llama-server's
 * --jinja post-parser fails to convert M3's completed tool-call XML into a
 * structured finish event. Such an event has no choices[].delta.content, so
 * without this check it would be written straight through to the client as
 * raw (and useless/broken) SSE data. Returns true if handled (caller should
 * stop processing this event and end the response), false otherwise.
 */
function tryRecoverStreamedM3Error(res, eventText, modelName) {
  if (!eventText.includes("Failed to parse input")) return false;
  const dataLine = eventText.split("\n").find(l => l.trimStart().startsWith("data:"));
  const payload = dataLine ? dataLine.trimStart().slice(5).trim() : eventText;
  let candidate = payload;
  try {
    const parsed = JSON.parse(payload);
    candidate = parsed?.error?.message
      ?? (typeof parsed?.error === "string" ? parsed.error : null)
      ?? (typeof parsed === "string" ? parsed : payload);
  } catch { /* not valid JSON — use the raw payload text directly */ }
  if (typeof candidate !== "string" || !candidate.includes("Failed to parse input")) return false;
  const recovered = recoverFromMinimaxParseError({ error: { message: candidate } }, modelName);
  if (!recovered) return false;
  if (!res.writableEnded) {
    res.write(synthesizeMinimaxSseFromCompletion(recovered));
    res.end();
  }
  return true;
}

/**
 * Transform a buffered SSE response string.
 * Accumulates all content deltas, detects <minimax:tool_call>, then re-emits
 * synthetic SSE events in proper OpenAI tool_calls streaming format.
 * Returns the original text unchanged if no tool calls are detected.
 */
function transformMinimaxSseBuffer(sseText) {
  const hasToolCallMarkup = sseText.includes("<minimax:tool_call>")
    || sseText.includes(MINIMAX_M3_CONTROL)
    || sseText.includes("<invoke name=");  // M3 clean output (no control tokens)
  const hasOrphanThink   = sseText.includes("</mm:think>");
  if (!hasToolCallMarkup && !hasOrphanThink) return sseText;

  // Strip orphaned </mm:think> (M3 emits it on non-thinking turns between tool results).
  // Rewrite every SSE chunk whose content delta contains it.
  let working = sseText;
  if (hasOrphanThink) {
    const lines = working.split("\n");
    const rewritten = lines.map(line => {
      if (!line.trim().startsWith("data:")) return line;
      const payload = line.trim().slice(5).trim();
      if (!payload || payload === "[DONE]") return line;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk?.choices?.[0]?.delta;
        if (typeof delta?.content !== "string" || !delta.content.includes("</mm:think>")) return line;
        const cleaned = delta.content
          .replace(/<mm:think>[\s\S]*?<\/mm:think>/g, "")
          .replace(/<\/mm:think>/g, "")
          .trim();
        const newChunk = {
          ...chunk,
          choices: chunk.choices.map((c, i) =>
            i === 0 ? { ...c, delta: { ...delta, content: cleaned } } : c
          )
        };
        return `data: ${JSON.stringify(newChunk)}`;
      } catch { return line; }
    });
    working = rewritten.join("\n");
  }

  if (!hasToolCallMarkup) return working;

  // Reconstruct the full content and a representative chunk skeleton.
  let skeleton = null;
  let accContent = "";
  for (const line of working.split("\n")) {
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
  if (!parsed2 || !skeleton) return working;

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

/**
 * Scan an assistant message's existing tool_calls array for MiniMax M3
 * control-token / raw XML contamination inside function.arguments strings.
 * This can happen when llama-server's own peg-native parser partially or
 * incorrectly converts M3's control-token output, leaving raw
 * "<]minimax[>[<invoke ...>]" fragments embedded in an argument value
 * instead of clean JSON. Replaying that message back as history causes
 * "Failed to parse input at pos N" on a later request, because the chat
 * template re-embeds the raw fragment into the rendered prompt text and
 * llama-server's own parser then chokes on it.
 * Returns { toolCalls, changed }.
 */
function sanitizeToolCallArguments(toolCalls) {
  let changed = false;
  const cleaned = toolCalls.map((tc) => {
    const argsRaw = tc?.function?.arguments;
    if (typeof argsRaw !== "string") return tc;
    const isContaminated = MINIMAX_XML_LITERAL_MAP.some(([from]) => argsRaw.includes(from))
      || argsRaw.includes("<invoke name=") || argsRaw.includes("<minimax:tool_call>");
    if (!isContaminated) return tc;
    changed = true;
    let newArgs;
    try {
      const parsedArgs = JSON.parse(argsRaw);
      const walk = (v) => {
        if (typeof v === "string") return escapeMinimaxXmlLiterals(v);
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") {
          const o = {};
          for (const [k, val] of Object.entries(v)) o[k] = walk(val);
          return o;
        }
        return v;
      };
      newArgs = JSON.stringify(walk(parsedArgs));
    } catch {
      // arguments isn't valid JSON — it's raw contaminated text from a
      // botched upstream conversion. Neutralize the trigger tokens so
      // llama-server's parser doesn't choke on replay; the client will
      // still see malformed JSON here (the damage was already done
      // upstream), but the conversation can continue instead of hard
      // failing with a 500 on every subsequent turn.
      newArgs = escapeMinimaxXmlLiterals(argsRaw);
    }
    return { ...tc, function: { ...tc.function, arguments: newArgs } };
  });
  return { toolCalls: cleaned, changed };
}

function sanitizeMessagesForMinimax(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const sanitized = messages.map((msg) => {
    if (!msg) return msg;

    // ── non-assistant: escape M3 XML literal strings (prompt-injection guard) ──
    // Prevents code files describing the M3 tool-call format from being
    // mistaken for actual tool-call invocations by the model.
    if (msg.role !== "assistant") {
      const raw = typeof msg.content === "string" ? msg.content
        : Array.isArray(msg.content) ? msg.content.map(p => (typeof p === "string" ? p : (p?.text ?? ""))).join("") : "";
      if (MINIMAX_XML_LITERAL_MAP.some(([from]) => raw.includes(from))) {
        changed = true;
        const escapedContent = typeof msg.content === "string"
          ? escapeMinimaxXmlLiterals(msg.content)
          : Array.isArray(msg.content)
            ? msg.content.map(p =>
                typeof p === "string" ? escapeMinimaxXmlLiterals(p)
                : (p?.text ? { ...p, text: escapeMinimaxXmlLiterals(p.text) } : p))
            : msg.content;
        return { ...msg, content: escapedContent };
      }
      return msg;
    }

    // ── assistant: existing strip / convert logic below ─────────────────────
    const flatContent = flattenContent(msg?.content);
    const flatReasoning = typeof msg?.reasoning_content === "string" ? msg.reasoning_content : null;
    const contentHasXml = hasMinimaxToolCall(flatContent);
    const reasoningHasXml = hasMinimaxToolCall(flatReasoning);
    // Strip bare </mm:think> that M3 leaks into content on non-thinking turns.
    const contentHasOrphanThink = typeof flatContent === "string" && flatContent.includes("</mm:think>");

    // An already-present tool_calls array can itself carry contaminated
    // function.arguments strings — e.g. when llama-server's own peg-native
    // parser only partially converts M3's control-token output, leaving raw
    // "<]minimax[>[<invoke ...>]" fragments embedded inside an argument
    // value instead of clean JSON. content/reasoning_content are typically
    // null on these turns (nothing to catch above), so without this check
    // the message sails through untouched. Replaying it as history makes
    // llama-server's chat template re-embed the raw fragment into the
    // prompt text, which its own parser then rejects with
    // "Failed to parse input at pos N: <]minimax[>...".
    const toolCallsResult = Array.isArray(msg.tool_calls)
      ? sanitizeToolCallArguments(msg.tool_calls)
      : null;
    const toolCallsContaminated = !!toolCallsResult?.changed;

    if (!contentHasXml && !reasoningHasXml && !contentHasOrphanThink && !toolCallsContaminated) return msg;

    changed = true;
    const out = { ...msg };
    if (toolCallsContaminated) out.tool_calls = toolCallsResult.toolCalls;

    if (contentHasOrphanThink && !contentHasXml) {
      const cleaned = flatContent
        .replace(/<mm:think>[\s\S]*?<\/mm:think>/g, "")
        .replace(/<\/mm:think>/g, "")
        .trim();
      out.content = cleaned || null;
      return out;
    }

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

      // Context compression — deterministic, cache-safe, flag-gated.
      // Runs after sanitize so it never interferes with the M3 XML transform.
      const compressionCfg = mergeCompressionConfig(state.settings?.compression);
      const { messages: compressedMessages, stats: compressionStats } =
        compressMessages(sanitizedMessages, compressionCfg);
      if (compressionCfg.enabled && compressionStats.compressed > 0) {
        const saved = compressionStats.tokensIn - compressionStats.tokensOut;
        if (saved > 0) {
          console.log(
            `[compress] instanceId=${instance?.id} ` +
            `compressed=${compressionStats.compressed} msgs ` +
            `tokens=${compressionStats.tokensIn}→${compressionStats.tokensOut} ` +
            `saved~${saved}`
          );
          // Track savings on instance for the UI
          if (instance) {
            instance.totalCompressionTokensSaved =
              (Number(instance.totalCompressionTokensSaved) || 0) + saved;
            instance.totalCompressionTokensIn =
              (Number(instance.totalCompressionTokensIn) || 0) + compressionStats.tokensIn;
            instance.totalCompressionRuns =
              (Number(instance.totalCompressionRuns) || 0) + 1;
          }
        }
      }

      let reqBody = compressedMessages !== req.body.messages
        ? { ...req.body, messages: compressedMessages }
        : req.body;

      // Per-instance sampling defaults — only fill fields the client omitted.
      if (instance?.samplingDefaults && typeof instance.samplingDefaults === "object") {
        let merged = null;
        for (const [key, val] of Object.entries(instance.samplingDefaults)) {
          if (reqBody[key] === undefined || reqBody[key] === null) {
            if (!merged) merged = { ...reqBody };
            merged[key] = val;
          }
        }
        if (merged) reqBody = merged;
      }

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
          // llama-server sometimes returns the error as a bare JSON string
          // (e.g. `"Failed to parse input..."`) rather than an error object.
          const errorIsM3 = !upstream.ok && (isDiagnosticChat ||
            (typeof parsed === "string" && parsed.includes("Failed to parse input")) ||
            parsed?.error?.message?.includes?.("Failed to parse input"));
          if (errorIsM3) {
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
        } catch {
          // JSON.parse may fail when llama-server's error message contains
          // unescaped quotes from the M3 XML.  Try to recover the M3 tool
          // call XML directly from the raw response text.
          if (raw.includes("Failed to parse input") && raw.includes("[tool_call]")) {
            const recovered = recoverFromMinimaxParseError({ error: { message: raw } }, req.body?.model);
            if (recovered) {
              res.status(200);
              responseSent = JSON.stringify(recovered);
            }
          }
        }
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

    // Hybrid streaming strategy for chat/completions:
    //   Phase 1 – think:      stream <mm:think> tokens as reasoning_content in real-time
    //   Phase 2 – post-think: buffer until stream end, then transform for tool-call XML
    // This keeps the client unblocked during M3's long thinking monologues while
    // still allowing correct tool_calls synthesis after </mm:think>.
    // For responses with no <mm:think> block (post-tool-result continuations),
    // the first non-think delta triggers Phase 2 immediately (same as before).
    //
    // Phase 2 keepalive: during buffering the client sees no tokens and may time out.
    // Send SSE comment lines every 10 s to keep the connection alive.
    const PHASE2_KEEPALIVE_MS = 10_000;
    if (isDiagnosticChat) {
      let acc             = "";    // accumulates raw text until we have complete SSE events
      let thinkSeen       = false; // we have seen <mm:think>
      let postThink       = false; // we have seen </mm:think> → Phase 2
      let phase2Buffering = false; // true only when tool-call XML detected in Phase 2
      const postBuf       = [];    // SSE event strings buffered ONLY for tool-call transform
      let keepaliveTimer  = null;  // fires keepalives during tool-call buffering

      /** Rewrite a parsed chunk to carry reasoning_content instead of content. */
      function asReasoningChunk(chunk, delta, text) {
        const d = { ...delta, reasoning_content: text };
        delete d.content;
        return { ...chunk, choices: [{ ...chunk.choices[0], delta: d }] };
      }

      /**
       * Process one complete SSE event string (no trailing \n\n).
       * Phase 1: streams <mm:think> tokens as reasoning_content.
       * Phase 2: streams text tokens in real-time; buffers only on tool-call XML.
       */
      function processEvent(eventText) {
        // llama-server sometimes replaces the expected finish event with its
        // own "Failed to parse input at pos N" error mid-stream (it has no
        // choices[].delta, so it would otherwise fall through to the raw
        // passthrough branches below). Intercept and recover before anything else.
        if (tryRecoverStreamedM3Error(res, eventText, req.body?.model)) {
          clearTimeout(firstTokenTimer);
          clearInterval(keepaliveTimer); keepaliveTimer = null;
          markProxyCompletion(instance);
          finalize();
          stream.destroy();
          return;
        }
        // Increment live token counter for stall detection and TPS calculation.
        const liveInst = state.instances.find(x => x.id === instance.id) || instance;
        const prevCount = Number(liveInst.currentRequestTokens) || 0;
        liveInst.currentRequestTokens = prevCount + 1;
        // Reset start timestamp on the first token so TPS reflects decode speed,
        // not prefill wait time (prefill can take 30-90s with no tokens flowing).
        if (prevCount === 0) liveInst.currentRequestStartedAt = Date.now();

        // ── Phase 2: post-</mm:think> ──────────────────────────────────────────
        if (postThink) {
          if (phase2Buffering) {
            // Already in tool-call buffering mode — accumulate until EOS
            postBuf.push(eventText); return;
          }

          // Phase 2 streaming mode: pass tokens through in real-time.
          // Switch to buffering only if we detect actual tool-call XML.
          const p2DataLine = eventText.split("\n").find(l => l.trimStart().startsWith("data:"));
          if (!p2DataLine) { if (!res.writableEnded) res.write(eventText + "\n\n"); return; }
          const p2Payload = p2DataLine.trimStart().slice(5).trim();
          if (!p2Payload) { if (!res.writableEnded) res.write(eventText + "\n\n"); return; }
          if (p2Payload === "[DONE]") { if (!res.writableEnded) res.write(eventText + "\n\n"); return; }

          let p2Chunk;
          try { p2Chunk = JSON.parse(p2Payload); } catch { if (!res.writableEnded) res.write(eventText + "\n\n"); return; }
          const p2Delta   = p2Chunk?.choices?.[0]?.delta;
          const p2Content = typeof p2Delta?.content === "string" ? p2Delta.content : null;

          // Non-content delta (role header, finish_reason) — stream through
          if (p2Content === null) { if (!res.writableEnded) res.write(eventText + "\n\n"); return; }

          // Tool-call marker detected → switch to buffering + start keepalive
          if (p2Content.includes(MINIMAX_M3_CONTROL) || p2Content.includes("<invoke name=") || p2Content.includes("<minimax:tool_call>")) {
            phase2Buffering = true;
            if (!keepaliveTimer) {
              keepaliveTimer = setInterval(() => {
                if (!res.writableEnded) res.write(": keepalive\n\n");
              }, PHASE2_KEEPALIVE_MS);
            }
            postBuf.push(eventText); return;
          }

          // Strip orphaned </mm:think> (M3 emits on non-thinking turns)
          if (p2Content.includes("</mm:think>")) {
            const cleaned = p2Content.replace(/<mm:think>[\s\S]*?<\/mm:think>/g, "").replace(/<\/mm:think>/g, "").trim();
            const newChunk = { ...p2Chunk, choices: [{ ...p2Chunk.choices[0], delta: { ...p2Delta, content: cleaned } }] };
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(newChunk)}\n\n`);
            return;
          }

          // Regular Phase 2 text — stream directly
          if (!res.writableEnded) res.write(eventText + "\n\n");
          return;
        }

        // ── Phase 1: thinking or pre-think ────────────────────────────────────
        const dataLine = eventText.split("\n").find(l => l.trimStart().startsWith("data:"));
        if (!dataLine) { res.write(eventText + "\n\n"); return; }

        const payload = dataLine.trimStart().slice(5).trim();
        if (!payload) { res.write(eventText + "\n\n"); return; }
        if (payload === "[DONE]") { return; } // [DONE] only arrives in Phase 2 streaming path above

        let chunk;
        try { chunk = JSON.parse(payload); } catch { res.write(eventText + "\n\n"); return; }

        const delta   = chunk?.choices?.[0]?.delta;
        const content = typeof delta?.content === "string" ? delta.content : null;

        // Non-content delta (role header, finish_reason chunk, etc.)
        if (content === null) {
          // If thinking never started, first non-content delta → enter Phase 2
          if (!thinkSeen) { postThink = true; }
          if (!res.writableEnded) res.write(eventText + "\n\n");
          return;
        }

        const hasOpen  = content.includes("<mm:think>");
        const hasClose = content.includes("</mm:think>");

        // No think markers and thinking never started → Phase 2 immediately
        if (!thinkSeen && !hasOpen && !hasClose) {
          postThink = true;
          // Check immediately for tool call in the very first Phase 2 chunk
          if (content.includes(MINIMAX_M3_CONTROL) || content.includes("<invoke name=") || content.includes("<minimax:tool_call>")) {
            phase2Buffering = true;
            if (!keepaliveTimer) {
              keepaliveTimer = setInterval(() => {
                if (!res.writableEnded) res.write(": keepalive\n\n");
              }, PHASE2_KEEPALIVE_MS);
            }
            postBuf.push(eventText);
          } else {
            if (!res.writableEnded) res.write(eventText + "\n\n");
          }
          return;
        }

        if (hasOpen) thinkSeen = true;

        if (!hasClose) {
          // Pure think content — strip the open tag and emit as reasoning_content
          const clean = stripStrayM3Wrapper(content.replace(/<mm:think>/g, ""));
          if (clean) res.write(`data: ${JSON.stringify(asReasoningChunk(chunk, delta, clean))}\n\n`);
          return;
        }

        // This event contains </mm:think> — split at the close tag
        const ci        = content.indexOf("</mm:think>");
        const thinkPart = stripStrayM3Wrapper(content.slice(0, ci).replace(/<mm:think>/g, ""));
        const rest      = content.slice(ci + "</mm:think>".length).trim();

        if (thinkPart) res.write(`data: ${JSON.stringify(asReasoningChunk(chunk, delta, thinkPart))}\n\n`);

        // Enter Phase 2
        postThink = true;
        if (rest) {
          const restChunk = { ...chunk, choices: [{ ...chunk.choices[0], delta: { ...delta, content: rest } }] };
          // Check for tool call in the first post-think token
          if (rest.includes(MINIMAX_M3_CONTROL) || rest.includes("<invoke name=") || rest.includes("<minimax:tool_call>")) {
            phase2Buffering = true;
            if (!keepaliveTimer) {
              keepaliveTimer = setInterval(() => {
                if (!res.writableEnded) res.write(": keepalive\n\n");
              }, PHASE2_KEEPALIVE_MS);
            }
            postBuf.push(`data: ${JSON.stringify(restChunk)}`);
          } else {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(restChunk)}\n\n`);
          }
        }
      }

      stream.on("data", (rawChunk) => {
        if (!firstTokenReceived) { firstTokenReceived = true; clearTimeout(firstTokenTimer); }
        acc += rawChunk.toString("utf8");
        // Consume all complete SSE events (separated by \n\n)
        let sep;
        while ((sep = acc.indexOf("\n\n")) !== -1) {
          const event = acc.slice(0, sep);
          acc = acc.slice(sep + 2);
          if (event.trim()) processEvent(event);
          else if (!postThink) res.write("\n\n"); // preserve SSE framing
        }
      });

      stream.on("end", () => {
        clearTimeout(firstTokenTimer);
        clearInterval(keepaliveTimer); keepaliveTimer = null;
        // Compute TPS from streaming phase before resetting token counter.
        const liveInst = state.instances.find(x => x.id === instance.id) || instance;
        const startMs = Number(liveInst.currentRequestStartedAt) || 0;
        const tokenCount = Number(liveInst.currentRequestTokens) || 0;
        if (startMs > 0 && tokenCount > 5) {
          const elapsedSec = (Date.now() - startMs) / 1000;
          if (elapsedSec > 0.5) liveInst.lastRequestTps = Math.round((tokenCount / elapsedSec) * 10) / 10;
        }
        markProxyCompletion(instance);
        if (phase2Buffering) {
          // Flush any partial trailing bytes then transform the tool-call buffer
          if (acc.trim()) postBuf.push(acc);
          const sseText = postBuf.join("\n\n") + "\n\n";
          const recovered   = recoverMinimaxSseParseError(sseText, req.body?.model);
          const transformed = recovered ?? transformMinimaxSseBuffer(sseText);
          if (!res.writableEnded) { res.write(transformed); res.end(); }
        } else {
          // All content was streamed in real-time; just close
          if (acc.trim() && !res.writableEnded) res.write(acc);
          if (!res.writableEnded) res.end();
        }
        finalize();
      });
      stream.on("error", () => { clearTimeout(firstTokenTimer); clearInterval(keepaliveTimer); keepaliveTimer = null; finalize(); if (!res.writableEnded) res.end(); });
      res.on("close", () => { clearTimeout(firstTokenTimer); clearInterval(keepaliveTimer); keepaliveTimer = null; finalize(); });
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
