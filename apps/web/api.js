// api.js — pure API layer (no DOM dependencies)
// Imported by app.js and future Web Components.

export const DEFAULT_LOCAL_API_BASE = "http://localhost:8081";

export function normalizeApiBase(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/$/, "");
}

export function resolveInitialApiBase() {
  const params = new URLSearchParams(window.location.search || "");
  const queryBase = normalizeApiBase(params.get("apiBase"));
  const storedBase = normalizeApiBase(localStorage.getItem("apiBase") || "");

  if (queryBase) {
    localStorage.setItem("apiBase", queryBase);
    return queryBase;
  }

  if (storedBase) {
    return storedBase;
  }

  const origin = normalizeApiBase(window.location.origin);
  if (window.location.protocol !== "file:" && origin && origin !== "null") {
    return origin;
  }

  return DEFAULT_LOCAL_API_BASE;
}

export const settings = {
  apiBase: resolveInitialApiBase(),
  token: localStorage.getItem("apiToken") || ""
};

export function saveToken(token) {
  settings.token = String(token || "").trim();
  if (settings.token) {
    localStorage.setItem("apiToken", settings.token);
  } else {
    localStorage.removeItem("apiToken");
  }
}

export async function api(path, options = {}) {
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {})
  };

  if (settings.token) {
    headers.authorization = `Bearer ${settings.token}`;
  }

  const response = await fetch(`${settings.apiBase}${path}`, {
    ...options,
    headers
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(data.error || text || `HTTP ${response.status}`);
  }

  return data;
}
