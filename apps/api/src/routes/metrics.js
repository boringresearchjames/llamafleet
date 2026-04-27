import express from "express";
import { state } from "../lib/state.js";
import { resolveModelName } from "../lib/routing.js";
import { auth } from "../lib/auth.js";

const router = express.Router();

router.get("/metrics", auth, (_req, res) => {
  const lines = [];
  lines.push("# HELP llamafleet_instance_up Instance is running (1) or stopped (0)");
  lines.push("# TYPE llamafleet_instance_up gauge");
  lines.push("# HELP llamafleet_instance_healthy Instance last health check passed (1) or failed/unknown (0)");
  lines.push("# TYPE llamafleet_instance_healthy gauge");
  lines.push("# HELP llamafleet_instance_inflight_requests Current inflight request count");
  lines.push("# TYPE llamafleet_instance_inflight_requests gauge");
  lines.push("# HELP llamafleet_instance_queue_depth Current request queue depth");
  lines.push("# TYPE llamafleet_instance_queue_depth gauge");
  lines.push("# HELP llamafleet_instance_completed_requests_total Total completed requests");
  lines.push("# TYPE llamafleet_instance_completed_requests_total counter");
  lines.push("# HELP llamafleet_instance_prompt_tokens_total Total prompt tokens processed");
  lines.push("# TYPE llamafleet_instance_prompt_tokens_total counter");
  lines.push("# HELP llamafleet_instance_completion_tokens_total Total completion tokens generated");
  lines.push("# TYPE llamafleet_instance_completion_tokens_total counter");

  for (const inst of state.instances) {
    const safeId = String(inst.id || "").replace(/"/g, "");
    const safeName = String(inst.profileName || "").replace(/"/g, "");
    const safeModel = String(resolveModelName(inst.effectiveModel) || inst.effectiveModel || "").replace(/"/g, "");
    const labels = `instance_id="${safeId}",profile_name="${safeName}",model="${safeModel}"`;
    const isUp = inst.state !== "stopped" ? 1 : 0;
    const isHealthy = (inst.state === "ready" || inst.state === "running") ? 1 : 0;
    lines.push(`llamafleet_instance_up{${labels}} ${isUp}`);
    lines.push(`llamafleet_instance_healthy{${labels}} ${isHealthy}`);
    lines.push(`llamafleet_instance_inflight_requests{${labels}} ${Number(inst.inflightRequests || 0)}`);
    lines.push(`llamafleet_instance_queue_depth{${labels}} ${Number(inst.queueDepth || 0)}`);
    lines.push(`llamafleet_instance_completed_requests_total{${labels}} ${Number(inst.completedRequests || 0)}`);
    lines.push(`llamafleet_instance_prompt_tokens_total{${labels}} ${Number(inst.totalPromptTokens || 0)}`);
    lines.push(`llamafleet_instance_completion_tokens_total{${labels}} ${Number(inst.totalCompletionTokens || 0)}`);
  }

  const seenGpus = new Map();
  for (const inst of state.instances) {
    if (!Array.isArray(inst.gpuStats)) continue;
    for (const gpu of inst.gpuStats) {
      if (!seenGpus.has(String(gpu.id))) seenGpus.set(String(gpu.id), gpu);
    }
  }
  if (seenGpus.size > 0) {
    lines.push("# HELP llamafleet_gpu_memory_used_mib GPU VRAM used (MiB)");
    lines.push("# TYPE llamafleet_gpu_memory_used_mib gauge");
    lines.push("# HELP llamafleet_gpu_memory_total_mib GPU VRAM total (MiB)");
    lines.push("# TYPE llamafleet_gpu_memory_total_mib gauge");
    lines.push("# HELP llamafleet_gpu_utilization_percent GPU utilization (%)");
    lines.push("# TYPE llamafleet_gpu_utilization_percent gauge");
    lines.push("# HELP llamafleet_gpu_temperature_celsius GPU temperature (°C)");
    lines.push("# TYPE llamafleet_gpu_temperature_celsius gauge");
    for (const [, gpu] of seenGpus) {
      const gpuLabels = `gpu_id="${String(gpu.id).replace(/"/g, "")}",gpu_name="${String(gpu.name || "").replace(/"/g, "")}"`;
      if (gpu.memory_used_mib != null) lines.push(`llamafleet_gpu_memory_used_mib{${gpuLabels}} ${gpu.memory_used_mib}`);
      if (gpu.memory_total_mib != null) lines.push(`llamafleet_gpu_memory_total_mib{${gpuLabels}} ${gpu.memory_total_mib}`);
      if (gpu.utilization_percent != null) lines.push(`llamafleet_gpu_utilization_percent{${gpuLabels}} ${gpu.utilization_percent}`);
      if (gpu.temperature_c != null) lines.push(`llamafleet_gpu_temperature_celsius{${gpuLabels}} ${gpu.temperature_c}`);
    }
  }

  res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(lines.join("\n") + "\n");
});

export default router;
