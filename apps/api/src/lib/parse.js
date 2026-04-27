import path from "path";

export function parseRuntimeArgs(value) {
  if (Array.isArray(value)) {
    return value.map((x) => String(x).trim()).filter(Boolean);
  }
  const text = String(value || "").trim();
  if (!text) return [];
  const matches = text.match(/"([^"\\]*(\\.[^"\\]*)*)"|'([^'\\]*(\\.[^'\\]*)*)'|\S+/g) || [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, "").trim()).filter(Boolean);
}

export function parseContextLength(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim().toLowerCase() === "auto") return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 256) return null;
  return num;
}

export function parseOptionalPositiveInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) return null;
  return num;
}

export function parsePositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) return fallback;
  return num;
}

export function parseBindHost(value) {
  const raw = String(value || "").trim();
  return raw || "0.0.0.0";
}

export function normalizeRuntimeBackend(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (raw === "valkun") return "vulkan";
  if (["auto", "cuda", "cuda_full", "cuda12", "cpu", "vulkan"].includes(raw)) return raw;
  return "auto";
}

export function parseRestartPolicy(value = {}) {
  const modeRaw = String(value?.mode || value?.restartMode || "never").trim().toLowerCase();
  const mode = modeRaw === "on-failure" ? "on-failure" : "never";
  const maxRetries = mode === "on-failure"
    ? parsePositiveInteger(value?.maxRetries ?? value?.restartMaxRetries, 2, 1, 20)
    : 0;
  const backoffMs = mode === "on-failure"
    ? parsePositiveInteger(value?.backoffMs ?? value?.restartBackoffMs, 3000, 250, 120000)
    : 0;
  return { mode, maxRetries, backoffMs };
}

export function toInstanceId(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return text || `inst_${Date.now()}`;
}

export function nextUniqueInstanceId(baseId, existingIds = new Set()) {
  if (!existingIds.has(baseId)) return baseId;
  let suffix = 2;
  while (existingIds.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}

export function cleanRuntime(runtime) {
  const rawArgs = Array.isArray(runtime?.serverArgs) && runtime.serverArgs.length > 0
    ? runtime.serverArgs
    : null;
  const isLmsArgs = Array.isArray(rawArgs) && rawArgs[0] === "server" && rawArgs[1] === "start";
  return {
    serverArgs: (!rawArgs || isLmsArgs) ? ["--port", "{port}"] : rawArgs.map((x) => String(x)),
    hardware: normalizeRuntimeBackend(runtime?.hardware || "auto")
  };
}
