import express from "express";
import yaml from "js-yaml";
import { state, saveState } from "../lib/state.js";
import { requireAdminToken } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { now } from "../lib/utils.js";
import { bridgeFetch, localApi } from "../lib/bridge.js";
import {
  sanitizeInstanceConfigPayload,
  toInstanceConfigYamlDoc,
  currentInstanceTemplates
} from "../lib/instance-config.js";
import {
  parsePositiveInteger,
  parseOptionalPositiveInteger,
  parseRestartPolicy,
  toInstanceId,
  nextUniqueInstanceId
} from "../lib/parse.js";

const router = express.Router();

router.get("/instance-configs", (req, res) => {
  const data = (state.instanceConfigs || []).map((cfg) => ({
    id: cfg.id,
    name: cfg.name,
    instanceCount: Array.isArray(cfg.instances) ? cfg.instances.length : 0,
    createdAt: cfg.createdAt,
    updatedAt: cfg.updatedAt
  }));
  res.json({ data });
});

router.get("/instance-configs/:id", (req, res) => {
  const config = (state.instanceConfigs || []).find((x) => x.id === req.params.id);
  if (!config) return res.status(404).json({ error: "instance config not found" });
  res.json(config);
});

router.post("/instance-configs", (req, res) => {
  const payload = sanitizeInstanceConfigPayload(req.body || {});
  if (payload.instances.length === 0) {
    return res.status(400).json({ error: "config must contain at least one valid instance" });
  }

  const nowTs = now();
  const existingIndex = state.instanceConfigs.findIndex((x) => x.id === payload.id);
  const next = {
    ...payload,
    createdAt: existingIndex >= 0 ? state.instanceConfigs[existingIndex].createdAt : nowTs,
    updatedAt: nowTs
  };

  if (existingIndex >= 0) {
    state.instanceConfigs[existingIndex] = next;
  } else {
    state.instanceConfigs.unshift(next);
  }

  saveState(state);
  audit("instance_config.save", { id: next.id, name: next.name, instances: next.instances.length });
  return res.status(201).json(next);
});

// Must be registered before /:id/load to avoid "save-current" being captured as :id
router.post("/instance-configs/save-current", (req, res) => {
  const name = String(req.body?.name || "").trim() || `Config ${new Date().toLocaleString()}`;
  const id = String(req.body?.id || `cfg_${Date.now()}`).trim();
  const instances = currentInstanceTemplates();

  if (instances.length === 0) {
    return res.status(400).json({ error: "no instances available to save" });
  }

  const nowTs = now();
  const existingIndex = state.instanceConfigs.findIndex((x) => x.id === id);
  const next = {
    id,
    name,
    instances,
    createdAt: existingIndex >= 0 ? state.instanceConfigs[existingIndex].createdAt : nowTs,
    updatedAt: nowTs
  };

  if (existingIndex >= 0) {
    state.instanceConfigs[existingIndex] = next;
  } else {
    state.instanceConfigs.unshift(next);
  }

  saveState(state);
  audit("instance_config.save_current", { id: next.id, name: next.name, instances: next.instances.length });
  return res.status(201).json(next);
});

// Must be registered before /:id/export.yaml
router.get("/instance-configs/current/export.yaml", (req, res) => {
  const current = {
    id: "current",
    name: "Current Instances",
    instances: currentInstanceTemplates()
  };
  const doc = yaml.dump(toInstanceConfigYamlDoc(current), { noRefs: true, lineWidth: 120 });
  res.setHeader("content-type", "application/yaml");
  res.send(doc);
});

router.post(
  "/instance-configs/import.yaml",
  requireAdminToken,
  express.text({
    type: ["application/yaml", "text/yaml", "application/x-yaml", "text/plain"],
    limit: "2mb"
  }),
  (req, res) => {
    const raw = String(req.body || "");
    if (!raw.trim()) {
      return res.status(400).json({ error: "YAML body is required" });
    }
    let parsed;
    try {
      parsed = yaml.load(raw);
    } catch (error) {
      return res.status(400).json({ error: `Invalid YAML: ${String(error.message || error)}` });
    }
    if (!parsed || typeof parsed !== "object") {
      return res.status(400).json({ error: "YAML must be an object" });
    }
    const payload = sanitizeInstanceConfigPayload(parsed);
    if (payload.instances.length === 0) {
      return res.status(400).json({ error: "config must contain at least one valid instance" });
    }
    const nowTs = now();
    const existingIndex = state.instanceConfigs.findIndex((x) => x.id === payload.id);
    const next = {
      ...payload,
      createdAt: existingIndex >= 0 ? state.instanceConfigs[existingIndex].createdAt : nowTs,
      updatedAt: nowTs
    };
    if (existingIndex >= 0) {
      state.instanceConfigs[existingIndex] = next;
    } else {
      state.instanceConfigs.unshift(next);
    }
    saveState(state);
    audit("instance_config.import_yaml", { id: next.id, name: next.name, instances: next.instances.length });
    return res.status(201).json(next);
  }
);

router.get("/instance-configs/:id/export.yaml", (req, res) => {
  const config = state.instanceConfigs.find((x) => x.id === req.params.id);
  if (!config) return res.status(404).json({ error: "instance config not found" });
  const doc = yaml.dump(toInstanceConfigYamlDoc(config), { noRefs: true, lineWidth: 120 });
  res.setHeader("content-type", "application/yaml");
  res.send(doc);
});

router.delete("/instance-configs/:id", (req, res) => {
  const before = state.instanceConfigs.length;
  state.instanceConfigs = state.instanceConfigs.filter((x) => x.id !== req.params.id);
  if (state.instanceConfigs.length === before) {
    return res.status(404).json({ error: "instance config not found" });
  }
  saveState(state);
  audit("instance_config.delete", { id: req.params.id });
  return res.json({ success: true });
});

router.post("/instance-configs/:id/load", async (req, res) => {
  const config = state.instanceConfigs.find((x) => x.id === req.params.id);
  if (!config) return res.status(404).json({ error: "instance config not found" });

  const replaceExisting = req.body?.replaceExisting !== false;
  const started = [];
  const failed = [];
  const reservedIds = new Set(state.instances.map((x) => String(x.id)));

  if (replaceExisting) {
    for (const inst of [...state.instances]) {
      if (inst.state !== "stopped") {
        try {
          await bridgeFetch("POST", `/v1/instances/${inst.id}/kill`, { reason: "load_config_replace" });
        } catch {
          // Continue best effort.
        }
      }
    }
    state.instances = [];
    saveState(state);
  }

  for (let i = 0; i < config.instances.length; i += 1) {
    const item = config.instances[i];
    try {
      const requestedInstanceId = nextUniqueInstanceId(toInstanceId(item.name), reservedIds);
      reservedIds.add(requestedInstanceId);
      const payload = {
        name: item.name,
        host: item.host,
        bindHost: item.bindHost || "0.0.0.0",
        port: item.port,
        model: item.model,
        gpus: Array.isArray(item.gpus) ? item.gpus : [],
        maxInflightRequests: Number(item.maxInflightRequests || 4),
        queueLimit: parsePositiveInteger(item.queueLimit, 64, 1, 100000),
        modelTtlSeconds: parseOptionalPositiveInteger(item.modelTtlSeconds),
        modelParallel: parseOptionalPositiveInteger(item.modelParallel),
        restartPolicy: parseRestartPolicy(item.restartPolicy),
        runtimeBackend: item.runtime?.hardware || "auto",
        runtimeArgs: Array.isArray(item.runtime?.serverArgs) && item.runtime.serverArgs.length > 0
          ? item.runtime.serverArgs
          : ["--port", "{port}"],
        contextLength: item.contextLength ?? "auto",
        instanceId: requestedInstanceId
      };

      const startedInstance = await localApi("POST", "/v1/instances/start", payload);
      started.push({ name: item.name, instanceId: startedInstance.id, port: startedInstance.port });
    } catch (error) {
      failed.push({ name: item.name, error: String(error.message || error) });
    }
  }

  audit("instance_config.load", {
    id: config.id,
    started: started.length,
    failed: failed.length,
    replaceExisting
  });

  return res.json({
    success: true,
    configId: config.id,
    configName: config.name,
    replaceExisting,
    started,
    failed
  });
});

export default router;
