import fs from "fs";
import yaml from "js-yaml";
import { apiAuthEnabled, stateFile, sharedConfigFile } from "./config.js";
import { now } from "./utils.js";

export const defaultState = {
  profiles: [],
  instanceConfigs: [],
  instances: [],
  audit: [],
  orchestrationRoutes: [],
  frontierBackends: [],
  modelDefaults: [],
  settings: {
    security: {
      api: { requireApiKey: true },
      tls: { enabled: false, certFile: "", keyFile: "", caFile: "" },
      auth: { enabled: false, sessionTtlMinutes: 720 }
    },
    configSync: {
      lastImportedAt: null,
      lastImportedHash: "",
      lastDryRunAt: null,
      lastDryRunHash: ""
    },
    compression: {
      enabled: false,
      maxLogLines: 120,
      maxJsonArrayItems: 24,
      maxCodeLines: 200,
      codeHeadLines: 60,
      codeTailLines: 40,
      maxSearchResults: 12,
      compressDiffs: true,
      stripHtml: true
    }
  },
  users: [],
  sessions: []
};

function migrateState(raw) {
  const next = raw || {};
  next.profiles = Array.isArray(next.profiles) ? next.profiles : [];
  next.instanceConfigs = Array.isArray(next.instanceConfigs) ? next.instanceConfigs : [];
  next.instances = Array.isArray(next.instances) ? next.instances : [];
  next.audit = Array.isArray(next.audit) ? next.audit : [];
  next.settings = next.settings || {};
  next.settings.security = next.settings.security || {};
  next.settings.security.api = {
    requireApiKey: apiAuthEnabled
      ? next.settings.security.api?.requireApiKey !== false
      : false
  };
  next.settings.security.tls = {
    enabled: Boolean(next.settings.security.tls?.enabled),
    certFile: next.settings.security.tls?.certFile || "",
    keyFile: next.settings.security.tls?.keyFile || "",
    caFile: next.settings.security.tls?.caFile || ""
  };
  next.settings.security.auth = {
    enabled: Boolean(next.settings.security.auth?.enabled),
    sessionTtlMinutes: Number(next.settings.security.auth?.sessionTtlMinutes || 720)
  };
  next.settings.configSync = {
    lastImportedAt: next.settings.configSync?.lastImportedAt || null,
    lastImportedHash: next.settings.configSync?.lastImportedHash || "",
    lastDryRunAt: next.settings.configSync?.lastDryRunAt || null,
    lastDryRunHash: next.settings.configSync?.lastDryRunHash || ""
  };
  const c = next.settings.compression || {};
  next.settings.compression = {
    enabled: typeof c.enabled === "boolean" ? c.enabled : false,
    maxLogLines: Number(c.maxLogLines) > 0 ? Number(c.maxLogLines) : 120,
    maxJsonArrayItems: Number(c.maxJsonArrayItems) > 0 ? Number(c.maxJsonArrayItems) : 24,
    maxCodeLines: Number(c.maxCodeLines) > 0 ? Number(c.maxCodeLines) : 200,
    codeHeadLines: Number(c.codeHeadLines) > 0 ? Number(c.codeHeadLines) : 60,
    codeTailLines: Number(c.codeTailLines) > 0 ? Number(c.codeTailLines) : 40,
    maxSearchResults: Number(c.maxSearchResults) > 0 ? Number(c.maxSearchResults) : 12,
    compressDiffs: typeof c.compressDiffs === "boolean" ? c.compressDiffs : true,
    stripHtml: typeof c.stripHtml === "boolean" ? c.stripHtml : true
  };
  next.users = Array.isArray(next.users) ? next.users : [];
  next.sessions = Array.isArray(next.sessions) ? next.sessions : [];
  next.orchestrationRoutes = Array.isArray(next.orchestrationRoutes) ? next.orchestrationRoutes : [];
  next.frontierBackends = Array.isArray(next.frontierBackends) ? next.frontierBackends : [];
  next.modelDefaults = Array.isArray(next.modelDefaults) ? next.modelDefaults : [];
  // On startup, any instance stuck in a transient state with no PID is
  // orphaned (the bridge process died). Reset to stopped so Wake works.
  next.instances = next.instances.map(inst => {
    if (!inst || inst.pid != null) return inst;
    if (["warming", "starting", "unhealthy"].includes(inst.state)) {
      return { ...inst, state: "stopped", pid: null, lastError: null };
    }
    return inst;
  });
  return next;
}

export function loadState() {
  try {
    if (!fs.existsSync(stateFile)) {
      fs.writeFileSync(stateFile, JSON.stringify(defaultState, null, 2));
      return structuredClone(defaultState);
    }
    return migrateState(JSON.parse(fs.readFileSync(stateFile, "utf8")));
  } catch {
    return structuredClone(defaultState);
  }
}

export function toSharedConfig(s) {
  return {
    version: "1",
    generatedAt: now(),
    note: "Shareable config. Secrets, password hashes, and session tokens are excluded.",
    settings: { security: s.settings?.security || defaultState.settings.security },
    profiles: s.profiles || [],
    orchestrationRoutes: s.orchestrationRoutes || [],
    frontierBackends: (s.frontierBackends || []).map(({ apiKey: _omit, ...rest }) => rest),
    users: (s.users || []).map((u) => ({ username: u.username, disabled: Boolean(u.disabled) }))
  };
}

export function writeSharedConfig(s) {
  try {
    const doc = yaml.dump(toSharedConfig(s), { noRefs: true, lineWidth: 120 });
    fs.writeFileSync(sharedConfigFile, doc);
  } catch {
    // Keep state write resilient even if yaml export fails.
  }
}

// Coalesce saveState calls so that bursts of mutations within a single tick
// (e.g. many small updates from one handler, or several handlers resuming at
// the same await boundary) result in one actual disk write instead of N.
let saveScheduled = false;

function writeStateNow(s) {
  const tmp = stateFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, stateFile);
  writeSharedConfig(s);
}

export function saveState(s) {
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(() => {
    saveScheduled = false;
    try {
      writeStateNow(s);
    } catch (err) {
      console.error("[state] saveState failed:", err.message || err);
    }
  });
}

// Force an immediate synchronous flush — used at shutdown or where the caller
// must observe the write before returning (e.g. tests).
export function saveStateSync(s) {
  saveScheduled = false;
  writeStateNow(s);
}

// Singleton — consumers import and mutate properties in-place.
export const state = loadState();
