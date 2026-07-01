/**
 * swe-bench.mjs — execution-based code-repair benchmark
 *
 * Each task presents a buggy JavaScript function + failing tests.
 * The model must output a corrected function in a ```javascript``` block.
 * The fix is extracted and actually run in Node.js — score = real pass/fail.
 *
 * Usage: node scripts/swe-bench.mjs
 */

import { execSync } from "child_process";
import { writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const API_BASE   = "http://192.168.50.73:8081";
const API_TOKEN  = "llamafleet-api-token";
const API_HEADERS = {
  "content-type": "application/json",
  "authorization": `Bearer ${API_TOKEN}`,
};

const TARGETS = [
  {
    label: "Qwen3.6-35B",
    model: "Qwen3.6-35B-A3B-UD-Q4_K_S",
    extraParams: { enable_thinking: false },
  },
  {
    label: "Gemma4-12B",
    model: "gemma-4-12b-it-IQ4_NL",
  },
  {
    label: "⚡ Fusion",
    model: "fusion",
    extraParams: { enable_thinking: false },
  },
];

// ---------------------------------------------------------------------------
// Tasks — each has buggy source, a harness of assertions, and human-readable
// labels for each test case so failures are easy to read.
// ---------------------------------------------------------------------------
const TASKS = [
  {
    id: "sliding-window",
    label: "Longest unique substring (off-by-one in sliding window)",
    buggy: `\
function longestUniqueSubstring(s) {
  let maxLen = 0;
  let start = 0;
  const seen = new Map();
  for (let end = 0; end < s.length; end++) {
    if (seen.has(s[end]) && seen.get(s[end]) >= start) {
      start = seen.get(s[end]);   // BUG: should advance PAST the duplicate
    }
    seen.set(s[end], end);
    maxLen = Math.max(maxLen, end - start + 1);
  }
  return maxLen;
}`,
    harness: `
const cases = [
  ["abcabcbb", 3],
  ["abba",     2],
  ["pwwkew",   3],
  ["",         0],
  ["aab",      2],
];
for (const [input, expected] of cases) {
  const got = longestUniqueSubstring(input);
  if (got !== expected)
    throw new Error(\`longestUniqueSubstring("\${input}"): expected \${expected}, got \${got}\`);
}
`,
  },
  {
    id: "reduce-init",
    label: "Deep sum (missing reduce initialValue — type coercion on nested arrays)",
    buggy: `\
function deepSum(arr) {
  return arr.reduce((acc, val) => {
    if (Array.isArray(val)) return acc + deepSum(val);
    return acc + val;
  });                              // BUG: no initialValue — first element becomes acc
}`,
    harness: `
const cases = [
  [[1, 2, 3],           6 ],
  [[[1, 2], [3, 4]],    10],
  [[1, [2, [3, [4]]]],  10],
  [[],                  0 ],
  [[5],                 5 ],
];
for (const [input, expected] of cases) {
  let got;
  try { got = deepSum(input); } catch (e) { got = \`threw: \${e.message}\`; }
  if (got !== expected)
    throw new Error(\`deepSum(\${JSON.stringify(input)}): expected \${expected}, got \${JSON.stringify(got)}\`);
}
`,
  },
  {
    id: "var-closure",
    label: "Closure in loop (var leaks loop counter across all closures)",
    buggy: `\
function makeAdders(increments) {
  const adders = [];
  for (var i = 0; i < increments.length; i++) {
    adders.push(n => n + increments[i]);   // BUG: var shares i — all closures see final value
  }
  return adders;
}`,
    harness: `
const [add2, add5, add10] = makeAdders([2, 5, 10]);
const cases = [
  [add2,  3,  5],
  [add5,  3,  8],
  [add10, 3, 13],
  [add2,  0,  2],
  [add5,  10, 15],
];
for (const [fn, input, expected] of cases) {
  const got = fn(input);
  if (got !== expected)
    throw new Error(\`adder(\${input}): expected \${expected}, got \${got}\`);
}
`,
  },
  {
    id: "splice-dedup",
    label: "Array dedup (splice without decrementing index skips consecutive dupes)",
    buggy: `\
function dedup(arr) {
  const result = [...arr];
  for (let i = 0; i < result.length; i++) {
    if (result.indexOf(result[i]) !== i) {
      result.splice(i, 1);     // BUG: next element shifts to i but loop advances to i+1
    }
  }
  return result;
}`,
    harness: `
const cases = [
  [[1, 1, 2, 3],    [1, 2, 3]],
  [[1, 1, 1, 2],    [1, 2]   ],
  [[4, 4, 4, 4],    [4]      ],
  [[1, 2, 3],       [1, 2, 3]],
  [[3, 1, 3, 2, 3], [3, 1, 2]],
];
for (const [input, expected] of cases) {
  const got = dedup(input);
  if (JSON.stringify(got) !== JSON.stringify(expected))
    throw new Error(\`dedup(\${JSON.stringify(input)}): expected \${JSON.stringify(expected)}, got \${JSON.stringify(got)}\`);
}
`,
  },
];

// ---------------------------------------------------------------------------
// Code extraction — pull the first ```javascript / ```js block, fall back to
// any ``` block, then fall back to a bare function declaration.
// ---------------------------------------------------------------------------
function extractCode(text) {
  let m = text.match(/```(?:javascript|js)\s*\n([\s\S]*?)```/);
  if (m) return m[1].trim();
  m = text.match(/```\s*\n([\s\S]*?)```/);
  if (m) return m[1].trim();
  // Bare function: grab from `function <name>` to matching closing brace
  m = text.match(/(function\s+\w+[\s\S]*?\n})/);
  if (m) return m[1].trim();
  return null;
}

// ---------------------------------------------------------------------------
// Execution — write extracted code + harness to a temp file, run in Node.js.
// ---------------------------------------------------------------------------
function runCode(fnCode, harness) {
  const fullCode = `"use strict";\n${fnCode}\n\n${harness}`;
  const tmpPath = join(tmpdir(), `swe-bench-${process.pid}-${Date.now()}.js`);
  try {
    writeFileSync(tmpPath, fullCode, "utf8");
    execSync(`node "${tmpPath}"`, { timeout: 10_000, stdio: "pipe" });
    return { pass: true };
  } catch (err) {
    const out = ((err.stdout || "") + (err.stderr || "")).toString();
    const errLine = out.split("\n").find(l => l.includes("Error:")) || out.slice(0, 200);
    return { pass: false, error: errLine.trim() };
  } finally {
    try { rmSync(tmpPath); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// API call — buffers full body, parses SSE or plain JSON.
// ---------------------------------------------------------------------------
async function callModel(target, messages, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  let text = "";

  try {
    const resp = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({
        model: target.model,
        messages,
        stream: true,
        temperature: 0.2,          // lower temp for code repair
        max_tokens: 2048,
        ...(target.extraParams || {}),
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const e = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${e.slice(0, 200)}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }

    // SSE
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk?.choices?.[0]?.delta;
        if (delta?.content)           text += delta.content;
        else if (delta?.reasoning_content) text += delta.reasoning_content;
      } catch { /* skip */ }
    }

    // Plain JSON fallback
    if (!text.trim()) {
      try {
        const obj = JSON.parse(raw.trim());
        text = obj?.choices?.[0]?.message?.content || "";
      } catch { /* skip */ }
    }
  } finally {
    clearTimeout(timer);
  }

  return { text: text.trim(), ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------
function buildPrompt(task) {
  return [
    {
      role: "system",
      content:
        "You are a code debugging assistant. " +
        "When asked to fix a function, respond with ONLY the corrected function " +
        "inside a single ```javascript``` code block. " +
        "Do not include test code, imports, explanations, or anything outside the code block.",
    },
    {
      role: "user",
      content:
        `The following JavaScript function has a bug. ` +
        `Find the bug and output the corrected function.\n\n` +
        "```javascript\n" + task.buggy + "\n```",
    },
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const RESET   = "\x1b[0m";
const BOLD    = "\x1b[1m";
const DIM     = "\x1b[2m";
const CYAN    = "\x1b[36m";
const GREEN   = "\x1b[32m";
const YELLOW  = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RED     = "\x1b[31m";
function hr(n = 80) { return "─".repeat(n); }

async function main() {
  console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║   SWE-Bench (execution-based code repair)                    ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${RESET}\n`);

  // task → target → { pass, error, ms, code }
  const results = {};
  for (const t of TASKS) results[t.id] = {};

  for (const task of TASKS) {
    console.log(`\n${BOLD}${YELLOW}▶ ${task.label}${RESET}`);
    console.log(hr());

    for (const target of TARGETS) {
      process.stdout.write(`  ${target.label}: calling… `);
      let pass = false, error = "no response", ms = 0, code = null;

      try {
        const { text, ms: elapsed } = await callModel(target, buildPrompt(task), 180_000);
        ms = elapsed;
        code = extractCode(text);

        if (!code) {
          error = "could not extract code from response";
          process.stdout.write(`${RED}no code extracted${RESET} (${(ms/1000).toFixed(1)}s)\n`);
        } else {
          const result = runCode(code, task.harness);
          pass = result.pass;
          error = result.error || "";
          const statusStr = pass
            ? `${GREEN}PASS${RESET}`
            : `${RED}FAIL${RESET}`;
          process.stdout.write(`${statusStr} (${(ms/1000).toFixed(1)}s)\n`);
          if (!pass) {
            console.log(`    ${DIM}${error.slice(0, 120)}${RESET}`);
          }
        }
      } catch (err) {
        error = err.message;
        process.stdout.write(`${RED}ERROR: ${err.message.slice(0, 60)}${RESET}\n`);
      }

      results[task.id][target.label] = { pass, error, ms, code };
    }

    // Show extracted fixes side-by-side
    console.log();
    for (const target of TARGETS) {
      const r = results[task.id][target.label];
      const icon = r.pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      console.log(`${icon} ${BOLD}${MAGENTA}${target.label}${RESET}`);
      if (r.code) {
        const preview = r.code.split("\n").slice(0, 8).join("\n");
        console.log(`${DIM}${preview}${RESET}`);
      }
      console.log();
    }
  }

  // ── Final scorecard ──────────────────────────────────────────────────────
  console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║  FINAL SCORECARD (pass/fail per task)                        ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${RESET}\n`);

  const totals = {};
  for (const t of TARGETS) totals[t.label] = 0;

  // Header row
  const col = 32;
  process.stdout.write(" ".repeat(col));
  for (const t of TARGETS) process.stdout.write(t.label.padEnd(18));
  console.log();
  console.log(hr(col + TARGETS.length * 18));

  for (const task of TASKS) {
    process.stdout.write(task.label.slice(0, col - 2).padEnd(col));
    for (const target of TARGETS) {
      const r = results[task.id][target.label];
      const cell = r.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
      if (r.pass) totals[target.label]++;
      process.stdout.write(cell + " ".repeat(14));
    }
    console.log();
  }

  console.log(hr(col + TARGETS.length * 18));
  process.stdout.write("TOTAL".padEnd(col));
  for (const t of TARGETS) {
    const n = totals[t.label];
    const total = TASKS.length;
    const color = n === total ? GREEN : n >= total / 2 ? YELLOW : RED;
    process.stdout.write(`${color}${n}/${total}${RESET}` + " ".repeat(16));
  }
  console.log("\n");
}

main().catch(err => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(1);
});
