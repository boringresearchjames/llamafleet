import crypto from "crypto";
import { apiToken, apiAuthEnabled } from "./config.js";
import { state, saveState } from "./state.js";
import { now } from "./utils.js";

export function isGlobalApiKeyRequired() {
  return apiAuthEnabled && state.settings?.security?.api?.requireApiKey !== false;
}

export function getBearerToken(req) {
  const header = req.header("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

export function timingSafeEqual(a, b) {
  try {
    const ab = Buffer.from(String(a || ""));
    const bb = Buffer.from(String(b || ""));
    if (ab.length !== bb.length) {
      crypto.timingSafeEqual(ab, ab);
      return false;
    }
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${digest}`;
}

export function verifyPassword(password, encoded) {
  const [salt, expected] = String(encoded || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export function createSession(username) {
  const token = crypto.randomBytes(32).toString("hex");
  const ttlMinutes = Number(state.settings.security.auth.sessionTtlMinutes || 720);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  const session = { token, username, createdAt: now(), expiresAt, lastUsedAt: now() };
  state.sessions.push(session);
  state.sessions = state.sessions.slice(-1000);
  saveState(state);
  return session;
}

export function cleanupSessions() {
  const nowTs = Date.now();
  state.sessions = state.sessions.filter((s) => new Date(s.expiresAt).getTime() > nowTs);
}

export function auth(req, res, next) {
  if (!isGlobalApiKeyRequired()) return next();

  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  if (!timingSafeEqual(token, apiToken)) {
    if (!state.settings.security.auth.enabled) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    cleanupSessions();
    const session = state.sessions.find((s) => timingSafeEqual(s.token, token));
    if (!session) return res.status(401).json({ error: "Unauthorized" });
    session.lastUsedAt = now();
    saveState(state);
  }

  return next();
}

export function requireAdminToken(req, res, next) {
  if (!isGlobalApiKeyRequired()) return next();
  const token = getBearerToken(req);
  if (!timingSafeEqual(token, apiToken)) {
    return res.status(403).json({ error: "Admin token required" });
  }
  return next();
}
