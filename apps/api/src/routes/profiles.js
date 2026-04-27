import express from "express";
import { state, saveState } from "../lib/state.js";
import { audit } from "../lib/audit.js";
import { now } from "../lib/utils.js";

const router = express.Router();

router.get("/profiles", (_req, res) => {
  res.json({ data: state.profiles });
});

router.post("/profiles", (req, res) => {
  const payload = req.body || {};
  if (!payload.name) {
    return res.status(400).json({ error: "name is required" });
  }

  const id = payload.id || `prof_${Date.now()}`;
  const profile = {
    id,
    name: payload.name,
    runtime: {
      serverArgs: ["--port", "{port}"]
    },
    gpus: Array.isArray(payload.gpus) ? payload.gpus : [],
    host: payload.host || "127.0.0.1",
    port: Number(payload.port || 1234),
    contextLength: Number(payload.contextLength || 8192),
    startupTimeoutMs: Number(payload.startupTimeoutMs || 180000),
    queueLimit: Number(payload.queueLimit || 64),
    createdAt: now(),
    updatedAt: now()
  };

  const existing = state.profiles.findIndex((p) => p.id === id);
  if (existing >= 0) {
    profile.createdAt = state.profiles[existing].createdAt;
    state.profiles[existing] = profile;
  } else {
    state.profiles.push(profile);
  }

  saveState(state);
  audit("profile.upsert", { id: profile.id, name: profile.name });
  return res.status(201).json(profile);
});

router.delete("/profiles/:id", (req, res) => {
  state.profiles = state.profiles.filter((p) => p.id !== req.params.id);
  saveState(state);
  audit("profile.delete", { id: req.params.id });
  res.json({ success: true });
});

export default router;
