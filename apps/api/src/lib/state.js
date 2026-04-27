import fs from "fs";
import yaml from "js-yaml";
import { apiAuthEnabled, stateFile, sharedConfigFile } from "./config.js";
import { now } from "./utils.js";

export const defaultState = {
  profiles: [],
  instanceConfigs: [],
  instances: [],
  audit: [],
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
  next.users = Array.isArray(next.users) ? next.users : [];
  next.sessions = Array.isArray(next.sessions) ? next.sessions : [];
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

export function saveState(s) {
  const tmp = stateFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, stateFile);
  writeSharedConfig(s);
}

// Singleton — consumers import and mutate properties in-place.
export const state = loadState();
