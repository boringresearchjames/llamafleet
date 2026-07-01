import { describe, it, expect } from "vitest";
import {
  compressMessages,
  mergeCompressionConfig,
  DEFAULT_COMPRESSION_CONFIG
} from "../apps/api/src/lib/compress.js";

const enabled = mergeCompressionConfig({ enabled: true });

// ---------------------------------------------------------------------------
// Safety: never compress when disabled / wrong roles
// ---------------------------------------------------------------------------

describe("compress safety", () => {
  it("is a no-op when disabled", () => {
    const messages = [{ role: "tool", content: "x".repeat(10000) }];
    const { messages: out, stats } = compressMessages(messages, DEFAULT_COMPRESSION_CONFIG);
    expect(out).toBe(messages); // same reference
    expect(stats.compressed).toBe(0);
  });

  it("never touches assistant or system messages", () => {
    const longLog = Array.from({ length: 500 }, (_, i) => `2026-01-01 line ${i}`).join("\n");
    const messages = [
      { role: "system", content: longLog },
      { role: "assistant", content: longLog, tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }] }
    ];
    const { messages: out } = compressMessages(messages, enabled);
    expect(out[0].content).toBe(longLog);
    expect(out[1].content).toBe(longLog);
    expect(out[1].tool_calls).toEqual(messages[1].tool_calls);
  });

  it("leaves short content untouched", () => {
    const messages = [{ role: "tool", content: "short result" }];
    const { messages: out } = compressMessages(messages, enabled);
    expect(out[0].content).toBe("short result");
  });
});

// ---------------------------------------------------------------------------
// Determinism: same input → same output (required for KV-cache hits)
// ---------------------------------------------------------------------------

describe("compress determinism", () => {
  it("produces identical output across repeated runs", () => {
    const log = Array.from({ length: 400 }, (_, i) => `2026-01-01T00:00:00.${i}Z INFO event ${i % 7}`).join("\n");
    const messages = [{ role: "tool", content: log }];
    const a = compressMessages(structuredClone(messages), enabled).messages[0].content;
    const b = compressMessages(structuredClone(messages), enabled).messages[0].content;
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Correctness: structure preserved
// ---------------------------------------------------------------------------

describe("compress correctness", () => {
  it("keeps valid JSON valid after compaction", () => {
    const obj = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, val: null, name: `n${i}` })), meta: null };
    const messages = [{ role: "tool", content: JSON.stringify(obj) }];
    const { messages: out } = compressMessages(messages, enabled);
    expect(() => JSON.parse(out[0].content)).not.toThrow();
    const parsed = JSON.parse(out[0].content);
    expect(parsed.meta).toBeUndefined(); // null dropped
    expect(parsed.items.length).toBeLessThanOrEqual(enabled.maxJsonArrayItems + 1); // +sentinel
  });

  it("preserves ERROR/FATAL lines when truncating logs", () => {
    const lines = [];
    for (let i = 0; i < 500; i++) lines.push(`2026-01-01 INFO noise ${i}`);
    lines.splice(250, 0, "2026-01-01 FATAL critical failure XYZ");
    const messages = [{ role: "tool", content: lines.join("\n") }];
    const { messages: out } = compressMessages(messages, enabled);
    expect(out[0].content).toContain("FATAL critical failure XYZ");
  });

  it("keeps head and tail of long code files", () => {
    const code = Array.from({ length: 600 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const messages = [{ role: "user", content: code }];
    const { messages: out } = compressMessages(messages, enabled);
    expect(out[0].content).toContain("const line0 = 0;");
    expect(out[0].content).toContain("const line599 = 599;");
    expect(out[0].content).toContain("lines omitted");
  });

  it("strips ANSI escape codes from log output", () => {
    const ansiLog = Array.from({ length: 200 }, (_, i) =>
      `\x1b[32m2026-01-01T00:00:00Z\x1b[0m INFO step ${i} done`
    ).join("\n");
    const messages = [{ role: "tool", content: ansiLog }];
    const { messages: out } = compressMessages(messages, enabled);
    expect(out[0].content).not.toContain("\x1b[");
  });

  it("compresses unified diff — drops context lines, keeps changes", () => {
    const diff = [
      "diff --git a/src/foo.js b/src/foo.js",
      "index abc123..def456 100644",
      "--- a/src/foo.js",
      "+++ b/src/foo.js",
      "@@ -1,6 +1,6 @@",
      " const a = 1;",
      " const b = 2;",
      "-const c = 3;",
      "+const c = 99;",
      " const d = 4;",
      " const e = 5;",
    ].join("\n");
    const messages = [{ role: "tool", content: diff }];
    const { messages: out } = compressMessages(messages, enabled);
    const result = out[0].content;
    expect(result).toContain("-const c = 3;");
    expect(result).toContain("+const c = 99;");
    expect(result).not.toContain(" const a = 1;");  // context line dropped
    expect(result).toContain("context lines omitted");
  });

  it("skips noisy diff files (lockfiles)", () => {
    const lockDiff = [
      "diff --git a/package-lock.json b/package-lock.json",
      "index aaa..bbb 100644",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -1,3 +1,3 @@",
      "-  \"version\": \"1.0.0\",",
      "+  \"version\": \"1.0.1\",",
      "diff --git a/src/index.js b/src/index.js",
      "--- a/src/index.js",
      "+++ b/src/index.js",
      "@@ -1,2 +1,2 @@",
      "-const X = 1;",
      "+const X = 2;",
    ].join("\n");
    const messages = [{ role: "tool", content: lockDiff }];
    const { messages: out } = compressMessages(messages, enabled);
    expect(out[0].content).not.toContain("package-lock.json");
    expect(out[0].content).toContain("+const X = 2;");
  });

  it("strips HTML tags and returns plain text", () => {
    const html = `<!DOCTYPE html><html><head><title>Test</title><style>body{color:red}</style></head>
<body><h1>Hello World</h1><p>This is a <strong>test</strong> paragraph with useful content.</p>
${Array.from({ length: 50 }, (_, i) => `<div class="item">Item ${i} content here</div>`).join("\n")}
</body></html>`;
    const messages = [{ role: "tool", content: html }];
    const { messages: out } = compressMessages(messages, enabled);
    const result = out[0].content;
    expect(result).not.toContain("<div");
    expect(result).not.toContain("<style");
    expect(result).toContain("Hello World");
    expect(result).toContain("test");
    expect(result.length).toBeLessThan(html.length);
  });

  it("does NOT gut an SVG/HTML source file the agent is reading back (attribute payload)", () => {
    // Regression test: a generated HTML page with an inline SVG globe carries
    // its meaningful data in tag ATTRIBUTES (path "d", cx/cy/r, gradients),
    // not inter-tag text. stripHtml() must not run on this — it would leave
    // almost nothing behind, corrupting the file content in context.
    const paths = Array.from({ length: 40 }, (_, i) =>
      `<path d="M${i} ${i} L${i + 10} ${i + 10} A5 5 0 0 1 ${i + 20} ${i}" fill="#2b6" stroke="#000" />`
    ).join("\n    ");
    const html = `<!DOCTYPE html>
<html>
<head><style>body{margin:0;background:#000}</style></head>
<body>
  <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="g"><stop offset="0%" stop-color="#5af"/></radialGradient></defs>
    <circle cx="100" cy="100" r="90" fill="url(#g)" />
    ${paths}
  </svg>
  <script>
    let rotation = 0;
    function animate() {
      rotation += 1;
      const el = document.querySelector('svg');
      if (el) { el.style.transform = 'rotate(' + rotation + 'deg)'; }
      requestAnimationFrame(animate);
    }
    animate();
  </script>
</body>
</html>`;
    for (const role of ["tool", "user"]) {
      const messages = [{ role, content: html }];
      const { messages: out } = compressMessages(messages, enabled);
      const result = out[0].content;
      // Must still contain the actual SVG payload — not stripped to near-nothing.
      expect(result).toContain('cx="100"');
      expect(result).toContain("<path d=");
      expect(result).toContain("<svg");
    }
  });

  it("collapses similar build-output lines (pattern dedup)", () => {
    const buildLog = [
      "[ 0%] Building CXX object src/CMakeFiles/foo.dir/a.cpp.o",
      "[ 10%] Building CXX object src/CMakeFiles/foo.dir/b.cpp.o",
      "[ 20%] Building CXX object src/CMakeFiles/foo.dir/c.cpp.o",
      "[ 30%] Building CXX object src/CMakeFiles/foo.dir/d.cpp.o",
      "[ 40%] Building CXX object src/CMakeFiles/foo.dir/e.cpp.o",
      "[ 50%] Building CXX object src/CMakeFiles/foo.dir/f.cpp.o",
      "[ 60%] Building CXX object src/CMakeFiles/foo.dir/g.cpp.o",
      "[ 70%] Building CXX object src/CMakeFiles/foo.dir/h.cpp.o",
      "[100%] Linking CXX executable foo",
    ].join("\n");
    // Build output comes from user messages (pasted terminal output), not tool role.
    // Pattern dedup is disabled for tool messages to prevent agent loops.
    const messages = [{ role: "user", content: buildLog }];
    const { messages: out } = compressMessages(messages, enabled);
    const result = out[0].content;
    // Similar lines should be collapsed
    expect(result.split("\n").length).toBeLessThan(buildLog.split("\n").length);
    // Link line is different — should survive
    expect(result).toContain("Linking CXX executable");
  });
});

// ---------------------------------------------------------------------------
// Benchmark: token-savings on representative agentic payloads
// ---------------------------------------------------------------------------

describe("compress benchmark — token savings", () => {
  const approxTokens = (t) => Math.ceil(String(t || "").length / 3.7);

  function ratio(content, role = "tool") {
    const { messages: out } = compressMessages([{ role, content }], enabled);
    const after = typeof out[0].content === "string" ? out[0].content : JSON.stringify(out[0].content);
    const before = typeof content === "string" ? content : JSON.stringify(content);
    return {
      before: approxTokens(before),
      after: approxTokens(after),
      saved: 1 - approxTokens(after) / approxTokens(before)
    };
  }

  it("compresses repetitive logs by >=40%", () => {
    const lines = [];
    for (let i = 0; i < 800; i++) lines.push(`2026-01-01T00:00:00.000Z INFO repeated processing step done`);
    const r = ratio(lines.join("\n"));
    expect(r.saved).toBeGreaterThanOrEqual(0.4);
  });

  it("compresses large JSON arrays by >=30%", () => {
    const obj = { results: Array.from({ length: 300 }, (_, i) => ({ id: i, score: null, label: `result-${i}`, extra: null })) };
    const r = ratio(JSON.stringify(obj));
    expect(r.saved).toBeGreaterThanOrEqual(0.3);
  });

  it("compresses long file reads by >=50%", () => {
    const code = Array.from({ length: 1000 }, (_, i) => `    const variableNumber${i} = computeSomething(${i}, "padding-text-here");`).join("\n");
    const r = ratio(code, "user");
    expect(r.saved).toBeGreaterThanOrEqual(0.5);
  });

  it("compresses unified diffs by >=40%", () => {
    const diff = [
      "diff --git a/src/big.js b/src/big.js",
      "--- a/src/big.js",
      "+++ b/src/big.js",
      "@@ -1,200 +1,200 @@",
      ...Array.from({ length: 80 }, (_, i) => ` const unchanged${i} = ${i};`),
      ...Array.from({ length: 20 }, (_, i) => [`-const old${i} = ${i};`, `+const new${i} = ${i + 100};`]).flat(),
      ...Array.from({ length: 80 }, (_, i) => ` const alsoUnchanged${i} = ${i};`),
    ].join("\n");
    const r = ratio(diff);
    expect(r.saved).toBeGreaterThanOrEqual(0.4);
  });

  it("does not expand content (output never larger than input)", () => {
    const samples = [
      "short",
      JSON.stringify({ a: 1, b: [1, 2, 3] }),
      Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    ];
    for (const s of samples) {
      const r = ratio(s);
      expect(r.after).toBeLessThanOrEqual(r.before);
    }
  });

  it("completes compression of a 1MB payload quickly (<250ms)", () => {
    const big = Array.from({ length: 20000 }, (_, i) => `2026-01-01T00:00:00.000Z INFO line ${i} some payload text`).join("\n");
    const messages = [{ role: "tool", content: big }];
    const start = performance.now();
    compressMessages(messages, enabled);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(250);
  });
});

