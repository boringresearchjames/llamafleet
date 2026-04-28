import crypto from "crypto";
import yaml from "js-yaml";
import { apiAuthEnabled } from "./config.js";
import { state } from "./state.js";
import { now } from "./utils.js";
import {
  parseContextLength,
  parseOptionalPositiveInteger,
  parsePositiveInteger,
  parseRestartPolicy,
  cleanRuntime
} from "./parse.js";

export function currentInstanceTemplates() {
  return (state.instances || []).map((inst) => ({
    name: String(inst.profileName || inst.id || "instance").trim() || "instance",
    host: String(inst.host || "127.0.0.1"),
    bindHost: String(inst.bindHost || "0.0.0.0"),
    port: Number(inst.port || 1234),
    model: String(inst.effectiveModel || inst.pendingModel || "").trim(),
    gpus: Array.isArray(inst.gpus) ? inst.gpus.map((g) => String(g)) : [],
    runtime: cleanRuntime(inst.runtime),
    contextLength: parseContextLength(inst.contextLength),
    maxInflightRequests: Number(inst.maxInflightRequests || 4),
    queueLimit: parsePositiveInteger(inst.queueLimit, 64, 1, 100000),
    modelTtlSeconds: parseOptionalPositiveInteger(inst.modelTtlSeconds),
    modelParallel: parseOptionalPositiveInteger(inst.modelParallel),
    headersTimeoutMs: parseOptionalPositiveInteger(inst.headersTimeoutMs),
    restartPolicy: parseRestartPolicy(inst.restartPolicy)
  }));
}

export function sanitizeInstanceConfigPayload(raw = {}) {
  const id = String(raw.id || `cfg_${Date.now()}`).trim();
  const name = String(raw.name || "Untitled Config").trim() || "Untitled Config";
  const instances = Array.isArray(raw.instances) ? raw.instances : [];

  const cleaned = instances.map((inst, index) => {
    const model = String(inst?.model || "").trim();
    const port = Number(inst?.port);
    if (!model || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
      name: String(inst?.name || `instance-${index + 1}`).trim() || `instance-${index + 1}`,
      host: String(inst?.host || "127.0.0.1"),
      bindHost: String(inst?.bindHost || "0.0.0.0"),
      port,
      model,
      gpus: Array.isArray(inst?.gpus) ? inst.gpus.map((g) => String(g)) : [],
      runtime: cleanRuntime(inst?.runtime),
      contextLength: parseContextLength(inst?.contextLength),
      maxInflightRequests: parsePositiveInteger(inst?.maxInflightRequests, 4, 1, 1024),
      queueLimit: parsePositiveInteger(inst?.queueLimit, 64, 1, 100000),
      modelTtlSeconds: parseOptionalPositiveInteger(inst?.modelTtlSeconds),
      modelParallel: parseOptionalPositiveInteger(inst?.modelParallel),      headersTimeoutMs: parseOptionalPositiveInteger(inst.headersTimeoutMs),      restartPolicy: parseRestartPolicy(inst?.restartPolicy)
    };
  }).filter(Boolean);

  return { id, name, instances: cleaned };
}

export function toInstanceConfigYamlDoc(config) {
  return {
    version: "1",
    kind: "lmlaunch-instance-config",
    generatedAt: now(),
    id: config.id,
    name: config.name,
    instances: config.instances
  };
}

export function configHash(rawYaml) {
  return crypto.createHash("sha256").update(String(rawYaml || "")).digest("hex");
}

export function validateSharedConfig(doc) {
  const errors = [];
  const warnings = [];

  if (!doc || typeof doc !== "object") {
    return { errors: ["config must be a YAML object"], warnings, normalized: null };
  }

  const normalized = {
    settings: {
      security: {
        api: { requireApiKey: apiAuthEnabled },
        tls: { enabled: false, certFile: "", keyFile: "", caFile: "" },
        auth: { enabled: false, sessionTtlMinutes: 720 }
      }
    },
    profiles: [],
    users: []
  };

  if (doc.version && String(doc.version) !== "1") {
    warnings.push("config version is not '1'; proceeding with best-effort import");
  }

  const security = doc.settings?.security;
  if (security) {
    const requireApiKey = Boolean(security.api?.requireApiKey);
    if (requireApiKey && !apiAuthEnabled) {
      warnings.push("settings.security.api.requireApiKey ignored because API_AUTH_TOKEN is not configured");
      normalized.settings.security.api.requireApiKey = false;
    } else {
      normalized.settings.security.api.requireApiKey = requireApiKey;
    }
    normalized.settings.security.tls.enabled = Boolean(security.tls?.enabled);
    normalized.settings.security.tls.certFile = String(security.tls?.certFile || "");
    normalized.settings.security.tls.keyFile = String(security.tls?.keyFile || "");
    normalized.settings.security.tls.caFile = String(security.tls?.caFile || "");

    const ttl = Number(security.auth?.sessionTtlMinutes || 720);
    if (!Number.isFinite(ttl) || ttl < 5 || ttl > 10080) {
      errors.push("settings.security.auth.sessionTtlMinutes must be between 5 and 10080");
    } else {
      normalized.settings.security.auth.sessionTtlMinutes = ttl;
    }
    normalized.settings.security.auth.enabled = Boolean(security.auth?.enabled);
  }

  const profiles = Array.isArray(doc.profiles) ? doc.profiles : [];
  for (const raw of profiles) {
    const name = String(raw?.name || "").trim();
    if (!name) { errors.push("each profile must include non-empty name"); continue; }
    const port = Number(raw?.port || 1234);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`profile '${name}' has invalid port`); continue;
    }
    normalized.profiles.push({
      id: String(raw?.id || `prof_${Date.now()}_${Math.floor(Math.random() * 1000)}`),
      name,
      runtime: { serverArgs: ["--port", "{port}"] },
      gpus: Array.isArray(raw?.gpus) ? raw.gpus.map((x) => String(x)) : [],
      host: String(raw?.host || "127.0.0.1"),
      port,
      contextLength: Number(raw?.contextLength || 8192),
      startupTimeoutMs: Number(raw?.startupTimeoutMs || 180000),
      queueLimit: Number(raw?.queueLimit || 64)
    });
  }

  const users = Array.isArray(doc.users) ? doc.users : [];
  for (const raw of users) {
    const username = String(raw?.username || "").trim();
    if (!username) { warnings.push("skipping user entry without username"); continue; }
    normalized.users.push({ username, disabled: Boolean(raw?.disabled) });
  }

  return { errors, warnings, normalized };
}
