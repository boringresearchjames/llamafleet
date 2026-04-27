import express from "express";
import yaml from "js-yaml";
import { apiAuthEnabled } from "../lib/config.js";
import { state, saveState, toSharedConfig } from "../lib/state.js";
import { requireAdminToken } from "../lib/auth.js";
import { hashPassword } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { now } from "../lib/utils.js";
import { configHash, validateSharedConfig } from "../lib/instance-config.js";

const router = express.Router();

// ── Security settings ────────────────────────────────────────────────────────

router.get("/settings/security", requireAdminToken, (_req, res) => {
  res.json(state.settings.security);
});

router.put("/settings/security", requireAdminToken, (req, res) => {
  const payload = req.body || {};

  if (payload.tls) {
    state.settings.security.tls.enabled = Boolean(payload.tls.enabled);
    state.settings.security.tls.certFile = String(payload.tls.certFile || "");
    state.settings.security.tls.keyFile = String(payload.tls.keyFile || "");
    state.settings.security.tls.caFile = String(payload.tls.caFile || "");
  }

  if (payload.auth) {
    state.settings.security.auth.enabled = Boolean(payload.auth.enabled);
    state.settings.security.auth.sessionTtlMinutes = Number(payload.auth.sessionTtlMinutes || 720);
  }

  if (payload.api) {
    const wantRequire = Boolean(payload.api.requireApiKey);
    if (wantRequire && !apiAuthEnabled) {
      return res.status(400).json({
        error: "Cannot require API key when API_AUTH_TOKEN is not configured"
      });
    }
    state.settings.security.api.requireApiKey = wantRequire;
  }

  saveState(state);
  audit("settings.security.update", {});
  return res.json(state.settings.security);
});

// ── Config export / import / status ─────────────────────────────────────────

router.get("/config/export.yaml", requireAdminToken, (_req, res) => {
  const doc = yaml.dump(toSharedConfig(state), { noRefs: true, lineWidth: 120 });
  res.setHeader("content-type", "application/yaml");
  res.send(doc);
});

router.get("/config/status", requireAdminToken, (_req, res) => {
  const snapshot = yaml.dump(toSharedConfig(state), { noRefs: true, lineWidth: 120 });
  res.json({
    currentExportHash: configHash(snapshot),
    ...state.settings.configSync
  });
});

router.post(
  "/config/import.yaml",
  requireAdminToken,
  express.text({
    type: ["application/yaml", "text/yaml", "application/x-yaml", "text/plain"],
    limit: "2mb"
  }),
  (req, res) => {
    const dryRun = String(req.query.dryRun || "false") === "true";
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

    const result = validateSharedConfig(parsed);
    const importHash = configHash(raw);
    if (result.errors.length > 0) {
      return res.status(400).json({
        success: false,
        dryRun,
        errors: result.errors,
        warnings: result.warnings
      });
    }

    if (!dryRun) {
      state.settings.security = result.normalized.settings.security;

      const nowTs = now();
      state.profiles = result.normalized.profiles.map((p) => {
        const existing = state.profiles.find((x) => x.id === p.id);
        return {
          ...p,
          createdAt: existing?.createdAt || nowTs,
          updatedAt: nowTs
        };
      });

      const userMap = new Map(state.users.map((u) => [u.username, u]));
      for (const u of result.normalized.users) {
        const existing = userMap.get(u.username);
        if (existing) {
          existing.disabled = u.disabled;
          existing.updatedAt = nowTs;
        } else {
          result.warnings.push(`user '${u.username}' not present locally; skipped (no password hash in shared YAML)`);
        }
      }

      state.settings.configSync.lastImportedAt = now();
      state.settings.configSync.lastImportedHash = importHash;
      audit("config.import.yaml", {
        profiles: state.profiles.length,
        usersProcessed: result.normalized.users.length,
        dryRun: false
      });
      saveState(state);
    } else {
      state.settings.configSync.lastDryRunAt = now();
      state.settings.configSync.lastDryRunHash = importHash;
      saveState(state);
    }

    return res.json({
      success: true,
      dryRun,
      applied: !dryRun,
      warnings: result.warnings,
      summary: {
        profiles: result.normalized.profiles.length,
        users: result.normalized.users.length,
        security: true
      }
    });
  }
);

// ── Users ────────────────────────────────────────────────────────────────────

router.get("/users", requireAdminToken, (_req, res) => {
  const users = state.users.map((u) => ({
    username: u.username,
    disabled: Boolean(u.disabled),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt
  }));
  res.json({ data: users });
});

router.post("/users", requireAdminToken, (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) {
    return res.status(400).json({ error: "username must be 3-64 chars [a-zA-Z0-9_.-]" });
  }
  if (password.length < 12) {
    return res.status(400).json({ error: "password must be at least 12 characters" });
  }

  const existing = state.users.find((u) => u.username === username);
  const passwordHash = hashPassword(password);
  if (existing) {
    existing.passwordHash = passwordHash;
    existing.disabled = false;
    existing.updatedAt = now();
  } else {
    state.users.push({
      username,
      passwordHash,
      disabled: false,
      createdAt: now(),
      updatedAt: now()
    });
  }

  saveState(state);
  audit("user.upsert", { username });
  return res.status(201).json({ success: true, username });
});

router.delete("/users/:username", requireAdminToken, (req, res) => {
  const username = req.params.username;
  const before = state.users.length;
  state.users = state.users.filter((u) => u.username !== username);
  state.sessions = state.sessions.filter((s) => s.username !== username);
  saveState(state);

  if (state.users.length === before) {
    return res.status(404).json({ error: "user not found" });
  }

  audit("user.delete", { username });
  return res.json({ success: true });
});

export default router;
