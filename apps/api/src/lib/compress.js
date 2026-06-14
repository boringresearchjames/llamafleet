/**
 * compress.js — Deterministic context-compression for LlamaFleet.
 *
 * Compresses tool/user message content before it reaches llama-server,
 * reducing prompt-token count (and thus prefill latency) without touching
 * tool-call schemas, assistant reasoning, or the M3 XML machinery.
 *
 * Design constraints:
 *  1. DETERMINISTIC — pure function of content, no randomness/timestamps.
 *  2. SAFE — never touches assistant tool_calls, tools[] schemas, or system messages.
 *  3. FLAG-GATED — a no-op when disabled.
 *
 * Pipeline (most-specific detector first):
 *   JSON → Diff → Code → Log → HTML → Search → plain-text fallback
 *
 * Compressors:
 *  - JSON: adaptive sampling (30/15/55 split), null-drop, base64 truncation,
 *          long-string truncation, compact output.
 *  - Diff: keep file headers + @@ + +/- lines; drop context lines + noisy files.
 *  - Code: head + tail truncation.
 *  - Log: ANSI strip → identical dedup → pattern dedup (build output) →
 *          blank collapse → head/tail + important-line preservation.
 *  - HTML: script/style removal, tag stripping, entity decode.
 *  - Search: top-N results.
 */

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_COMPRESSION_CONFIG = {
  enabled: false,
  maxLogLines: 120,
  maxJsonArrayItems: 24,
  maxCodeLines: 200,
  codeHeadLines: 60,
  codeTailLines: 40,
  maxSearchResults: 12,
  compressDiffs: true,   // strip context lines from unified diffs
  stripHtml: true,       // strip HTML tags from web-fetch results
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s) { return s.replace(ANSI_RE, ""); }

const BASE64_RE = /^[A-Za-z0-9+/]{80,}={0,2}$/;

function countTokensApprox(text) {
  return Math.ceil(String(text || "").length / 3.7);
}

// ---------------------------------------------------------------------------
// Content-type detectors  (order in compressString matters)
// ---------------------------------------------------------------------------

function isJsonLike(text) {
  const t = text.trimStart();
  if (t.length <= 80) return false;
  if (t.startsWith("{")) return true;
  if (t.startsWith("[")) {
    // Distinguish JSON arrays from log-line progress prefixes like "[ 0%]" or "[100%]"
    if (/^\[\s*\d+[%/]/.test(t)) return false;
    return /^\[[ \t]*["\[{\-0-9tfn\]]/.test(t);
  }
  return false;
}

function isDiffLike(text) {
  return (
    text.startsWith("diff --git ") ||
    (text.includes("\n--- ") && text.includes("\n+++ ") && text.includes("\n@@ "))
  ) && text.includes("\n");
}

function isHtmlLike(text) {
  return /<(html|head|body|div|p|span|article|section|nav|header|footer|script|style)\b/i.test(text)
    && text.includes("</");
}

function isLogLike(text) {
  const lines = text.split("\n");
  if (lines.length < 8) return false;
  const logPat = /(\d{4}-\d{2}|\[\s*\d+[%/]|\[\d|INFO|WARN|ERROR|DEBUG|FATAL|stderr|stdout|\.\d{3}Z|npm (warn|err)|warning:|error:|\s+at )/;
  const matched = lines.filter(l => logPat.test(l));
  return matched.length >= Math.min(3, Math.ceil(lines.length * 0.12));
}

function isCodeLike(text) {
  const lines = text.split("\n");
  if (lines.length < 20) return false;
  const codePat = /^\s*(import |export |function |class |const |let |var |def |if |for |while |return |\/\/|#!|pub |fn |async |type |interface |impl |struct |enum )/;
  return lines.filter(l => codePat.test(l)).length >= 4;
}

function isSearchResultsLike(text) {
  return /^\s*\d+[\)\.]\s+.+/m.test(text) || /^(Result|Match|File|Path)\s+\d+/im.test(text);
}

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a line to a structural "signature" for pattern-based dedup.
 * Used to collapse runs of build-output lines like:
 *   [  1%] Building CXX object ...foo.cpp.o
 *   [  2%] Building CXX object ...bar.cpp.o
 */
function getLineSignature(line) {
  return line
    .replace(ANSI_RE, "")
    .replace(/^\s*\[[\s\d%/,.]+\]\s*/, "")          // [N%] / [N/M] prefixes
    .replace(/^\s*\d+[:/]\s+/, "")                   // "42: " leading count
    .replace(/\b0x[0-9a-fA-F]+\b/g, "#x")            // hex addresses
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^ ]*/g, "#ts") // timestamps
    .replace(/\S*[/\\]\S+\.\w+/g, "#path")           // paths with extensions
    .replace(/\b\d+\b/g, "#")                         // remaining numbers
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Diff compressor
// ---------------------------------------------------------------------------

const NOISY_DIFF_FILES = /\.(lock|snap|sum|min\.js|min\.css|\.map)$|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum|pnpm-lock\.yaml|composer\.lock/i;

function compressDiff(text) {
  const lines = text.split("\n");
  const out = [];
  let skipFile = false;
  let hunkHeader = null;
  let totalDropped = 0;
  let totalChanged = 0;

  for (const line of lines) {
    // New file section
    if (line.startsWith("diff --git ") || line.startsWith("diff -")) {
      skipFile = NOISY_DIFF_FILES.test(line);
      if (!skipFile) out.push(line);
      hunkHeader = null;
      continue;
    }
    if (skipFile) continue;

    // File metadata — always keep
    if (
      line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") ||
      line.startsWith("new file") || line.startsWith("deleted file") ||
      line.startsWith("rename ") || line.startsWith("old mode") ||
      line.startsWith("new mode") || line.startsWith("Binary ")
    ) {
      hunkHeader = null;
      out.push(line);
      continue;
    }

    // Hunk header — buffer until we see a changed line
    if (line.startsWith("@@ ")) {
      hunkHeader = line;
      continue;
    }

    // Changed lines — flush buffered hunk header first
    if (line.startsWith("+") || line.startsWith("-")) {
      if (hunkHeader) { out.push(hunkHeader); hunkHeader = null; }
      out.push(line);
      totalChanged++;
      continue;
    }

    // Context lines (' ' prefix) and blank lines — drop
    totalDropped++;
  }

  const result = out.join("\n");
  if (result === text) return text; // nothing changed
  if (totalDropped > 0) {
    return result + `\n// [diff: ${totalDropped} context lines omitted, ${totalChanged} changed lines kept]`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTML stripper
// ---------------------------------------------------------------------------

function stripHtml(text) {
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Log compressor (4-stage)
// ---------------------------------------------------------------------------

function compressLog(text, cfg) {
  const raw = stripAnsi(text);
  const lines = raw.split("\n");
  const importantPat = /error|fatal|warn|assert|exception|traceback|panic|failed|oom|out of memory/i;

  // Stage 1: deduplicate consecutive identical lines
  const deduped = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let count = 1;
    while (i + count < lines.length && lines[i + count] === line) count++;
    if (count > 3) {
      deduped.push(line);
      deduped.push(`... [${count - 1} identical lines omitted]`);
    } else {
      for (let j = 0; j < count; j++) deduped.push(line);
    }
    i += count;
  }

  // Stage 2: pattern-normalised dedup (collapses build-output runs)
  const patDeduped = [];
  let j = 0;
  while (j < deduped.length) {
    const line = deduped[j];
    if (importantPat.test(line)) { patDeduped.push(line); j++; continue; }
    const sig = getLineSignature(line);
    if (!sig) { patDeduped.push(line); j++; continue; }
    let count = 1;
    while (
      j + count < deduped.length &&
      !importantPat.test(deduped[j + count]) &&
      getLineSignature(deduped[j + count]) === sig
    ) count++;
    if (count >= 6) {
      patDeduped.push(deduped[j]);
      patDeduped.push(`... [${count - 2} similar lines: ${sig.slice(0, 40)}]`);
      patDeduped.push(deduped[j + count - 1]);
    } else {
      for (let k = 0; k < count; k++) patDeduped.push(deduped[j + k]);
    }
    j += count;
  }

  // Stage 3: collapse runs of 3+ blank lines to 2
  const collapsed = [];
  let blanks = 0;
  for (const line of patDeduped) {
    if (line.trim() === "") { blanks++; if (blanks <= 2) collapsed.push(line); }
    else { blanks = 0; collapsed.push(line); }
  }

  if (collapsed.length <= cfg.maxLogLines) return collapsed.join("\n");

  // Stage 4: head + tail + important-line preservation
  const headCount = Math.floor(cfg.maxLogLines * 0.35);
  const tailCount = Math.floor(cfg.maxLogLines * 0.35);
  const headSet = new Set(collapsed.slice(0, headCount));
  const tailSet = new Set(collapsed.slice(-tailCount));
  const importantExtra = [];
  for (const line of collapsed) {
    if (importantPat.test(line) && !headSet.has(line) && !tailSet.has(line)) {
      importantExtra.push(line);
    }
  }
  const importantSlice = importantExtra.slice(0, cfg.maxLogLines - headCount - tailCount);
  const omitted = collapsed.length - headCount - tailCount;
  const parts = [...collapsed.slice(0, headCount)];
  if (importantSlice.length > 0) {
    parts.push(`\n... [${omitted} lines omitted · ${importantSlice.length} key lines shown] ...\n`);
    parts.push(...importantSlice);
  } else {
    parts.push(`\n... [${omitted} lines omitted] ...\n`);
  }
  parts.push(...collapsed.slice(-tailCount));
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// JSON compressor
// ---------------------------------------------------------------------------

/**
 * Adaptive sampling: keep important items unconditionally, then split
 * the remainder 30% head / 15% tail / 55% uniform sample from middle.
 * Mirrors Headroom's SmartCrusher retention split.
 */
function adaptiveSample(arr, maxItems) {
  if (arr.length <= maxItems) return arr;
  const omitted = arr.length - maxItems;
  const impPat = /error|fail|warn|exception|fatal/i;

  const impIdx = new Set();
  for (let idx = 0; idx < arr.length; idx++) {
    const s = typeof arr[idx] === "string" ? arr[idx] : JSON.stringify(arr[idx]).slice(0, 200);
    if (impPat.test(s)) impIdx.add(idx);
  }
  const important = arr.filter((_, idx) => impIdx.has(idx));
  const regular   = arr.filter((_, idx) => !impIdx.has(idx));
  const budget    = Math.max(0, maxItems - important.length);

  if (budget === 0) return [...important.slice(0, maxItems), `... [${omitted} items omitted]`];

  const headN  = Math.ceil(budget * 0.30);
  const tailN  = Math.ceil(budget * 0.15);
  const midN   = Math.max(0, budget - headN - tailN);
  const head   = regular.slice(0, headN);
  const tail   = regular.length > tailN ? regular.slice(-tailN) : [];
  const midSrc = regular.slice(headN, regular.length > tailN ? regular.length - tailN : regular.length);
  const sampled = midN <= 0 || midSrc.length === 0 ? [] :
    midN >= midSrc.length ? midSrc :
    Array.from({ length: midN }, (_, k) => midSrc[Math.floor(k * midSrc.length / midN)]);

  return [...important, ...head, `... [${omitted} items sampled from ${arr.length}]`, ...sampled, ...tail];
}

function compressJson(text, cfg) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text; }

  function compact(val, depth = 0) {
    if (depth > 50) return val; // guard against deeply nested JSON
    if (val === null || val === undefined) return val;
    if (typeof val === "string") {
      if (val.length > 80 && BASE64_RE.test(val))
        return `[base64 ~${Math.round(val.length * 0.75)} bytes]`;
      if (val.length > 2000)
        return val.slice(0, 500) + `... [${val.length - 500} chars omitted]`;
      return val;
    }
    if (Array.isArray(val)) {
      const compacted = val.map(v => compact(v, depth + 1)).filter(v => v !== undefined);
      return adaptiveSample(compacted, cfg.maxJsonArrayItems);
    }
    if (typeof val === "object") {
      const out = {};
      for (const [k, v] of Object.entries(val)) {
        if (v === null || v === undefined) continue; // drop nulls
        const cv = compact(v, depth + 1);
        if (cv !== undefined) out[k] = cv;
      }
      return out;
    }
    return val;
  }

  try {
    const compacted = compact(parsed);
    const result = JSON.stringify(compacted); // compact output, no spaces
    return result.length < text.length ? result : text;
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Code compressor
// ---------------------------------------------------------------------------

function compressCode(text, cfg) {
  const lines = text.split("\n");
  if (lines.length <= cfg.maxCodeLines) return text;
  const head = lines.slice(0, cfg.codeHeadLines);
  const tail = lines.slice(-cfg.codeTailLines);
  const omitted = lines.length - cfg.codeHeadLines - cfg.codeTailLines;
  return [...head, "", `// ... [${omitted} lines omitted — middle of file] ...`, "", ...tail].join("\n");
}

// ---------------------------------------------------------------------------
// Search-results compressor
// ---------------------------------------------------------------------------

function compressSearchResults(text, cfg) {
  const parts = text.split(/(?=^\s*(?:\d+[\)\.]\s|(?:Result|Match|File|Path)\s+\d+))/mi);
  if (parts.length <= cfg.maxSearchResults + 1) return text;
  const header = parts[0];
  const results = parts.slice(1);
  const omitted = results.length - cfg.maxSearchResults;
  return header + results.slice(0, cfg.maxSearchResults).join("") +
    `\n... [${omitted} more results omitted] ...\n`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function compressString(text, cfg) {
  if (typeof text !== "string" || text.length < 80) return text;

  // Lossless first: strip ANSI escape codes (zero semantic cost)
  const s = stripAnsi(text);

  if (isJsonLike(s))   return compressJson(s, cfg);

  if (cfg.compressDiffs && isDiffLike(s)) {
    return compressDiff(s); // compressDiff returns original when unchanged
  }

  if (isCodeLike(s))   return compressCode(s, cfg);
  if (isLogLike(s))    return compressLog(s, cfg);

  if (cfg.stripHtml && isHtmlLike(s)) {
    const plain = stripHtml(s);
    // After stripping, the result may itself be compressible
    return plain.length < s.length ? compressString(plain, { ...cfg, stripHtml: false }) : s;
  }

  if (isSearchResultsLike(s)) return compressSearchResults(s, cfg);

  // Plain-text fallback: if long enough, apply log compressor
  if (s.split("\n").length > cfg.maxLogLines * 1.5) return compressLog(s, cfg);

  // Return ANSI-stripped form even if no structural compression fired
  return s !== text ? s : text;
}

// ---------------------------------------------------------------------------
// Content-level
// ---------------------------------------------------------------------------

function compressContent(content, cfg) {
  if (typeof content === "string") return compressString(content, cfg);
  if (Array.isArray(content)) {
    return content.map(part => {
      if (!part || typeof part !== "object") return part;
      if (part.type === "text" && typeof part.text === "string") {
        const compressed = compressString(part.text, cfg);
        return compressed === part.text ? part : { ...part, text: compressed };
      }
      return part;
    });
  }
  return content;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compress the messages array. Returns original reference when nothing changes.
 * Only compresses tool + user messages. Never touches assistant/system/tool_calls.
 */
export function compressMessages(messages, cfg = DEFAULT_COMPRESSION_CONFIG) {
  if (!cfg.enabled || !Array.isArray(messages)) {
    return { messages, stats: { tokensIn: 0, tokensOut: 0, compressed: 0 } };
  }

  let changed = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let compressedCount = 0;

  const result = messages.map(msg => {
    if (!msg || typeof msg !== "object") return msg;
    if (msg.role !== "tool" && msg.role !== "user") return msg;
    const content = msg.content;
    if (!content) return msg;

    const before = typeof content === "string" ? content : JSON.stringify(content);
    tokensIn += countTokensApprox(before);

    const afterContent = compressContent(content, cfg);
    const after = typeof afterContent === "string" ? afterContent : JSON.stringify(afterContent);
    tokensOut += countTokensApprox(after);

    if (after !== before) {
      changed = true;
      compressedCount++;
      return { ...msg, content: afterContent };
    }
    return msg;
  });

  return {
    messages: changed ? result : messages,
    stats: { tokensIn, tokensOut, compressed: compressedCount }
  };
}

/**
 * Merge a partial config over the defaults.
 */
export function mergeCompressionConfig(partial) {
  if (!partial || typeof partial !== "object") return { ...DEFAULT_COMPRESSION_CONFIG };
  const d = DEFAULT_COMPRESSION_CONFIG;
  return {
    enabled:          typeof partial.enabled          === "boolean" ? partial.enabled          : d.enabled,
    maxLogLines:      Number(partial.maxLogLines)      > 0          ? Number(partial.maxLogLines)      : d.maxLogLines,
    maxJsonArrayItems:Number(partial.maxJsonArrayItems)> 0          ? Number(partial.maxJsonArrayItems): d.maxJsonArrayItems,
    maxCodeLines:     Number(partial.maxCodeLines)     > 0          ? Number(partial.maxCodeLines)     : d.maxCodeLines,
    codeHeadLines:    Number(partial.codeHeadLines)    > 0          ? Number(partial.codeHeadLines)    : d.codeHeadLines,
    codeTailLines:    Number(partial.codeTailLines)    > 0          ? Number(partial.codeTailLines)    : d.codeTailLines,
    maxSearchResults: Number(partial.maxSearchResults) > 0          ? Number(partial.maxSearchResults) : d.maxSearchResults,
    compressDiffs:    typeof partial.compressDiffs     === "boolean" ? partial.compressDiffs     : d.compressDiffs,
    stripHtml:        typeof partial.stripHtml         === "boolean" ? partial.stripHtml         : d.stripHtml,
  };
}
