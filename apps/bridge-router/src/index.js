import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const port = Number(process.env.BRIDGE_ROUTER_PORT || 8090);
const state = {
  nextPoolIndex: 0,
  instancePool: new Map()
};

function parsePools() {
  const raw = String(process.env.BRIDGE_POOLS_JSON || "").trim();
  if (!raw) {
    const singleUrl = String(process.env.BRIDGE_URL || "http://127.0.0.1:8091").trim();
    const singleToken = String(process.env.BRIDGE_AUTH_TOKEN || "change-me").trim();
    return [{ id: "default", url: singleUrl, token: singleToken, gpus: [] }];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("BRIDGE_POOLS_JSON must be a non-empty array");
    }
    return parsed.map((pool, idx) => ({
      id: String(pool?.id || `pool-${idx + 1}`),
      url: String(pool?.url || "").replace(/\/$/, ""),
      token: String(pool?.token || "change-me"),
      gpus: Array.isArray(pool?.gpus) ? pool.gpus.map((x) => String(x)) : []
    })).filter((pool) => pool.url);
  } catch (error) {
    throw new Error(`Invalid BRIDGE_POOLS_JSON: ${String(error.message || error)}`);
  }
}

const pools = parsePools();
if (pools.length === 0) {
  throw new Error("No bridge pools configured");
}

function now() {
  return new Date().toISOString();
}

function authHeaders(pool) {
  const token = String(pool?.token || "").trim();
  if (!token || token === "change-me") return {};
  return { "x-bridge-token": token };
}

async function poolFetch(pool, method, endpoint, body) {
  const response = await fetch(`${pool.url}${endpoint}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...authHeaders(pool)
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const detail = data?.error || data?.detail || text || `HTTP ${response.status}`;
    throw new Error(`${pool.id}: ${detail}`);
  }

  return data;
}

function normalizeGpuList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((x) => String(x).trim()).filter(Boolean))];
}

function choosePoolForGpus(gpus = []) {
  const requested = normalizeGpuList(gpus);
  if (requested.length === 0) {
    const pool = pools[state.nextPoolIndex % pools.length];
    state.nextPoolIndex = (state.nextPoolIndex + 1) % pools.length;
    return pool;
  }

  const exact = pools.find((pool) => {
    const set = new Set(pool.gpus);
    return pool.gpus.length === requested.length && requested.every((gpu) => set.has(gpu));
  });
  if (exact) return exact;

  const superset = pools.find((pool) => {
    const set = new Set(pool.gpus);
    return requested.every((gpu) => set.has(gpu));
  });
  if (superset) return superset;

  return null;
}

async function collectPoolInstances() {
  const results = [];
  for (const pool of pools) {
    try {
      const payload = await poolFetch(pool, "GET", "/v1/instances");
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      for (const row of rows) {
        const id = String(row?.instanceId || "");
        if (!id) continue;
        state.instancePool.set(id, pool.id);
      }
      results.push({ pool, payload, ok: true });
    } catch (error) {
      results.push({ pool, error, ok: false });
    }
  }
  return results;
}

function poolById(id) {
  return pools.find((pool) => pool.id === id) || null;
}

async function resolvePoolForInstance(instanceId) {
  const known = poolById(state.instancePool.get(instanceId));
  if (known) return known;

  const snapshots = await collectPoolInstances();
  for (const entry of snapshots) {
    if (!entry.ok) continue;
    const rows = Array.isArray(entry.payload?.data) ? entry.payload.data : [];
    if (rows.some((row) => String(row?.instanceId || "") === instanceId)) {
      state.instancePool.set(instanceId, entry.pool.id);
      return entry.pool;
    }
  }

  return null;
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "bridge-router",
    at: now(),
    pools: pools.map((pool) => ({ id: pool.id, url: pool.url, gpus: pool.gpus }))
  });
});

app.get("/v1/gpus", async (_req, res) => {
  const data = [];
  const diagnostics = [];
  for (const pool of pools) {
    try {
      const payload = await poolFetch(pool, "GET", "/v1/gpus");
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      rows.forEach((gpu) => {
        data.push({ ...gpu, pool: pool.id });
      });
      if (payload?.warning) {
        diagnostics.push({ pool: pool.id, warning: payload.warning, diagnostics: payload.diagnostics || null });
      }
    } catch (error) {
      diagnostics.push({ pool: pool.id, warning: String(error.message || error) });
    }
  }

  if (data.length === 0 && diagnostics.length > 0) {
    return res.status(502).json({ data: [], warning: "all bridge pools unavailable", diagnostics });
  }

  return res.json({ data, diagnostics });
});

app.get("/v1/instances", async (_req, res) => {
  const merged = [];
  const errors = [];

  const snapshots = await collectPoolInstances();
  for (const entry of snapshots) {
    if (!entry.ok) {
      errors.push({ pool: entry.pool.id, error: String(entry.error?.message || entry.error) });
      continue;
    }

    const rows = Array.isArray(entry.payload?.data) ? entry.payload.data : [];
    rows.forEach((row) => merged.push({ ...row, pool: entry.pool.id }));
  }

  if (merged.length === 0 && errors.length > 0) {
    return res.status(502).json({ data: [], errors });
  }

  return res.json({ data: merged, errors });
});

app.post("/v1/instances/start", async (req, res) => {
  const instanceId = String(req.body?.instanceId || "").trim();
  const requestedGpus = normalizeGpuList(req.body?.profile?.gpus || []);
  const pool = choosePoolForGpus(requestedGpus);

  if (!pool) {
    return res.status(400).json({ error: `No bridge pool matches requested GPUs: ${requestedGpus.join(",") || "<none>"}` });
  }

  try {
    const payload = await poolFetch(pool, "POST", "/v1/instances/start", req.body || {});
    if (instanceId) {
      state.instancePool.set(instanceId, pool.id);
    }
    return res.json(payload);
  } catch (error) {
    return res.status(502).json({ error: String(error.message || error) });
  }
});

app.post("/v1/system/close", async (req, res) => {
  const results = [];
  for (const pool of pools) {
    try {
      const payload = await poolFetch(pool, "POST", "/v1/system/close", req.body || {});
      results.push({ pool: pool.id, ok: true, data: payload });
    } catch (error) {
      results.push({ pool: pool.id, ok: false, error: String(error.message || error) });
    }
  }

  const failed = results.filter((x) => !x.ok);
  if (failed.length === results.length) {
    return res.status(502).json({ error: "all pools failed close", results });
  }

  return res.json({ success: true, results });
});

app.post("/v1/instances/:id/stop", async (req, res) => {
  const instanceId = String(req.params.id || "");
  const pool = await resolvePoolForInstance(instanceId);
  if (!pool) return res.status(404).json({ error: "instance not found in any bridge pool" });

  try {
    const payload = await poolFetch(pool, "POST", `/v1/instances/${encodeURIComponent(instanceId)}/stop`, req.body || {});
    state.instancePool.delete(instanceId);
    return res.json(payload);
  } catch (error) {
    return res.status(502).json({ error: String(error.message || error) });
  }
});

app.post("/v1/instances/:id/kill", async (req, res) => {
  const instanceId = String(req.params.id || "");
  const pool = await resolvePoolForInstance(instanceId);
  if (!pool) return res.status(404).json({ error: "instance not found in any bridge pool" });

  try {
    const payload = await poolFetch(pool, "POST", `/v1/instances/${encodeURIComponent(instanceId)}/kill`, req.body || {});
    state.instancePool.delete(instanceId);
    return res.json(payload);
  } catch (error) {
    return res.status(502).json({ error: String(error.message || error) });
  }
});

app.post("/v1/instances/:id/drain", async (req, res) => {
  const instanceId = String(req.params.id || "");
  const pool = await resolvePoolForInstance(instanceId);
  if (!pool) return res.status(404).json({ error: "instance not found in any bridge pool" });

  try {
    const payload = await poolFetch(pool, "POST", `/v1/instances/${encodeURIComponent(instanceId)}/drain`, req.body || {});
    return res.json(payload);
  } catch (error) {
    return res.status(502).json({ error: String(error.message || error) });
  }
});

app.get("/v1/instances/:id/logs", async (req, res) => {
  const instanceId = String(req.params.id || "");
  const pool = await resolvePoolForInstance(instanceId);
  if (!pool) return res.status(404).json({ error: "instance not found in any bridge pool" });

  const lines = Number(req.query?.lines || 200);
  try {
    const payload = await poolFetch(pool, "GET", `/v1/instances/${encodeURIComponent(instanceId)}/logs?lines=${lines}`);
    return res.json(payload);
  } catch (error) {
    return res.status(502).json({ error: String(error.message || error) });
  }
});

app.listen(port, () => {
  console.log(`lmlaunch bridge-router listening on ${port}`);
  console.log(`configured pools: ${pools.map((pool) => `${pool.id}@${pool.url}[${pool.gpus.join(",")}]`).join(" | ")}`);
});
