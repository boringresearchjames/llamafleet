/**
 * benchmark.mjs — quality benchmark: Qwen3.6-35B vs Gemma4-12B vs Fusion
 *
 * Usage: node scripts/benchmark.mjs
 */

const API_BASE = "http://192.168.50.73:8081";
const API_TOKEN = "llamafleet-api-token";
const API_HEADERS = {
  "content-type": "application/json",
  "authorization": `Bearer ${API_TOKEN}`,
};

const TARGETS = [
  {
    label: "Qwen3.6-35B",
    url: `${API_BASE}/v1/chat/completions`,
    model: "Qwen3.6-35B-A3B-UD-Q4_K_S",
    headers: API_HEADERS,
    // Disable extended thinking so the model answers directly; otherwise it
    // consumes its entire token budget on reasoning_content and emits no answer.
    extraParams: { enable_thinking: false },
  },
  {
    label: "Gemma4-12B",
    url: `${API_BASE}/v1/chat/completions`,
    model: "gemma-4-12b-it-IQ4_NL",
    headers: API_HEADERS,
  },
  {
    label: "⚡ Fusion (Qwen judge + Gemma peer)",
    url: `${API_BASE}/v1/chat/completions`,
    model: "fusion",
    headers: API_HEADERS,
    // Fusion judge is Qwen3.6 — also disable thinking so the synthesis is direct.
    extraParams: { enable_thinking: false },
  },
];

const PROMPTS = [
  {
    id: "monty",
    label: "Monty Hall (100 doors)",
    messages: [
      {
        role: "user",
        content:
          "You are on a game show with 100 doors. One hides a car; the other 99 hide goats. " +
          "You pick door #1. The host — who always knows what is behind every door — opens 98 " +
          "OTHER doors, all revealing goats, leaving your original door and exactly one other " +
          "door closed. You may switch to the other closed door or stay. " +
          "What is the exact probability of winning the car if you switch? " +
          "Show your full reasoning step by step.",
      },
    ],
  },
  {
    id: "factorial",
    label: "Trailing zeros in 100!",
    messages: [
      {
        role: "user",
        content:
          "How many trailing zeros does 100! (100 factorial) have? " +
          "Explain the mathematical method, show all the steps, and state the exact final number.",
      },
    ],
  },
  {
    id: "snail",
    label: "Snail-in-a-well (trick question)",
    messages: [
      {
        role: "user",
        content:
          "A snail is at the bottom of a 30-foot well. Each day it climbs 3 feet. " +
          "Each night it slides back 2 feet. " +
          "How many days does it take the snail to first reach OR pass the top of the well? " +
          "Show your reasoning carefully — many people get this wrong.",
      },
    ],
  },
  {
    id: "bugsearch",
    label: "Buggy binary search",
    messages: [
      {
        role: "user",
        content:
          "The following Python function contains a subtle bug. Find it, explain exactly why it " +
          "causes incorrect results (give a concrete failing example), and provide the corrected code.\n\n" +
          "```python\n" +
          "def binary_search(arr, target):\n" +
          "    low, high = 0, len(arr) - 1\n" +
          "    while low <= high:\n" +
          "        mid = low + high // 2\n" +
          "        if arr[mid] == target:\n" +
          "            return mid\n" +
          "        elif arr[mid] < target:\n" +
          "            low = mid + 1\n" +
          "        else:\n" +
          "            high = mid - 1\n" +
          "    return -1\n" +
          "```",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// HTTP consumer — buffers full response, then parses SSE or plain JSON.
// Returns { text, ttftMs, totalMs, tokens }
// ---------------------------------------------------------------------------
async function callStreaming(target, messages, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  let firstByteMs = null;
  let text = "";
  let tokens = 0;

  try {
    const resp = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({
        model: target.model,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 2048,
        ...(target.extraParams || {}),
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 300)}`);
    }

    // Buffer the full response body (works for both true-streaming SSE and
    // buffered responses where the server flushes everything at once).
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let rawBuf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (firstByteMs === null && chunk.length > 0) firstByteMs = Date.now() - t0;
      rawBuf += chunk;
    }

    // ── Parse SSE ──────────────────────────────────────────────────────────
    let thinkingText = "";
    for (const line of rawBuf.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const raw = trimmed.slice(5).trim();
      if (raw === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(raw); } catch { continue; }
      const delta = chunk?.choices?.[0]?.delta;
      const content = delta?.content;
      const reasoning = delta?.reasoning_content;
      if (content) { text += content; tokens++; }
      else if (reasoning) { thinkingText += reasoning; }
    }

    // If no content but there was reasoning, the model is thinking-only — use reasoning as answer
    if (!text.trim() && thinkingText.trim()) {
      text = thinkingText;
      tokens = 1;
    }

    // ── Fallback: plain JSON (non-streaming response) ─────────────────────
    if (!text.trim()) {
      try {
        const obj = JSON.parse(rawBuf.trim());
        const content = obj?.choices?.[0]?.message?.content;
        if (content) { text = content; tokens = 1; }
      } catch { /* not JSON */ }
    }

    // ── Debug: dump raw bytes when still empty ─────────────────────────────
    if (!text.trim()) {
      process.stderr.write(
        `\n${DIM}[debug] ${target.label}: ${rawBuf.length}B raw → ${rawBuf.slice(0, 400)}${RESET}\n`
      );
    }
  } finally {
    clearTimeout(timer);
  }

  const totalMs = Date.now() - t0;
  return { text: text.trim(), ttftMs: firstByteMs ?? totalMs, totalMs, tokens };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const CYAN  = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RED   = "\x1b[31m";

function hr(char = "─", n = 80) { return char.repeat(n); }

function truncate(str, maxLen = 600) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n${DIM}… [+${str.length - maxLen} chars]${RESET}`;
}

function scoreResponse(id, text) {
  // Simple heuristic scoring out of 10
  let score = 5;
  const lower = text.toLowerCase();

  if (id === "monty") {
    // Correct answer: 99/100 (switching wins 99% of the time)
    if (/99\s*\/\s*100|0\.99|99 out of 100|99\s*percent/i.test(text)) score += 4;
    else if (/switch/i.test(text) && /higher|better|greater|more likely/i.test(text)) score += 1;
    if (/initially.*1\s*\/\s*100|1\s*\/\s*100.*car|probability.*1\s*out of 100/i.test(text)) score += 1; // understood initial odds
  } else if (id === "factorial") {
    // Correct answer: 24 trailing zeros
    if (/\b24\b/.test(text)) score += 4;
    if (/floor|⌊|divide.*5|factor.*5/i.test(text)) score += 1; // correct method
  } else if (id === "snail") {
    // Correct answer: 28 days (NOT 30 — the snail reaches the top on day 28 before sliding back)
    if (/\b28\b/.test(text)) score += 4;
    else if (/\b30\b/.test(text) && !/\b28\b/.test(text)) score -= 2; // common wrong answer
    if (/day 2[78]|reach.*top.*day|on the last day|doesn.t slide/i.test(text)) score += 1;
  } else if (id === "bugsearch") {
    // Bug: operator precedence — `low + high // 2` is `low + (high // 2)`, not `(low + high) // 2`
    if (/precedence|low\s*\+\s*high\s*\/\//i.test(text)) score += 3;
    if (/\(low\s*\+\s*high\)\s*\/\//i.test(text)) score += 2; // showed the fix
    if (/example|e\.g\.|concret|failing|input/i.test(text)) score += 1; // gave example
  }

  return Math.min(10, Math.max(0, score));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║          LlamaFleet Quality Benchmark                        ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${RESET}\n`);
  console.log(`${DIM}Targets: ${TARGETS.map(t => t.label).join(" | ")}${RESET}`);
  console.log(`${DIM}Prompts: ${PROMPTS.map(p => p.label).join(" | ")}${RESET}\n`);

  const allScores = {}; // targetLabel → total score
  for (const t of TARGETS) allScores[t.label] = 0;

  for (const prompt of PROMPTS) {
    console.log(`\n${BOLD}${YELLOW}▶ ${prompt.label}${RESET}`);
    console.log(`${DIM}${prompt.messages[0].content.slice(0, 120)}…${RESET}`);
    console.log(hr());

    const results = [];
    for (const target of TARGETS) {
      process.stdout.write(`  ${target.label}: calling… `);
      let result;
      try {
        result = await callStreaming(target, prompt.messages, 180_000);
        const tps = Math.round(result.tokens / (result.totalMs / 1000));
        process.stdout.write(`${GREEN}done${RESET} | TTFT ${result.ttftMs}ms | total ${(result.totalMs/1000).toFixed(1)}s | ~${tps} tok/s\n`);
      } catch (err) {
        process.stdout.write(`${RED}FAILED: ${err.message.slice(0, 80)}${RESET}\n`);
        result = { text: `[ERROR: ${err.message}]`, ttftMs: 0, totalMs: 0, tokens: 0 };
      }
      results.push({ target, result });
    }

    console.log();
    for (const { target, result } of results) {
      const score = scoreResponse(prompt.id, result.text);
      allScores[target.label] += score;
      const scoreStr = score >= 8 ? `${GREEN}${score}/10${RESET}` : score >= 6 ? `${YELLOW}${score}/10${RESET}` : `${RED}${score}/10${RESET}`;
      console.log(`${BOLD}${MAGENTA}── ${target.label}${RESET}  [score: ${scoreStr}]`);
      console.log(truncate(result.text));
      console.log();
    }
  }

  // Final summary
  console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║  FINAL SCORES (out of ${PROMPTS.length * 10})                              ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${RESET}\n`);

  const ranked = Object.entries(allScores).sort((a, b) => b[1] - a[1]);
  for (let i = 0; i < ranked.length; i++) {
    const [label, score] = ranked[i];
    const bar = "█".repeat(Math.round(score / 2));
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
    console.log(`  ${medal} ${BOLD}${label}${RESET}: ${score}/${PROMPTS.length * 10}  ${GREEN}${bar}${RESET}`);
  }
  console.log();
}

main().catch(err => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(1);
});
