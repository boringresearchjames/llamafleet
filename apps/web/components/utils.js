import { store } from '../store.js';

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Safe for both HTML text content and attribute values (same encoding needed).
export const escapeAttr = escapeHtml;

// Show only the last 3 path segments (author/repo/file.gguf) for display
export function trimModelPath(modelPath) {
  const parts = String(modelPath).replace(/\\/g, "/").split("/");
  return parts.length > 3 ? parts.slice(-3).join("/") : modelPath;
}

// Trim all absolute file paths within an args string to last 3 segments
export function trimArgsModelPaths(args) {
  return String(args).replace(/\/[^\s]+\.gguf/g, (match) => trimModelPath(match));
}

export function normalizeRuntimeBackend(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (raw === "valkun") return "vulkan";
  if (raw === "cuda_full" || raw.includes("cuda12")) return "cuda_full";
  if (raw.includes("cuda")) return "cuda";
  if (raw === "rocm_full") return "rocm_full";
  if (raw.includes("rocm")) return "rocm";
  if (raw.includes("vulkan")) return "vulkan";
  if (raw.includes("cpu")) return "cpu";
  if (raw.includes("auto")) return "auto";
  if (["auto", "cuda", "cuda_full", "rocm", "rocm_full", "cpu", "vulkan"].includes(raw)) return raw;
  return "auto";
}

export function runtimeBackendUsesGpu(value) {
  return normalizeRuntimeBackend(value) !== "cpu";
}

export function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "application/yaml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function formatCompactCount(value) {
  const num = Math.max(0, Number(value || 0));
  if (!Number.isFinite(num)) return "0";
  return Math.round(num).toLocaleString();
}

export function activeInstances(data) {
  const list = data !== undefined ? data : (store.get('instances') || []);
  return (list || []).filter((inst) => inst.state !== "stopped");
}

export function occupiedPortsSet() {
  const set = new Set();
  activeInstances().forEach((inst) => {
    if (Number.isInteger(Number(inst.port))) {
      set.add(Number(inst.port));
    }
  });
  return set;
}

export function occupiedGpuSet() {
  const set = new Set();
  activeInstances().forEach((inst) => {
    (inst.gpus || []).forEach((gpu) => set.add(String(gpu)));
  });
  return set;
}

export function suggestNextFreePort(start = 1234) {
  const occupied = occupiedPortsSet();
  for (let p = start; p <= 65535; p += 1) {
    if (!occupied.has(p)) return p;
  }
  return start;
}

export function copy(value) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(value)
      .then(() => _notify(`Copied: ${value.slice(0, 80)}`))
      .catch(() => copyFallback(value));
  } else {
    copyFallback(value);
  }
}

export function copyFallback(value) {
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    _notify(`Copied: ${value.slice(0, 80)}`);
  } catch (_) {
    _notify('Copy failed');
  }
  document.body.removeChild(ta);
}

function _notify(msg) {
  document.getElementById('toast')?.notify(`[${new Date().toLocaleTimeString()}] ${msg}`);
}
