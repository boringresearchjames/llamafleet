import express from "express";
import fs from "fs";
import { corsOrigin, port, webRoot } from "./lib/config.js";
import { auth } from "./lib/auth.js";
import { state, saveState } from "./lib/state.js";
import { instanceBaseUrl } from "./lib/urls.js";
import { now } from "./lib/utils.js";
import { audit } from "./lib/audit.js";
import { restorePartialDownloads } from "./lib/hub.js";

import healthRouter from "./routes/health.js";
import metricsRouter from "./routes/metrics.js";
import helpRouter from "./routes/help.js";
import authRouter from "./routes/auth.js";
import settingsRouter from "./routes/settings.js";
import instanceConfigsRouter from "./routes/instance-configs.js";
import profilesRouter from "./routes/profiles.js";
import instancesRouter from "./routes/instances.js";
import modelsRouter from "./routes/models.js";
import localModelsRouter from "./routes/local-models.js";
import hubRouter from "./routes/hub.js";
import systemRouter from "./routes/system.js";

const corsHeaders = "Authorization, Content-Type, X-Bridge-Token, X-HF-Token";

const app = express();
app.use(express.json({ limit: "50mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", corsOrigin);
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", corsHeaders);
  res.header("X-Content-Type-Options", "nosniff");
  res.header("X-Frame-Options", "DENY");
  res.header("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  return next();
});

// Public routes (no auth)
app.use(healthRouter);
app.use(metricsRouter);
app.use(helpRouter);
app.use(authRouter);

// Static web app
if (fs.existsSync(webRoot)) {
  app.use(express.static(webRoot));
}

// All /v1 routes require auth (applied before mounting v1 routers)
app.use("/v1", auth);

app.use("/v1", settingsRouter);
app.use("/v1", instanceConfigsRouter);
app.use("/v1", profilesRouter);
app.use("/v1", instancesRouter);
app.use("/v1", modelsRouter);
app.use("/v1", localModelsRouter);
app.use("/v1", hubRouter);
app.use("/v1", systemRouter);

// ---------------------------------------------------------------------------
// Periodic health polling
// ---------------------------------------------------------------------------

const HEALTH_POLL_INTERVAL_MS = 30_000;
const HEALTH_POLL_TIMEOUT_MS = 8_000;

async function pollInstanceHealth() {
  const targets = state.instances.filter(
    (x) => x.state !== "stopped" && x.state !== "starting" && x.state !== "switching_model"
  );
  let dirty = false;
  for (const inst of targets) {
    const url = `${instanceBaseUrl(inst)}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_POLL_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) {
        inst.lastHealthOkAt = now();
        if (inst.state === "unhealthy") {
          inst.state = "ready";
          inst.lastError = null;
          inst.updatedAt = now();
          dirty = true;
          audit("instance.health.recovered", { instanceId: inst.id });
        }
      } else {
        clearTimeout(timer);
        if (inst.state !== "unhealthy") {
          inst.state = "unhealthy";
          inst.lastError = `Health check returned HTTP ${resp.status}`;
          inst.updatedAt = now();
          dirty = true;
          audit("instance.health.fail", { instanceId: inst.id, status: resp.status });
        }
      }
    } catch (err) {
      clearTimeout(timer);
      if (inst.state !== "unhealthy" && inst.state !== "stopped") {
        inst.state = "unhealthy";
        inst.lastError = `Health check failed: ${String(err.message || err).slice(0, 200)}`;
        inst.updatedAt = now();
        dirty = true;
        audit("instance.health.fail", { instanceId: inst.id, error: inst.lastError });
      }
    }
  }
  if (dirty) {
    saveState(state);
  }
}

setInterval(() => { void pollInstanceHealth(); }, HEALTH_POLL_INTERVAL_MS);

restorePartialDownloads();

app.listen(port, () => {
  console.log(`lmlaunch api+web listening on ${port}`);
});
