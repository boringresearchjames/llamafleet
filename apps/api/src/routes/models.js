import express from "express";
import { state } from "../lib/state.js";
import { resolveModelName, resolveInstanceByModelName } from "../lib/routing.js";
import { instanceBaseUrl } from "../lib/urls.js";
import { proxyToInstance } from "../lib/proxy.js";

const router = express.Router();

router.get("/models", (_req, res) => {
  const running = state.instances.filter((x) => x.state !== "stopped" && !x.drain);

  // Group by base stem (strip trailing -N suffix from modelRouteName)
  const groups = new Map(); // baseStem -> { inst, routeName }[]
  for (const inst of running) {
    const routeName = inst.modelRouteName || resolveModelName(inst.effectiveModel) || inst.effectiveModel || inst.id;
    const baseStem = routeName.replace(/-\d+$/, "");
    if (!groups.has(baseStem)) groups.set(baseStem, []);
    groups.get(baseStem).push({ inst, routeName });
  }

  const data = [];
  for (const [baseStem, members] of groups) {
    if (members.length === 1) {
      const { inst, routeName } = members[0];
      data.push({
        id: routeName,
        object: "model",
        created: Math.floor((inst.startedAt ? new Date(inst.startedAt).getTime() : Date.now()) / 1000),
        owned_by: "llamafleet",
        instance_id: inst.id,
        profile_name: inst.profileName,
        effective_model: inst.effectiveModel,
        pool: false,
        instance_count: 1
      });
    } else {
      const first = members[0];
      data.push({
        id: baseStem,
        object: "model",
        created: Math.floor((first.inst.startedAt ? new Date(first.inst.startedAt).getTime() : Date.now()) / 1000),
        owned_by: "llamafleet",
        instance_id: null,
        profile_name: first.inst.profileName,
        effective_model: first.inst.effectiveModel,
        pool: true,
        instance_count: members.length
      });
      for (const { inst, routeName } of members) {
        const pinnedId = routeName === baseStem ? `${baseStem}-1` : routeName;
        data.push({
          id: pinnedId,
          object: "model",
          created: Math.floor((inst.startedAt ? new Date(inst.startedAt).getTime() : Date.now()) / 1000),
          owned_by: "llamafleet",
          instance_id: inst.id,
          profile_name: inst.profileName,
          effective_model: inst.effectiveModel,
          pool: false,
          instance_count: 1
        });
      }
    }
  }

  res.json({ object: "list", data });
});

router.post("/chat/completions", async (req, res) => {
  console.log(`[http] POST /v1/chat/completions body=${JSON.stringify(req.body)}`);
  const modelName = String(req.body?.model || "").trim();
  const resolved = resolveInstanceByModelName(modelName);
  if (resolved.error) {
    return res.status(resolved.status).json({
      error: {
        message: resolved.error,
        type: "invalid_request_error",
        param: "model",
        code: resolved.status === 404 ? "model_not_found" : "model_ambiguous",
        ...(resolved.instances ? { instances: resolved.instances } : {})
      }
    });
  }
  const queryIndex = String(req.originalUrl || "").indexOf("?");
  const query = queryIndex >= 0 ? String(req.originalUrl).slice(queryIndex) : "";
  return proxyToInstance(resolved.instance, req, res, `${instanceBaseUrl(resolved.instance)}/v1/chat/completions${query}`);
});

router.post("/completions", async (req, res) => {
  console.log(`[http] POST /v1/completions body=${JSON.stringify(req.body)}`);
  const modelName = String(req.body?.model || "").trim();
  const resolved = resolveInstanceByModelName(modelName);
  if (resolved.error) {
    return res.status(resolved.status).json({
      error: {
        message: resolved.error,
        type: "invalid_request_error",
        param: "model",
        code: resolved.status === 404 ? "model_not_found" : "model_ambiguous",
        ...(resolved.instances ? { instances: resolved.instances } : {})
      }
    });
  }
  const queryIndex = String(req.originalUrl || "").indexOf("?");
  const query = queryIndex >= 0 ? String(req.originalUrl).slice(queryIndex) : "";
  return proxyToInstance(resolved.instance, req, res, `${instanceBaseUrl(resolved.instance)}/v1/completions${query}`);
});

router.all("/instances/:id/proxy/*", async (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) {
    return res.status(404).json({ error: { message: "instance not found", type: "invalid_request_error", param: "id", code: "instance_not_found" } });
  }

  const tailPath = String(req.params[0] || "").replace(/^\/+/, "");
  if (!tailPath) {
    return res.status(400).json({ error: { message: "proxy path is required (e.g. /v1/chat/completions)", type: "invalid_request_error", param: null, code: null } });
  }

  const queryIndex = String(req.originalUrl || "").indexOf("?");
  const query = queryIndex >= 0 ? String(req.originalUrl).slice(queryIndex) : "";
  const targetUrl = `${instanceBaseUrl(instance)}/${tailPath}${query}`;
  return proxyToInstance(instance, req, res, targetUrl);
});

export default router;
