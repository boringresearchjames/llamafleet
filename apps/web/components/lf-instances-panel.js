/**
 * lf-instances-panel.js — Light DOM custom element <lf-instances-panel>
 * Owns: instances table, logs panel, all related event handlers.
 * Subscribes to store 'instances' and 'hostStats'.
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { openInstanceTestDialog, runInstanceSpeedTest } from './lf-test-dialog.js';
import { applyGpuAvailability } from './lf-launch-form.js';
import {
  escapeHtml,
  escapeAttr,
  trimModelPath,
  trimArgsModelPaths,
  normalizeRuntimeBackend,
  occupiedPortsSet,
  suggestNextFreePort,
  copy
} from './utils.js';

const $ = (id) => document.getElementById(id);

function toast(msg) {
  $('toast')?.notify(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ── Chip HTML helpers ─────────────────────────────────────────────────────

function stateChipHtml(state) {
  const normalized = String(state || "unknown").toLowerCase();
  const safeText = escapeHtml(state || "unknown");
  return `<lf-state-chip state="${normalized}">${safeText}</lf-state-chip>`;
}

function activityChipHtml(inst) {
  const inflight    = Math.max(0, Number(inst?.inflightRequests || 0));
  const maxInflight = Math.max(1, Number(inst?.maxInflightRequests || 1));
  const queueDepth  = Math.max(0, Number(inst?.queueDepth || 0));
  const totalCompletionTokens = Math.max(0, Number(inst?.totalCompletionTokens || 0));
  const totalTokens = Math.max(0, Number(inst?.totalTokens || 0));
  const tokens = totalCompletionTokens > 0 ? totalCompletionTokens : totalTokens;
  return `<lf-activity-chip
    inflight="${inflight}"
    max-inflight="${maxInflight}"
    queue="${queueDepth}"
    tokens="${tokens}"
    last-active="${escapeAttr(inst?.lastActivityAt || '')}"></lf-activity-chip>`;
}

function formatGpuStats(inst) {
  const stats = Array.isArray(inst.gpuStats) ? inst.gpuStats : [];
  if (stats.length === 0) {
    const ids = Array.isArray(inst.gpus) ? inst.gpus : [];
    return ids.length > 0 ? `GPU ${ids.join(", ")} (telemetry pending)` : "CPU";
  }
  return stats.map((gpu) => {
    const used = Number(gpu.memory_used_mib ?? 0);
    const total = Number(gpu.memory_total_mib ?? 0);
    const memPct = total > 0 ? Math.round((used / total) * 100) : 0;
    const barFill = Math.min(100, memPct);
    const barColor = memPct >= 90 ? "#ff5c7a" : memPct >= 70 ? "#ffbe5c" : "#4cdb8e";
    const util = gpu.utilization_percent ?? "n/a";
    const temp = gpu.temperature_c != null ? `${gpu.temperature_c}°` : null;
    const pwr = gpu.power_draw_w != null ? `${Number(gpu.power_draw_w).toFixed(0)}W` : null;
    const meta = [util !== "n/a" ? `${util}%` : null, temp, pwr].filter(Boolean).join(" ");
    return `<div class="gpu-compact" title="${escapeHtml(gpu.name || "GPU " + gpu.id)}: ${used}/${total} MiB VRAM (${memPct}%)">
      <span class="gpu-compact-id">GPU&nbsp;${escapeHtml(String(gpu.id))}</span>
      <div class="vram-bar-wrap"><div class="vram-bar-fill" style="width:${barFill}%;background:${barColor}"></div></div>
      <span class="vram-pct">${memPct}%</span>
      ${meta ? `<span class="gpu-compact-meta">${escapeHtml(meta)}</span>` : ""}
    </div>`;
  }).join("");
}

function resolveDisplayRouteName(inst, allInstances) {
  const routeName = inst.modelRouteName || inst.effectiveModel || "";
  if (!routeName) return routeName;
  const baseStem = routeName.replace(/-\d+$/, "");
  const isBase = routeName === baseStem;
  if (!isBase) return routeName;
  const active = (allInstances || store.get('instances') || []).filter(x => x.state !== "stopped");
  const siblings = active.filter(x => {
    const r = x.modelRouteName || x.effectiveModel || "";
    return r !== routeName && r.replace(/-\d+$/, "") === baseStem;
  });
  return siblings.length > 0 ? `${routeName}-1` : routeName;
}

// ── Logs state ────────────────────────────────────────────────────────────

let autoTailTimer = null;

function stopAutoTail() {
  if (autoTailTimer !== null) {
    clearInterval(autoTailTimer);
    autoTailTimer = null;
  }
}

async function doFetchLogs() {
  const instanceId = $("logsInstanceSelect").value.trim();
  if (!instanceId) return;
  const lines = Number($("logsLines").value || 200);
  const data = await api(`/v1/instances/${instanceId}/logs?lines=${lines}`);
  const view = $("logsView");
  view.textContent = data.data || "";
  view.scrollTop = view.scrollHeight;
}

// ── Render functions ──────────────────────────────────────────────────────

function renderInstanceStatsFooter() {
  const tfoot = $("instanceStatsFooter");
  if (!tfoot) return;
  if (!store.get('hostStats')) { tfoot.innerHTML = ""; return; }
  const d = store.get('hostStats');
  const memPct = d.mem_total_mib > 0 ? Math.round((d.mem_used_mib / d.mem_total_mib) * 100) : 0;
  const memUsedGib = (d.mem_used_mib / 1024).toFixed(1);
  const memTotalGib = (d.mem_total_mib / 1024).toFixed(1);
  const memColor = memPct >= 90 ? "var(--danger)" : memPct >= 70 ? "#ffbe5c" : "var(--accent-2)";
  const cpuPct = d.cpu_utilization_percent ?? 0;
  const cpuColor = cpuPct >= 90 ? "var(--danger)" : cpuPct >= 60 ? "#ffbe5c" : "var(--accent)";
  const load1 = d.loadavg ? d.loadavg[0].toFixed(2) : "\u2014";
  const coreSquares = Array.isArray(d.cpu_per_core) && d.cpu_per_core.length > 0
    ? d.cpu_per_core.map((pct) => {
        const c = pct >= 80 ? 'var(--danger)' : pct >= 40 ? '#ffbe5c' : pct >= 10 ? 'var(--accent)' : 'rgba(159,176,216,0.18)';
        return `<span class="hs-core-sq" style="background:${c}" title="${pct}%"></span>`;
      }).join('')
    : '';
  tfoot.innerHTML = `
    <tr class="host-stats-trow">
      <td colspan="6">
        <div class="hsf-wrap">
          <span class="hsf-label">Host</span>
          <span class="hsf-item">
            <span class="hsf-name">CPU</span>
            <div class="hsf-bar-wrap"><div class="hsf-bar-fill" style="width:${cpuPct}%;background:${cpuColor}"></div></div>
            <span class="hsf-val">${cpuPct}%</span>
            <span class="hsf-muted">avg &thinsp; load&thinsp;${load1}</span>
          </span>
          <span class="hsf-sep">&middot;</span>
          <span class="hsf-item">
            <span class="hsf-name">RAM</span>
            <div class="hsf-bar-wrap"><div class="hsf-bar-fill" style="width:${memPct}%;background:${memColor}"></div></div>
            <span class="hsf-val">${memUsedGib}/${memTotalGib}&thinsp;GiB</span>
            <span class="hsf-muted">${memPct}%</span>
          </span>
          ${coreSquares ? `<span class="hsf-sep">&middot;</span><div class="hs-cores" style="max-width:none">${coreSquares}</div>` : ''}
        </div>
      </td>
    </tr>`;
}

function renderInstanceData(data) {
  const tbody = $("instanceRows");
  tbody.innerHTML = "";
  const logsSelect = $("logsInstanceSelect");
  const selectedLogInstance = logsSelect.value;

  logsSelect.innerHTML = '<option value="">-- Select instance --</option>';

  for (const inst of data || []) {
    const opt = document.createElement("option");
    opt.value = inst.id;
    opt.textContent = `${inst.profileName || inst.id} (${inst.state})`;
    logsSelect.appendChild(opt);

    const tr = document.createElement("tr");
    const normalizedState = String(inst.state || "unknown").toLowerCase();
    tr.setAttribute("data-state", normalizedState);
    const runtimeBackend = normalizeRuntimeBackend(inst.runtime?.hardware || "auto");
    const runtimeLabel = runtimeBackend;
    const isStopped = String(inst.state || "").toLowerCase() === "stopped";
    const isUnhealthy = String(inst.state || "").toLowerCase() === "unhealthy";
    const canWake = isStopped || isUnhealthy;
    const drainTitle = inst.drain ? "Resume Intake" : "Pause Intake";
    const drainIcon = inst.drain ? "&#x25b6;" : "&#x23f8;";
    const wakeBtn = canWake ? `<button class="icon-btn icon-wake" data-action="wake" data-id="${inst.id}" title="Wake / Restart Instance">&#x25B6;</button>` : "";
    const drainBtn = canWake ? "" : `<button class="icon-btn icon-drain" data-action="drain" data-id="${inst.id}" data-enabled="${inst.drain ? "false" : "true"}" title="${drainTitle}">${drainIcon}</button>`;
    const testBtn = canWake ? "" : `<button class="icon-btn icon-test" data-action="test" data-id="${inst.id}" title="Test Prompt">&#x1F4AC;</button>`;
    const speedTestBtn = canWake ? "" : `<button class="icon-btn icon-speed" data-action="speed-test" data-id="${inst.id}" title="Speed Test (TPS)">&#x26A1;</button>`;
    const deleteTitle = isStopped ? "Delete Instance" : "Remove Instance";
    const deleteBtn = `<button class="icon-btn icon-delete" data-action="delete" data-id="${inst.id}" title="${deleteTitle}">&#x1F5D1;</button>`;

    tr.innerHTML = `
      <td>
        <div>${escapeHtml(inst.profileName || inst.id)}</div>
        <div class="runtime-meta">${escapeHtml(inst.id)}</div>
      </td>
      <td>
        ${stateChipHtml(inst.state)}
        ${activityChipHtml(inst)}
      </td>
      <td>
        <div title="${escapeHtml(inst.effectiveModel || "-")}">${escapeHtml(trimModelPath(inst.effectiveModel || "-"))}${inst.modelNameAmbiguous ? ' <span title="Multiple running instances share this model name — routing via /v1/chat/completions will return 409. Stop one instance or use different model paths." style="color:#ffbe5c;cursor:default;">⚠</span>' : ''}</div>
        <div class="runtime-meta">ctx: ${inst.resolvedContextLength ? inst.resolvedContextLength.toLocaleString() : (inst.contextLength ? inst.contextLength.toLocaleString() : "auto")}</div>
        <div class="runtime-meta">runtime: ${escapeHtml(runtimeLabel)}</div>
        <div class="runtime-meta" title="${escapeHtml(Array.isArray(inst.runtime?.serverArgs) && inst.runtime.serverArgs.length > 0 ? inst.runtime.serverArgs.join(" ") : "(none)")}">args: ${escapeHtml(trimArgsModelPaths(Array.isArray(inst.runtime?.serverArgs) && inst.runtime.serverArgs.length > 0 ? inst.runtime.serverArgs.join(" ") : "(none)"))}</div>
      </td>
      <td>${inst.port}</td>
      <td class="gpu-cell">${formatGpuStats(inst)}</td>
      <td class="actions-cell">
        <div class="icon-toolbar">
          ${deleteBtn}
          ${wakeBtn}
          ${testBtn}
          ${speedTestBtn}
          ${drainBtn}
          <button class="icon-btn icon-copy" data-action="copy-model" data-id="${inst.id}" data-copy="${resolveDisplayRouteName(inst, data)}" title="Copy Model ID (unique route name for use with /v1/chat/completions)">&#x1F4CB;</button>
          <button class="icon-btn icon-clone" data-action="clone" data-id="${inst.id}" title="Clone Setup">&#x2398;</button>
        </div>
      </td>
    `;

    tbody.appendChild(tr);
  }

  if (selectedLogInstance) logsSelect.value = selectedLogInstance;
  if (!logsSelect.value && logsSelect.options.length > 1) logsSelect.selectedIndex = 1;

  if ((data || []).length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:0;border:none">
      <div class="empty-state">
        <div class="empty-state-icon">🦙</div>
        <div class="empty-state-title">No instances running</div>
        <div class="empty-state-desc">Select a model in the <strong>Launch New Instance</strong> form above, choose your GPUs and port, then click <strong>Start</strong>.</div>
      </div>
    </td></tr>`;
  }

  const launchPort = $("launchPort");
  if (launchPort && occupiedPortsSet().has(Number(launchPort.value))) {
    launchPort.value = String(suggestNextFreePort(1234));
  }

  renderInstanceStatsFooter();
  applyGpuAvailability();
}

async function handleInstanceAction(btn) {
  const id = btn.getAttribute("data-id");
  const action = btn.getAttribute("data-action");
  try {
    if (action === "wake") {
      await api(`/v1/instances/${id}/restart`, { method: "POST" });
    } else if (action === "drain") {
      const enable = btn.getAttribute("data-enabled") === "true";
      await api(`/v1/instances/${id}/drain`, {
        method: "POST",
        body: JSON.stringify({ enabled: enable })
      });
    } else if (action === "delete") {
      const confirmed = window.confirm(`Remove instance ${id} from LlamaFleet?`);
      if (!confirmed) return;
      await api(`/v1/instances/${id}`, { method: "DELETE" });
    } else if (action === "copy-base" || action === "copy-model") {
      copy(btn.getAttribute("data-copy") || "");
      return;
    } else if (action === "test") {
      openInstanceTestDialog(id);
      return;
    } else if (action === "speed-test") {
      openInstanceTestDialog(id);
      void runInstanceSpeedTest();
      return;
    } else if (action === "clone") {
      _cloneInstanceSetup(id);
      return;
    }
    toast(`Action ${action} applied on ${id}`);
    await store.refresh('instances');
  } catch (error) {
    toast(`Action failed: ${error.message}`);
  }
}

function _cloneInstanceSetup(instanceId) {
  const inst = (store.get('instances') || []).find((x) => String(x.id) === String(instanceId));
  if (!inst) { toast("Instance not found"); return; }
  const form = document.querySelector('lf-launch-form');
  if (form) {
    form.fillFromInstance(inst);
  }
}

function initInstancesEventDelegation() {
  const tbody = $("instanceRows");
  if (tbody && !tbody.dataset.delegated) {
    tbody.dataset.delegated = "1";
    tbody.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (btn) void handleInstanceAction(btn);
    });
  }
}

// ── Custom element ────────────────────────────────────────────────────────

class LfInstancesPanel extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
<section class="card span-12">
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>State</th>
          <th>Model</th>
          <th>Port</th>
          <th>Stats</th>
          <th>Controls</th>
        </tr>
      </thead>
      <tbody id="instanceRows"></tbody>
      <tfoot id="instanceStatsFooter"></tfoot>
    </table>
  </div>
  <div class="instance-logs-panel">
    <h3>Instance Logs</h3>
    <div class="instance-logs-controls">
      <label class="launch-field">
        Instance
        <select id="logsInstanceSelect" class="launch-input">
          <option value="">-- Select instance --</option>
        </select>
      </label>
      <label class="launch-field">
        Lines
        <input id="logsLines" type="number" value="200" class="launch-input" />
      </label>
      <div class="button-row">
        <button id="refreshLogs">Tail Logs</button>
        <label class="logs-autotail-label" title="Automatically re-fetch logs every 2 seconds">
          <input type="checkbox" id="logsAutoTail" />
          Auto-tail
        </label>
        <button id="clearLogs">Clear</button>
        <button id="copyLogs">Copy</button>
      </div>
    </div>
    <pre id="logsView"></pre>
  </div>
</section>`;

    this._wireEvents();
    initInstancesEventDelegation();
    store.subscribe('instances', renderInstanceData);
    store.subscribe('hostStats', () => renderInstanceStatsFooter());
  }

  _wireEvents() {
    $("refreshLogs").onclick = async () => {
      stopAutoTail();
      const autoTailChk = $("logsAutoTail");
      if (autoTailChk) autoTailChk.checked = false;
      try {
        const instanceId = $("logsInstanceSelect").value.trim();
        if (!instanceId) { toast("Select an instance first"); return; }
        await doFetchLogs();
      } catch (error) {
        toast(`Logs refresh failed: ${error.message}`);
      }
    };

    $("logsAutoTail").addEventListener("change", () => {
      stopAutoTail();
      if ($("logsAutoTail").checked) {
        void doFetchLogs().catch((e) => toast(`Auto-tail error: ${e.message}`));
        autoTailTimer = setInterval(() => {
          void doFetchLogs().catch((e) => {
            toast(`Auto-tail error: ${e.message}`);
            stopAutoTail();
            $("logsAutoTail").checked = false;
          });
        }, 2000);
      }
    });

    $("logsInstanceSelect").addEventListener("change", () => {
      stopAutoTail();
      const autoTailChk = $("logsAutoTail");
      if (autoTailChk) autoTailChk.checked = false;
    });

    $("clearLogs").onclick = () => { $("logsView").textContent = ""; };
    $("copyLogs").onclick = () => { copy($("logsView").textContent || ""); };
  }
}

customElements.define('lf-instances-panel', LfInstancesPanel);
