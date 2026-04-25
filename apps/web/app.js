const settings = {
  apiBase: window.location.origin,
  token: localStorage.getItem("apiToken") || ""
};

let instancesCache = [];
let gpuTelemetryCache = [];
let runtimeBackendsCache = [];
let launchPending = null;
let launchStatusTimer = null;

const $ = (id) => document.getElementById(id);

function toast(msg) {
  $("toast").textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
}

function setLaunchPending(info) {
  launchPending = info;
  const statusEl = $("launchStatus");
  const startBtn = $("launchInstance");

  if (!launchPending) {
    statusEl.textContent = "Idle";
    startBtn.disabled = false;
    startBtn.textContent = "Start";
    if (launchStatusTimer) {
      clearInterval(launchStatusTimer);
      launchStatusTimer = null;
    }
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = "Starting...";

  const render = () => {
    const elapsedMs = Date.now() - launchPending.startedAt;
    const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));
    statusEl.textContent = `Starting ${launchPending.name} on ${launchPending.host}:${launchPending.port} (${elapsedSec}s)`;
  };

  render();
  if (launchStatusTimer) {
    clearInterval(launchStatusTimer);
  }
  launchStatusTimer = setInterval(render, 500);
}

function stateChipHtml(state) {
  const normalized = String(state || "unknown").toLowerCase();
  const showLoader = normalized === "starting" || normalized === "warming" || normalized === "switching_model";
  const safeText = escapeHtml(state || "unknown");
  if (!showLoader) {
    return safeText;
  }
  return `<span class="state-chip state-${normalized}"><span class="state-loader"></span>${safeText}</span>`;
}

async function api(path, options = {}) {
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {})
  };

  if (settings.token) {
    headers.authorization = `Bearer ${settings.token}`;
  }

  const response = await fetch(`${settings.apiBase}${path}`, {
    ...options,
    headers
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(data.error || text || `HTTP ${response.status}`);
  }

  return data;
}

function copy(value) {
  navigator.clipboard.writeText(value);
  toast(`Copied: ${value}`);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseContextLengthInput() {
  const preset = $("launchContextPreset").value;
  if (preset === "auto") {
    return "auto";
  }
  if (preset === "custom") {
    const custom = Number($("launchContextCustom").value);
    if (!Number.isInteger(custom) || custom < 256) {
      throw new Error("Custom context must be an integer >= 256");
    }
    return custom;
  }

  const presetValue = Number(preset);
  if (!Number.isInteger(presetValue) || presetValue < 256) {
    throw new Error("Invalid context preset selected");
  }
  return presetValue;
}

function normalizeRuntimeBackend(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (raw === "valkun") return "vulkan";
  if (["auto", "cuda", "cpu", "vulkan"].includes(raw)) return raw;
  return "auto";
}

function runtimeBackendUsesGpu(value) {
  return normalizeRuntimeBackend(value) !== "cpu";
}

function applyRuntimeBackendUi() {
  const backend = normalizeRuntimeBackend($("launchRuntimeBackend").value);
  const gpuSelect = $("launchGpus");
  const usesGpu = runtimeBackendUsesGpu(backend);
  gpuSelect.disabled = !usesGpu;
  if (!usesGpu) {
    Array.from(gpuSelect.options).forEach((opt) => {
      opt.selected = false;
      opt.disabled = true;
    });
    return;
  }

  Array.from(gpuSelect.options).forEach((opt) => {
    opt.disabled = false;
  });
  applyGpuAvailability();
}

async function loadRuntimeBackends({ silent = true } = {}) {
  const select = $("launchRuntimeBackend");
  const detail = $("launchRuntimeDetail");
  const current = normalizeRuntimeBackend(select.value || "auto");

  try {
    const payload = await api("/v1/system/runtime-backends");
    const options = Array.isArray(payload?.gguf_runtimes) && payload.gguf_runtimes.length > 0
      ? payload.gguf_runtimes
      : (Array.isArray(payload?.data) ? payload.data : []);
    runtimeBackendsCache = options;

    select.innerHTML = "";
    options.forEach((item) => {
      const value = normalizeRuntimeBackend(item.id);
      const option = document.createElement("option");
      option.value = value;
      const versionText = item.version ? ` v${item.version}` : "";
      option.textContent = `${item.label || value}${versionText}`;
      option.disabled = item.available === false;
      option.dataset.selectionId = item.id || value;
      option.dataset.runtimeLabel = item.label || value;
      option.dataset.detail = item.detail || "";
      select.appendChild(option);
    });

    if (select.options.length === 0) {
      ["auto", "cuda", "vulkan", "cpu"].forEach((backend) => {
        const option = document.createElement("option");
        option.value = backend;
        option.textContent = backend.toUpperCase();
        select.appendChild(option);
      });
    }

    select.value = Array.from(select.options).some((opt) => opt.value === current && !opt.disabled)
      ? current
      : "auto";
    if (detail) {
      const selectedOption = select.options[select.selectedIndex];
      detail.textContent = selectedOption?.dataset?.detail || "";
    }
    applyRuntimeBackendUi();
    if (!silent) {
      toast("Runtime backends updated");
    }
  } catch (error) {
    if (detail) {
      detail.textContent = "Runtime detection unavailable";
    }
    if (!silent) {
      toast(`Runtime backend load failed: ${error.message}`);
    }
  }
}

function formatGpuStats(inst) {
  const stats = Array.isArray(inst.gpuStats) ? inst.gpuStats : [];
  if (stats.length === 0) {
    const ids = Array.isArray(inst.gpus) ? inst.gpus : [];
    return ids.length > 0 ? `GPU ${ids.join(", ")} (telemetry pending)` : "-";
  }

  return stats.map((gpu) => {
    const used = Number(gpu.memory_used_mib ?? 0);
    const total = Number(gpu.memory_total_mib ?? 0);
    const memPct = total > 0 ? Math.round((used / total) * 100) : null;
    const temp = gpu.temperature_c ?? "n/a";
    const gClock = gpu.graphics_clock_mhz ?? "n/a";
    const mClock = gpu.memory_clock_mhz ?? "n/a";
    const util = gpu.utilization_percent ?? "n/a";
    return `GPU ${escapeHtml(gpu.id)}<br><span class="gpu-line">${escapeHtml(gpu.name || "Unknown")}</span><br><span class="gpu-line">mem ${used}/${total} MiB${memPct !== null ? ` (${memPct}%)` : ""} • util ${util}%</span><br><span class="gpu-line">temp ${temp}C • gfx ${gClock} MHz • mem ${mClock} MHz</span>`;
  }).join("<hr class=\"gpu-divider\" />");
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "application/yaml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function activeInstances(data = instancesCache) {
  return (data || []).filter((inst) => inst.state !== "stopped");
}

function occupiedPortsSet() {
  const set = new Set();
  activeInstances().forEach((inst) => {
    if (Number.isInteger(Number(inst.port))) {
      set.add(Number(inst.port));
    }
  });
  return set;
}

function occupiedGpuSet() {
  const set = new Set();
  activeInstances().forEach((inst) => {
    (inst.gpus || []).forEach((gpu) => set.add(String(gpu)));
  });
  return set;
}

function suggestNextFreePort(start = 1234) {
  const occupied = occupiedPortsSet();
  for (let p = start; p <= 65535; p += 1) {
    if (!occupied.has(p)) {
      return p;
    }
  }
  return start;
}

function applyGpuAvailability() {
  const select = $("launchGpus");
  if (!select) return;
  const occupied = occupiedGpuSet();
  const currentlySelected = new Set(Array.from(select.selectedOptions).map((opt) => opt.value));

  Array.from(select.options).forEach((opt) => {
    const inUse = occupied.has(opt.value);
    if (inUse && currentlySelected.has(opt.value)) {
      opt.selected = false;
    }
    opt.disabled = inUse;
    if (inUse) {
      if (!opt.textContent.includes("(in use)")) {
        opt.textContent = `${opt.textContent} (in use)`;
      }
    }
  });
}

$("openHelp").onclick = () => {
  const base = (settings.apiBase || "").trim().replace(/\/$/, "");
  if (!base) {
    toast("Set API Base URL first");
    return;
  }
  window.open(`${base}/help`, "_blank", "noopener,noreferrer");
};

async function loadLMStudioModels(selectElementId) {
  const select = $(selectElementId);
  const currentValue = select.value;

  function applyModels(models, sourceLabel) {
    select.innerHTML = '<option value="">-- Select model --</option>';
    models.forEach((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name || model.id;
      select.appendChild(option);
    });

    if (currentValue) {
      select.value = currentValue;
    }

    toast(`Loaded ${models.length} models (${sourceLabel})`);
  }

  try {
    const { models = [] } = await api("/v1/lmstudio/models");
    if (models.length > 0) {
      applyModels(models, "LM Studio");
      return;
    }
  } catch {
    // Fall through to instances-based model discovery.
  }

  try {
    const { data = [] } = await api("/v1/instances");
    const unique = new Set();
    for (const item of data) {
      const model = String(item?.effectiveModel || "").trim();
      if (model) {
        unique.add(model);
      }
    }

    const fallbackModels = [...unique].map((id) => ({ id, name: id }));
    if (fallbackModels.length > 0) {
      applyModels(fallbackModels, "running instances");
      return;
    }

    select.innerHTML = '<option value="">-- No models discovered --</option>';
    toast("No models discovered. Start LM Studio server or run an instance first.");
  } catch (error) {
    toast(`Models load failed: ${error.message}`);
  }
}

async function loadSystemGpus(selectElementId = "launchGpus") {
  try {
    const { data = [], warning, diagnostics } = await api("/v1/system/gpus");
    gpuTelemetryCache = data;
    const gpusSelect = $(selectElementId);
    const currentSelected = Array.from(gpusSelect.selectedOptions).map((opt) => opt.value);

    gpusSelect.innerHTML = "";
    data.forEach((gpu) => {
      const option = document.createElement("option");
      option.value = gpu.id;
      const temp = gpu.temperature_c ?? "n/a";
      const util = gpu.utilization_percent ?? "n/a";
      option.textContent = `GPU ${gpu.id}: ${gpu.name} (${gpu.memory_total_mib} MiB, util ${util}%, ${temp}C)`;
      if (currentSelected.includes(gpu.id)) {
        option.selected = true;
      }
      gpusSelect.appendChild(option);
    });

    applyRuntimeBackendUi();

    if (warning) {
      const diagDetail = diagnostics?.detail ? ` (${diagnostics.detail})` : "";
      toast(`GPU runtime warning: ${warning}${diagDetail}`);
      return;
    }

    toast(`Loaded ${data.length} GPUs`);
  } catch (error) {
    toast(`GPU load failed: ${error.message}`);
  }
}

// Auto-load on page load
window.addEventListener("load", () => {
  setTimeout(() => loadSystemGpus("launchGpus"), 300);
  setTimeout(() => loadLMStudioModels("launchInstanceModel"), 450);
  setTimeout(() => loadRuntimeBackends({ silent: false }), 520);
});

$("launchInstance").onclick = async () => {
  try {
    const name = $("launchName").value.trim();
    const port = Number($("launchPort").value);
    const model = $("launchInstanceModel").value.trim();
    const runtimeSelect = $("launchRuntimeBackend");
    const runtimeBackend = normalizeRuntimeBackend(runtimeSelect.value);
    const runtimeOption = runtimeSelect.options[runtimeSelect.selectedIndex];
    const runtimeSelection = runtimeOption?.dataset?.selectionId || runtimeBackend;
    const runtimeLabel = runtimeOption?.dataset?.runtimeLabel || runtimeBackend;
    let selectedGpus = Array.from($("launchGpus").selectedOptions).map((opt) => opt.value);

    if (!name) {
      toast("Instance name is required");
      return;
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast("Valid port is required");
      return;
    }

    const occupiedPorts = occupiedPortsSet();
    if (occupiedPorts.has(port)) {
      toast(`Port ${port} is already in use by a running instance`);
      return;
    }

    if (runtimeBackendUsesGpu(runtimeBackend)) {
      const occupiedGpus = occupiedGpuSet();
      const gpuConflict = selectedGpus.find((g) => occupiedGpus.has(String(g)));
      if (gpuConflict) {
        toast(`GPU ${gpuConflict} is already assigned to a running instance`);
        return;
      }
    } else {
      selectedGpus = [];
    }

    if (!model) {
      toast("Model selection is required");
      return;
    }

    const contextLength = parseContextLengthInput();

    const payload = {
      name,
      port,
      model,
      gpus: selectedGpus,
      maxInflightRequests: Number($("launchInflight").value || 4),
      runtimeBackend,
      runtimeSelection,
      runtimeLabel,
      contextLength
    };

    const launchPoll = setInterval(() => {
      void refreshInstances();
    }, 1000);
    setLaunchPending({
      name,
      host: "127.0.0.1",
      port,
      startedAt: Date.now()
    });

    try {
      await api("/v1/instances/start", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    } finally {
      clearInterval(launchPoll);
      setLaunchPending(null);
    }
    toast("Instance started");
    await refreshInstances();
  } catch (error) {
    toast(`Start failed: ${error.message}`);
  }
};

async function refreshInstances() {
  try {
    const { data, gpus } = await api("/v1/instances");
    if (Array.isArray(gpus)) {
      gpuTelemetryCache = gpus;
    }
    instancesCache = data || [];
    const tbody = $("instanceRows");
    tbody.innerHTML = "";
    const logsSelect = $("logsInstanceSelect");
    const selectedLogInstance = logsSelect.value;

    logsSelect.innerHTML = '<option value="">-- Select instance --</option>';

    for (const inst of data || []) {
      const opt = document.createElement("option");
      opt.value = inst.id;
      opt.textContent = `${inst.id} (${inst.state})`;
      logsSelect.appendChild(opt);

      const tr = document.createElement("tr");
      const baseUrl = `http://${inst.host || "127.0.0.1"}:${inst.port}`;
      const runtimeBackend = normalizeRuntimeBackend(inst.runtime?.hardware || "auto");
      const runtimeLabel = inst.runtime?.label || runtimeBackend;

      tr.innerHTML = `
        <td>${inst.id}</td>
        <td>${stateChipHtml(inst.state)}</td>
        <td>
          <div>${escapeHtml(inst.effectiveModel || "-")}</div>
          <div class="runtime-meta">ctx: ${inst.contextLength || "auto"}</div>
          <div class="runtime-meta">runtime: ${escapeHtml(runtimeLabel)}</div>
        </td>
        <td>${inst.port}</td>
        <td class="gpu-cell">${formatGpuStats(inst)}</td>
        <td class="actions-cell">
          <div class="action-primary">
            <button data-action="stop" data-id="${inst.id}">Stop</button>
            <button data-action="drain" data-id="${inst.id}">${inst.drain ? "Undrain" : "Drain"}</button>
          </div>
          <details class="action-more">
            <summary>More</summary>
            <div class="action-secondary">
              <button class="copy" data-action="copy-base" data-id="${inst.id}" data-copy="${baseUrl}">Copy Base</button>
              <button class="copy" data-action="copy-chat" data-id="${inst.id}" data-copy="${baseUrl}/v1/chat/completions">Copy Chat URL</button>
              <button class="copy" data-action="copy-model" data-id="${inst.id}" data-copy="${inst.effectiveModel}">Copy Model</button>
              <button class="kill" data-action="kill" data-id="${inst.id}">Kill</button>
              <button class="delete" data-action="delete" data-id="${inst.id}">Delete</button>
            </div>
          </details>
        </td>
      `;

      tbody.appendChild(tr);
    }

    if (selectedLogInstance) {
      logsSelect.value = selectedLogInstance;
    }

    if (!logsSelect.value && logsSelect.options.length > 1) {
      logsSelect.selectedIndex = 1;
    }

    const launchPort = $("launchPort");
    if (launchPort && occupiedPortsSet().has(Number(launchPort.value))) {
      launchPort.value = String(suggestNextFreePort(1234));
    }

    applyGpuAvailability();

    tbody.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute("data-id");
        const action = btn.getAttribute("data-action");
        try {
          if (action === "stop") {
            await api(`/v1/instances/${id}/stop`, { method: "POST", body: "{}" });
          } else if (action === "kill") {
            await api(`/v1/instances/${id}/kill`, {
              method: "POST",
              body: JSON.stringify({ reason: "operator" })
            });
          } else if (action === "drain") {
            const enable = btn.textContent === "Drain";
            await api(`/v1/instances/${id}/drain`, {
              method: "POST",
              body: JSON.stringify({ enabled: enable })
            });
          } else if (action === "delete") {
            await api(`/v1/instances/${id}`, {
              method: "DELETE"
            });
          } else if (action === "copy-base" || action === "copy-chat" || action === "copy-model") {
            copy(btn.getAttribute("data-copy") || "");
            return;
          }

          toast(`Action ${action} applied on ${id}`);
          await refreshInstances();
        } catch (error) {
          toast(`Action failed: ${error.message}`);
        }
      };
    });
  } catch (error) {
    toast(`Instances refresh failed: ${error.message}`);
  }
}

$("refreshInstances").onclick = refreshInstances;

$("refreshLogs").onclick = async () => {
  try {
    const instanceId = $("logsInstanceSelect").value.trim();
    if (!instanceId) {
      toast("Select an instance first");
      return;
    }
    const lines = Number($("logsLines").value || 200);
    const data = await api(`/v1/instances/${instanceId}/logs?lines=${lines}`);
    $("logsView").textContent = data.data || "";
  } catch (error) {
    toast(`Logs refresh failed: ${error.message}`);
  }
};

$("clearLogs").onclick = () => {
  $("logsView").textContent = "";
};

$("copyLogs").onclick = () => {
  copy($("logsView").textContent || "");
};

async function refreshConfigLibrary() {
  try {
    const { data = [] } = await api("/v1/instance-configs");
    const select = $("savedConfigSelect");
    const previous = select.value;
    select.innerHTML = data.length === 0
      ? '<option value="">-- No saved configs --</option>'
      : '<option value="">-- Select saved config --</option>';

    for (const cfg of data) {
      const option = document.createElement("option");
      option.value = cfg.id;
      option.textContent = `${cfg.name} (${cfg.instanceCount} instances)`;
      select.appendChild(option);
    }

    if (previous && Array.from(select.options).some((opt) => opt.value === previous)) {
      select.value = previous;
    }

    $("configLibraryResult").textContent = data.length === 0
      ? "No saved configs yet. Save current instances to create one."
      : `Saved configs: ${data.length}`;
  } catch (error) {
    $("configLibraryResult").textContent = `Config list unavailable: ${error.message}`;
  }
}

$("saveCurrentConfig").onclick = async () => {
  try {
    const name = $("configName").value.trim() || `Config ${new Date().toLocaleString()}`;
    const payload = await api("/v1/instance-configs/save-current", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    $("configLibraryResult").textContent = JSON.stringify(payload, null, 2);
    toast("Current config saved");
    await refreshConfigLibrary();
    $("savedConfigSelect").value = payload.id;
  } catch (error) {
    toast(`Save config failed: ${error.message}`);
  }
};

$("loadSelectedConfig").onclick = async () => {
  try {
    const id = $("savedConfigSelect").value;
    if (!id) {
      toast("Select a saved config first");
      return;
    }

    const payload = await api(`/v1/instance-configs/${id}/load`, {
      method: "POST",
      body: JSON.stringify({ replaceExisting: true })
    });

    $("configLibraryResult").textContent = JSON.stringify(payload, null, 2);
    toast(`Loaded config: started ${payload.started?.length || 0}, failed ${payload.failed?.length || 0}`);
    await refreshInstances();
  } catch (error) {
    toast(`Load config failed: ${error.message}`);
  }
};

$("deleteSelectedConfig").onclick = async () => {
  try {
    const id = $("savedConfigSelect").value;
    if (!id) {
      toast("Select a saved config first");
      return;
    }

    await api(`/v1/instance-configs/${id}`, { method: "DELETE" });
    toast("Config deleted");
    await refreshConfigLibrary();
  } catch (error) {
    toast(`Delete config failed: ${error.message}`);
  }
};

$("exportCurrentConfig").onclick = async () => {
  try {
    const response = await fetch(`${settings.apiBase}/v1/instance-configs/current/export.yaml`, {
      headers: {
        authorization: `Bearer ${settings.token}`
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `HTTP ${response.status}`);
    }
    downloadTextFile("instance-config-current.yaml", text);
    toast("Exported current config YAML");
  } catch (error) {
    toast(`Export current failed: ${error.message}`);
  }
};

$("exportSelectedConfig").onclick = async () => {
  try {
    const id = $("savedConfigSelect").value;
    if (!id) {
      toast("Select a saved config first");
      return;
    }

    const response = await fetch(`${settings.apiBase}/v1/instance-configs/${id}/export.yaml`, {
      headers: {
        authorization: `Bearer ${settings.token}`
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `HTTP ${response.status}`);
    }
    downloadTextFile(`instance-config-${id}.yaml`, text);
    toast("Exported selected config YAML");
  } catch (error) {
    toast(`Export selected failed: ${error.message}`);
  }
};

$("launchContextPreset").onchange = () => {
  const customInput = $("launchContextCustom");
  const isCustom = $("launchContextPreset").value === "custom";
  customInput.disabled = !isCustom;
  if (!isCustom) {
    customInput.value = "";
  }
};

$("launchRuntimeBackend").onchange = () => {
  applyRuntimeBackendUi();
  const select = $("launchRuntimeBackend");
  const detail = $("launchRuntimeDetail");
  if (detail) {
    const selectedOption = select.options[select.selectedIndex];
    detail.textContent = selectedOption?.dataset?.detail || "";
  }
};

refreshInstances();
refreshConfigLibrary();
loadRuntimeBackends({ silent: true });
setInterval(refreshInstances, 5000);
setInterval(() => loadSystemGpus("launchGpus"), 15000);
setInterval(() => loadRuntimeBackends({ silent: true }), 60000);
