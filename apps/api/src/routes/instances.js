import crypto from "crypto";
import express from "express";
import { state, saveState } from "../lib/state.js";
import { audit } from "../lib/audit.js";
import { now } from "../lib/utils.js";
import { bridgeFetch } from "../lib/bridge.js";
import { resolveModelName, uniqueModelRouteName } from "../lib/routing.js";
import { instanceBaseUrl, instancePublicBaseUrl, resolveAdvertisedHost, apiPublicBaseUrl } from "../lib/urls.js";
import { isGlobalApiKeyRequired } from "../lib/auth.js";
import {
  parseRuntimeArgs,
  parseContextLength,
  parseBindHost,
  normalizeRuntimeBackend,
  parsePositiveInteger,
  parseOptionalPositiveInteger,
  parseRestartPolicy,
  toInstanceId,
  nextUniqueInstanceId,
  cleanRuntime
} from "../lib/parse.js";

const router = express.Router();

router.get("/instances", async (_req, res) => {
  const apiBase = apiPublicBaseUrl();
  let gpuData = [];
  try {
    const bridgeState = await bridgeFetch("GET", "/v1/instances");
    const gpus = await bridgeFetch("GET", "/v1/gpus");
    gpuData = Array.isArray(gpus?.data) ? gpus.data : [];

    const gpuById = new Map(gpuData.map((gpu) => [String(gpu.id), gpu]));
    state.instances = state.instances.map((inst) => {
      const runtime = bridgeState.data.find((x) => x.instanceId === inst.id);
      const localInflight = Number(inst.inflightRequests || 0);
      const localQueueDepth = Number(inst.queueDepth || 0);
      const runtimeState = runtime?.state;
      const instanceDead = !runtime || runtimeState === "stopped" || runtimeState === "error";
      const mergedInflight = instanceDead ? 0 : (Number.isFinite(localInflight) ? Math.max(0, localInflight) : 0);
      const mergedQueueDepth = instanceDead ? 0 : (Number.isFinite(localQueueDepth) ? Math.max(0, localQueueDepth) : 0);
      const assignedGpus = Array.isArray(inst.gpus) ? inst.gpus.map((g) => String(g)) : [];
      const gpuStats = assignedGpus
        .map((id) => gpuById.get(id))
        .filter(Boolean)
        .map((gpu) => ({
          id: String(gpu.id),
          name: gpu.name,
          memory_total_mib: gpu.memory_total_mib,
          memory_used_mib: gpu.memory_used_mib,
          utilization_percent: gpu.utilization_percent,
          temperature_c: gpu.temperature_c ?? null,
          graphics_clock_mhz: gpu.graphics_clock_mhz ?? null,
          memory_clock_mhz: gpu.memory_clock_mhz ?? null,
          power_draw_w: gpu.power_draw_w ?? null
        }));
      return {
        ...inst,
        pid: runtime?.pid || null,
        state: runtime?.state || "stopped",
        inflightRequests: mergedInflight,
        queueDepth: mergedQueueDepth,
        gpuStats,
        updatedAt: now()
      };
    });
    saveState(state);
  } catch {
    // Keep last-known state if bridge is unavailable.
  }

  const data = state.instances.map((inst) => ({
    ...inst,
    advertisedHost: resolveAdvertisedHost(inst),
    baseUrl: instancePublicBaseUrl(inst),
    proxyBaseUrl: `${apiBase}/v1/instances/${encodeURIComponent(inst.id)}/proxy/v1`,
    modelRouteName: inst.modelRouteName || resolveModelName(inst.effectiveModel) || inst.effectiveModel || null
  }));

  const modelNameCounts = new Map();
  for (const inst of state.instances.filter((x) => x.state !== "stopped")) {
    const key = inst.modelRouteName || resolveModelName(inst.effectiveModel) || inst.effectiveModel;
    if (key) modelNameCounts.set(key, (modelNameCounts.get(key) || 0) + 1);
  }
  for (const inst of data) {
    const key = inst.modelRouteName;
    inst.modelNameAmbiguous = Boolean(key && (modelNameCounts.get(key) || 0) > 1);
  }

  res.json({ data, gpus: gpuData });
});

router.post("/instances/start", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const launchHost = String(req.body?.host || "127.0.0.1").trim() || "127.0.0.1";
  const launchPort = Number(req.body?.port);
  const requestedId = String(req.body?.instanceId || "").trim();
  const modelToUse = String(req.body?.model || "").trim();
  const runtimeArgs = parseRuntimeArgs(req.body?.runtimeArgs);
  const contextLength = parseContextLength(req.body?.contextLength);
  const bindHost = parseBindHost(req.body?.bindHost);
  const runtimeBackend = normalizeRuntimeBackend(req.body?.runtimeBackend || "auto");
  const launchGpus = Array.isArray(req.body?.gpus)
    ? req.body.gpus.map((g) => String(g))
    : [];
  const maxInflightRequests = parsePositiveInteger(req.body?.maxInflightRequests, 4, 1, 1024);
  const queueLimit = parsePositiveInteger(req.body?.queueLimit, 64, 1, 100000);
  const modelTtlSeconds = parseOptionalPositiveInteger(req.body?.modelTtlSeconds);
  const modelParallel = parseOptionalPositiveInteger(req.body?.modelParallel);
  const headersTimeoutMs = parseOptionalPositiveInteger(req.body?.headersTimeoutMs);
  const restartPolicy = parseRestartPolicy(req.body?.restartPolicy);

  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
  if (!Number.isInteger(launchPort) || launchPort < 1 || launchPort > 65535) {
    return res.status(400).json({ error: "valid port is required" });
  }
  if (!modelToUse) {
    return res.status(400).json({ error: "model is required" });
  }

  const usedIds = new Set(state.instances.map((x) => String(x.id)));
  const instanceId = requestedId
    ? nextUniqueInstanceId(toInstanceId(requestedId), usedIds)
    : crypto.randomUUID();

  const activeInstances = state.instances.filter((x) => x.state !== "stopped");
  const portConflict = activeInstances.find(
    (x) => Number(x.port) === launchPort && String(x.host || "127.0.0.1") === launchHost
  );
  if (portConflict) {
    return res.status(409).json({
      error: "port already in use by running instance",
      port: launchPort,
      instanceId: portConflict.id
    });
  }

  const usesGpu = runtimeBackend !== "cpu";
  if (usesGpu && launchGpus.length === 0) {
    return res.status(400).json({
      error: "at least one GPU must be selected for non-CPU runtime"
    });
  }
  if (usesGpu) {
    const occupiedGpus = new Set(
      activeInstances
        .filter((x) => normalizeRuntimeBackend(x?.runtime?.hardware) !== "cpu")
        .flatMap((x) => (Array.isArray(x.gpus) ? x.gpus.map((g) => String(g)) : []))
    );
    const duplicateGpus = launchGpus.filter((g) => occupiedGpus.has(String(g)));
    if (duplicateGpus.length > 0) {
      return res.status(409).json({
        error: "gpu already assigned to running instance",
        gpus: [...new Set(duplicateGpus)]
      });
    }
  }

  const profile = {
    id: null,
    name,
    runtime: {
      serverArgs: runtimeArgs,
      hardware: runtimeBackend
    },
    host: launchHost,
    bindHost,
    port: launchPort,
    gpus: usesGpu ? launchGpus : [],
    contextLength,
    startupTimeoutMs: 180000,
    queueLimit,
    modelTtlSeconds,
    modelParallel,
    restartPolicy
  };

  const modelRouteName = uniqueModelRouteName(
    resolveModelName(modelToUse) || modelToUse,
    instanceId,
    state.instances
  );

  const existing = state.instances.find((x) => x.id === instanceId);
  if (existing && existing.state !== "stopped") {
    return res.status(409).json({ error: "instance already exists and is not stopped" });
  }

  const provisional = {
    id: instanceId,
    profileId: null,
    profileName: name,
    effectiveModel: modelToUse,
    modelRouteName,
    pendingModel: null,
    host: launchHost,
    bindHost,
    port: launchPort,
    state: "starting",
    pid: null,
    gpus: usesGpu ? launchGpus : [],
    runtime: {
      serverArgs: runtimeArgs,
      hardware: runtimeBackend
    },
    contextLength,
    maxInflightRequests,
    queueLimit,
    modelTtlSeconds,
    modelParallel,
    headersTimeoutMs,
    restartPolicy,
    inflightRequests: 0,
    queueDepth: 0,
    completedRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    lastActivityAt: null,
    drain: false,
    lastHealthOkAt: null,
    lastError: null,
    gpuStats: [],
    startedAt: now(),
    updatedAt: now()
  };

  if (existing) {
    const idx = state.instances.findIndex((x) => x.id === instanceId);
    state.instances[idx] = provisional;
  } else {
    state.instances.push(provisional);
  }
  saveState(state);

  try {
    const launch = await bridgeFetch("POST", "/v1/instances/start", {
      instanceId,
      profile: {
        ...profile,
        model: modelToUse,
        maxInflightRequests
      }
    });

    const idx = state.instances.findIndex((x) => x.id === instanceId);
    const instance = {
      ...(idx >= 0 ? state.instances[idx] : provisional),
      state: launch.state || "starting",
      pid: launch.pid || null,
      lastError: null,
      updatedAt: now()
    };

    if (idx >= 0) {
      state.instances[idx] = instance;
    } else {
      state.instances.push(instance);
    }

    saveState(state);
    audit("instance.start", { instanceId, profileName: name, port: launchPort });
    res.status(201).json(instance);
  } catch (error) {
    const idx = state.instances.findIndex((x) => x.id === instanceId);
    if (idx >= 0) {
      state.instances[idx] = {
        ...state.instances[idx],
        state: "stopped",
        lastError: String(error.message || error),
        updatedAt: now()
      };
      saveState(state);
    }
    res.status(502).json({ error: String(error.message || error) });
  }
});

router.post("/instances/:id/restart", async (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  if (instance.state !== "stopped" && instance.state !== "unhealthy") {
    return res.status(409).json({ error: "instance must be stopped or unhealthy to restart" });
  }

  const profile = {
    id: null,
    name: instance.profileName || instance.id,
    runtime: cleanRuntime(instance.runtime),
    host: instance.host || "127.0.0.1",
    bindHost: instance.bindHost || instance.host || "127.0.0.1",
    port: instance.port,
    gpus: Array.isArray(instance.gpus) ? instance.gpus : [],
    contextLength: parseContextLength(instance.contextLength),
    startupTimeoutMs: 180000,
    queueLimit: instance.queueLimit || 64,
    modelTtlSeconds: instance.modelTtlSeconds || null,
    modelParallel: instance.modelParallel || null,
    restartPolicy: instance.restartPolicy || { mode: "never" }
  };

  instance.modelRouteName = uniqueModelRouteName(
    resolveModelName(instance.effectiveModel) || instance.effectiveModel,
    instance.id,
    state.instances
  );
  instance.state = "starting";
  instance.lastError = null;
  instance.pid = null;
  instance.inflightRequests = 0;
  instance.queueDepth = 0;
  instance.lastHealthOkAt = null;
  instance.startedAt = now();
  instance.updatedAt = now();
  saveState(state);

  try {
    const launch = await bridgeFetch("POST", "/v1/instances/start", {
      instanceId: instance.id,
      profile: {
        ...profile,
        model: instance.effectiveModel,
        maxInflightRequests: instance.maxInflightRequests || 4
      }
    });

    instance.state = launch.state || "starting";
    instance.pid = launch.pid || null;
    instance.updatedAt = now();
    saveState(state);
    audit("instance.restart", { instanceId: instance.id });
    res.json(instance);
  } catch (error) {
    instance.state = "stopped";
    instance.lastError = String(error.message || error);
    instance.updatedAt = now();
    saveState(state);
    res.status(502).json({ error: String(error.message || error) });
  }
});

router.post("/instances/:id/stop", async (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  try {
    await bridgeFetch("POST", `/v1/instances/${instance.id}/stop`);
    instance.state = "stopped";
    instance.updatedAt = now();
    saveState(state);
    audit("instance.stop", { instanceId: instance.id });
    res.json({ success: true });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

router.post("/instances/:id/kill", async (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  try {
    await bridgeFetch("POST", `/v1/instances/${instance.id}/kill`);
    instance.state = "stopped";
    instance.updatedAt = now();
    saveState(state);
    audit("instance.kill", { instanceId: instance.id, reason: req.body?.reason || "operator" });
    res.json({ success: true });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

router.delete("/instances/:id", async (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  if (instance.state !== "stopped") {
    try {
      await bridgeFetch("POST", `/v1/instances/${instance.id}/kill`);
    } catch {
      // Continue deleting local record even if runtime cleanup fails.
    }
  }

  state.instances = state.instances.filter((x) => x.id !== req.params.id);
  saveState(state);
  audit("instance.delete", { instanceId: req.params.id });
  return res.json({ success: true, deleted: req.params.id });
});

router.post("/instances/:id/drain", async (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  const enabled = Boolean(req.body?.enabled);

  try {
    await bridgeFetch("POST", `/v1/instances/${instance.id}/drain`, { enabled });
    instance.drain = enabled;
    instance.state = enabled ? "draining" : "ready";
    instance.updatedAt = now();
    saveState(state);
    audit("instance.drain", { instanceId: instance.id, enabled });
    res.json({ success: true, enabled });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

router.post("/instances/:id/model", (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  const model = req.body?.model;
  const applyMode = req.body?.applyMode || "next_restart";
  if (!model) return res.status(400).json({ error: "model is required" });

  const savedProfile = state.profiles.find((p) => p.id === instance.profileId);
  const profile = savedProfile || {
    id: null,
    name: instance.profileName || instance.id,
    runtime: cleanRuntime(instance.runtime),
    host: instance.host || "127.0.0.1",
    port: instance.port,
    gpus: Array.isArray(instance.gpus) ? instance.gpus : [],
    contextLength: parseContextLength(instance.contextLength)
  };

  const applySwitch = async () => {
    if (applyMode === "restart_now") {
      instance.state = "switching_model";
      instance.updatedAt = now();
      saveState(state);

      await bridgeFetch("POST", `/v1/instances/${instance.id}/stop`);
      const launch = await bridgeFetch("POST", "/v1/instances/start", {
        instanceId: instance.id,
        profile: {
          ...profile,
          model,
          maxInflightRequests: instance.maxInflightRequests || 4
        }
      });

      instance.effectiveModel = model;
      instance.pendingModel = null;
      instance.state = launch.state || "starting";
      instance.pid = launch.pid || null;
      instance.lastError = null;
      instance.updatedAt = now();
      saveState(state);
      audit("instance.model.switch", { instanceId: instance.id, model, applyMode });
      return res.json({ success: true, instance });
    }

    instance.pendingModel = model;
    instance.updatedAt = now();
    saveState(state);
    audit("instance.model.switch", { instanceId: instance.id, model, applyMode });
    return res.json({ success: true, instance });
  };

  applySwitch().catch((error) => {
    instance.state = "unhealthy";
    instance.lastError = String(error.message || error);
    instance.updatedAt = now();
    saveState(state);
    if (!res.headersSent) {
      res.status(502).json({ error: String(error.message || error) });
    }
  });
});

router.get("/instances/:id/logs", async (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  const lines = Number(req.query.lines || 200);
  try {
    const data = await bridgeFetch("GET", `/v1/instances/${instance.id}/logs?lines=${lines}`);
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

router.get("/manifest/ready", (_req, res) => {
  const data = state.instances
    .filter((x) => x.state === "ready" && !x.drain)
    .map((x) => ({
      instance_id: x.id,
      state: x.state,
      base_url: instancePublicBaseUrl(x),
      api_paths: {
        health: `${instancePublicBaseUrl(x)}/v1/models`,
        chat_completions: `${instancePublicBaseUrl(x)}/v1/chat/completions`,
        responses: `${instancePublicBaseUrl(x)}/v1/responses`
      },
      profile_model: null,
      effective_model: x.effectiveModel,
      pending_model: x.pendingModel || null,
      inflight_requests: x.inflightRequests,
      max_inflight_requests: x.maxInflightRequests,
      queue_depth: x.queueDepth,
      last_health_ok_at: x.lastHealthOkAt,
      last_error: x.lastError
    }));

  res.json({
    policy: {
      request_timeout_ms: 90000,
      retry_count: 2,
      retry_backoff_ms: 750,
      unhealthy_ejection_ms: 30000,
      over_capacity_behavior: "reject"
    },
    data
  });
});

router.get("/instances/:id/connection", (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  const apiBase = apiPublicBaseUrl();
  const base = instancePublicBaseUrl(instance);
  const runtimeBase = instanceBaseUrl(instance);
  const globalAuthRequired = isGlobalApiKeyRequired();
  const proxyBase = `${apiBase}/v1/instances/${encodeURIComponent(instance.id)}/proxy/v1`;
  res.json({
    instance_id: instance.id,
    base_url: base,
    runtime_base_url: runtimeBase,
    advertised_host: resolveAdvertisedHost(instance),
    global_auth: globalAuthRequired
      ? { type: "bearer", required: true, source: "control_plane" }
      : { type: "none", required: false },
    proxy_base_url: proxyBase,
    urls: {
      models: `${base}/v1/models`,
      chat_completions: `${base}/v1/chat/completions`,
      responses: `${base}/v1/responses`
    },
    proxy_urls: {
      models: `${proxyBase}/models`,
      chat_completions: `${proxyBase}/chat/completions`,
      responses: `${proxyBase}/responses`
    },
    profile_model: null,
    effective_model: instance.effectiveModel,
    pending_model: instance.pendingModel || null
  });
});

export default router;
