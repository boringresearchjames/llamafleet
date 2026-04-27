import { bridgeUrl, bridgeToken, bridgeAuthEnabled, apiToken, port } from "./config.js";

export async function bridgeFetch(method, endpoint, body) {
  const headers = { "content-type": "application/json" };
  if (bridgeAuthEnabled) headers["x-bridge-token"] = bridgeToken;

  const response = await fetch(`${bridgeUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bridge error ${response.status}: ${text}`);
  }

  return response.json();
}

export async function localApi(method, endpoint, body) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiToken}`
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
