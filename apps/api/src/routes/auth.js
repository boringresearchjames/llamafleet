import express from "express";
import { state, saveState } from "../lib/state.js";
import { getBearerToken, verifyPassword, createSession } from "../lib/auth.js";
import { audit } from "../lib/audit.js";

const router = express.Router();

router.post("/auth/login", (req, res) => {
  if (!state.settings.security.auth.enabled) {
    return res.status(403).json({ error: "User auth is disabled" });
  }

  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  const user = state.users.find((u) => u.username === username && !u.disabled);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const session = createSession(username);
  audit("auth.login", { username });
  return res.json({
    token: session.token,
    tokenType: "Bearer",
    expiresAt: session.expiresAt,
    username
  });
});

router.post("/auth/logout", (req, res) => {
  const token = getBearerToken(req);
  if (!token) return res.status(400).json({ error: "Bearer token required" });

  const before = state.sessions.length;
  state.sessions = state.sessions.filter((s) => s.token !== token);
  saveState(state);
  if (before !== state.sessions.length) {
    audit("auth.logout", {});
  }
  return res.json({ success: true });
});

export default router;
