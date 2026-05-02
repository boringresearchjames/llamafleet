/**
 * lf-hub-page.js — Light DOM custom element <lf-hub-page>
 * Owns: all HuggingFace model browser HTML and logic.
 */
import { api } from '../api.js';
import { escapeHtml, escapeAttr, copy } from './utils.js';

const $ = (id) => document.getElementById(id);

function toast(msg) {
  $('toast')?.notify(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ── Module-level hub state ────────────────────────────────────────────────

let hubFavorites = JSON.parse(localStorage.getItem("hub_favorites") || "[]");
let hubActiveFilter = { author: "", tags: "" };
let hubDownloadPollTimer = null;
let hubRepoFilesCache = {};
const PART_RE = /-(\d{5})-of-\d{5}\.gguf$/i;

function getHfToken() { return localStorage.getItem("hf_token") || ""; }

function saveHfToken(tok) {
  if (tok) { localStorage.setItem("hf_token", tok.trim()); }
  else { localStorage.removeItem("hf_token"); }
}

function hfHeaders() {
  const tok = getHfToken();
  const h = {};
  if (tok) h["X-HF-Token"] = tok;
  return h;
}

function fmtBytes(n) {
  if (!n) return "?";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(0) + " MB";
  return (n / 1e3).toFixed(0) + " KB";
}

function fmtRate(bps) {
  if (!bps) return "";
  if (bps >= 1e9) return (bps / 1e9).toFixed(1) + " GB/s";
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + " MB/s";
  if (bps >= 1e3) return (bps / 1e3).toFixed(0) + " KB/s";
  return bps + " B/s";
}

function fmtNum(n) {
  if (!n) return "0";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(n);
}

function quantBadgeHtml(tier, label) {
  return `<span class="quant-badge quant-${tier}" title="Quantization: ${label}">${label}</span>`;
}

function saveFavorites() { localStorage.setItem("hub_favorites", JSON.stringify(hubFavorites)); }

function isPinned(repoId, filename) {
  return hubFavorites.some((f) => f.repoId === repoId && f.filename === filename);
}

function pinModel(entry) {
  if (!isPinned(entry.repoId, entry.filename)) {
    hubFavorites.unshift(entry);
    saveFavorites();
    renderFavorites();
  }
}

function unpinModel(repoId, filename) {
  hubFavorites = hubFavorites.filter((f) => !(f.repoId === repoId && f.filename === filename));
  saveFavorites();
  renderFavorites();
}

function renderFavorites() {
  const list = document.getElementById("hubFavoritesList");
  if (!list) return;
  if (!hubFavorites.length) {
    list.innerHTML = '<span class="hub-empty">No favorites yet. Pin models from search results below.</span>';
    return;
  }
  list.innerHTML = hubFavorites.map((f) => {
    const rId = escapeAttr(f.repoId);
    const fn = escapeAttr(f.filename);
    return `
    <div class="hub-fav-item">
      <span class="hub-fav-quant">${quantBadgeHtml(f.quantTier || "other", f.quantLabel || "GGUF")}</span>
      <span class="hub-fav-name" title="${rId} / ${fn}">${escapeHtml(f.repoId.split("/").pop())} &mdash; ${escapeHtml(f.filename)}</span>
      <button class="hub-fav-launch" data-action="fav-launch" data-repo-id="${rId}" data-filename="${fn}">&#x26A1; Launch</button>
      <button class="hub-fav-unpin" title="Unpin" data-action="fav-unpin" data-repo-id="${rId}" data-filename="${fn}">&#x2715;</button>
    </div>`;
  }).join("");
}

function hubLaunchFav(repoId, filename) {
  const tabInstances = document.getElementById("tabInstances");
  const tabModels = document.getElementById("tabModels");
  const pageInstances = document.getElementById("pageInstances");
  const pageModels = document.getElementById("pageModels");
  if (tabInstances) tabInstances.classList.add("tab-btn-active");
  if (tabModels) tabModels.classList.remove("tab-btn-active");
  if (pageInstances) pageInstances.hidden = false;
  if (pageModels) pageModels.hidden = true;

  const sel = document.getElementById("launchInstanceModel");
  if (sel) {
    // For local models repoId === "__local__" and filename is the full path
    const searchVal = repoId === "__local__" ? filename : filename;
    const opt = Array.from(sel.options).find((o) => o.value === searchVal || o.value.includes(searchVal) || o.text.includes(searchVal));
    if (opt) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change"));
    }
  }
  document.querySelector("lf-launch-form")?.scrollIntoView({ behavior: "smooth" });
}

// ── Downloads polling ─────────────────────────────────────────────────────

function startDownloadPoll() {
  if (hubDownloadPollTimer) return;
  hubDownloadPollTimer = setInterval(pollDownloads, 1500);
}

function stopDownloadPoll() {
  if (hubDownloadPollTimer) {
    clearInterval(hubDownloadPollTimer);
    hubDownloadPollTimer = null;
  }
}

async function pollDownloads() {
  try {
    const res = await api("/v1/hub/downloads");
    renderDownloads(res.data || []);
    updateDlStrip(res.data || []);
    const active = (res.data || []).filter((j) => j.status === "downloading" || j.status === "pending");
    if (!active.length) stopDownloadPoll();
  } catch { /* ignore poll errors */ }
}

function renderDownloads(jobs) {
  const card = document.getElementById("hubDownloadsCard");
  const list = document.getElementById("hubDownloadsList");
  if (!card || !list) return;
  if (!jobs.length) { card.hidden = true; return; }
  card.hidden = false;
  list.innerHTML = jobs.map((j) => {
    const pct = j.pct != null ? j.pct : (j.bytesReceived && j.totalBytes ? Math.round(j.bytesReceived / j.totalBytes * 100) : null);
    const barPct = pct ?? 0;
    const statusClass = `hub-dl-status-${j.status}`;
    const jId = escapeAttr(j.id);
    const jRId = escapeAttr(j.repoId);
    const jFn = escapeAttr(j.filename);
    let actions = "";
    if (j.status === "downloading" || j.status === "pending") {
      actions = `<button class="hub-dl-cancel" data-action="dl-pause" data-job-id="${jId}">&#x23F8; Pause</button>`;
    } else if (j.status === "paused") {
      actions = `<button class="hub-dl-resume" data-action="dl-resume" data-repo-id="${jRId}" data-filename="${jFn}">&#x25B6; Resume</button>
               <button class="hub-dl-discard" data-action="dl-discard" data-job-id="${jId}">&#x1F5D1; Discard</button>`;
    } else if (j.status === "error") {
      actions = `<button class="hub-dl-resume" data-action="dl-resume" data-repo-id="${jRId}" data-filename="${jFn}">&#x25B6; Retry</button>
               <button class="hub-dl-discard" data-action="dl-discard" data-job-id="${jId}">&#x1F5D1; Discard</button>`;
    }
    const metaStr = j.totalBytes ? `${fmtBytes(j.bytesReceived)} / ${fmtBytes(j.totalBytes)}` : fmtBytes(j.bytesReceived);
    const rateStr = j.bytesPerSec ? ` · ${fmtRate(j.bytesPerSec)}` : "";
    const etaSec = j.bytesPerSec && j.totalBytes ? Math.round((j.totalBytes - j.bytesReceived) / j.bytesPerSec) : null;
    const etaStr = etaSec != null && etaSec > 0
      ? ` (${etaSec < 60 ? etaSec + "s" : etaSec < 3600 ? Math.round(etaSec / 60) + "m" : Math.floor(etaSec / 3600) + "h " + Math.round((etaSec % 3600) / 60) + "m"})`
      : "";
    return `
      <div class="hub-dl-row" id="dlrow-${jId}">
        <span class="hub-dl-name" title="${jRId}/${jFn}">${escapeHtml(j.filename)}</span>
        <span class="hub-dl-meta ${statusClass}">${escapeHtml(j.status.toUpperCase())}${pct != null ? "  " + pct + "%" : ""}${rateStr}${etaStr}</span>
        <div class="hub-dl-bar-wrap"><div class="hub-dl-bar-fill" style="width:${barPct}%"></div></div>
        <span class="hub-dl-meta">${metaStr}</span>
        ${actions}
      </div>`;
  }).join("");

  for (const j of jobs) updateInlineProgress(j);
}

function updateDlStrip(jobs) {
  const strip = document.getElementById("dlStatusStrip");
  if (!strip) return;
  const active = jobs.filter((j) => j.status === "downloading" || j.status === "pending");
  if (!active.length) { strip.hidden = true; return; }
  strip.hidden = false;
  strip.innerHTML = active.map((j) => {
    const pct = j.pct ?? 0;
    return `<span class="dl-strip-item" title="${j.filename}">\u2193 ${j.filename.split("/").pop().slice(-20)} ${pct}%</span>`;
  }).join("");
}

function updateInlineProgress(job) {
  const el = document.getElementById(`hubprog-${CSS.escape(job.repoId + "/" + job.filename)}`);
  if (!el) return;
  const pct = job.pct ?? 0;
  if (job.status === "done") {
    el.innerHTML = '<span style="color:var(--accent-2)">&#x2713; Downloaded</span>';
    return;
  }
  if (job.status === "paused") {
    el.innerHTML = `<span style="color:#ffbe5c">\u23F8 Paused ${pct}%</span>`;
    return;
  }
  if (job.status === "error") {
    el.innerHTML = `<span style="color:var(--danger)">Error</span>`;
    return;
  }
  el.innerHTML = `
    <div class="hub-inline-progress">
      <div class="hub-inline-bar-wrap"><div class="hub-inline-bar-fill" style="width:${pct}%"></div></div>
      <span>${pct}%${job.bytesPerSec ? " · " + fmtRate(job.bytesPerSec) : ""}</span>
    </div>`;
}

async function startDownload(repoId, filename) {
  const hfToken = getHfToken();
  try {
    const body = { repoId, filename };
    if (hfToken) body.hfToken = hfToken;
    const res = await api("/v1/hub/download", { method: "POST", body: JSON.stringify(body) });
    startDownloadPoll();
    const el = document.getElementById(`hubprog-${CSS.escape(repoId + "/" + filename)}`);
    if (el) el.innerHTML = '<div class="hub-inline-progress"><div class="hub-inline-bar-wrap"><div class="hub-inline-bar-fill" style="width:0%"></div></div><span>0%</span></div>';
    return res;
  } catch (err) {
    alert("Download failed: " + err.message);
  }
}

async function abortDownload(jobId) {
  try {
    await api(`/v1/hub/downloads/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    pollDownloads();
  } catch (err) {
    alert("Abort failed: " + err.message);
  }
}

async function resumeDownload(repoId, filename) {
  await startDownload(repoId, filename);
}

async function discardDownload(jobId) {
  try {
    await api(`/v1/hub/downloads/${encodeURIComponent(jobId)}/discard`, { method: "DELETE" });
    pollDownloads();
  } catch (err) {
    alert("Discard failed: " + err.message);
  }
}

async function clearCompletedDownloads() {
  try {
    await api("/v1/hub/downloads", { method: "DELETE" });
    pollDownloads();
  } catch (err) {
    toast("Clear failed: " + err.message);
  }
}

// ── Local models ──────────────────────────────────────────────────────────

function localQuantLabel(filename) {
  const m = filename.match(/[_-]((?:IQ[2-4]|Q[2-8])[_A-Z0-9]*?)(?:[_-](?:large|small|medium|imat|imatrix))?\.gguf$/i);
  return m ? m[1].toUpperCase() : "GGUF";
}

function localQuantTier(label) {
  const u = label.toUpperCase();
  if (/^(Q4_K_M|Q4_K_S|Q4_K|IQ4_XS|Q4_0)$/.test(u)) return "recommended";
  if (/^(Q5_K_M|Q5_K_S|Q5_K)$/.test(u)) return "balanced";
  if (/^(Q8_0|Q6_K)$/.test(u)) return "quality";
  if (/^(IQ[23]_|Q3_K_M|Q2_K)/.test(u)) return "imatrix";
  if (/^(BF16|F16|F32)$/.test(u)) return "large";
  return "other";
}

function isLocalPinned(filePath) {
  return hubFavorites.some((f) => f.repoId === "__local__" && f.filename === filePath);
}

function toggleLocalPin(filePath, btn) {
  if (isLocalPinned(filePath)) {
    hubFavorites = hubFavorites.filter((f) => !(f.repoId === "__local__" && f.filename === filePath));
    saveFavorites();
    btn.classList.remove("hub-pinned");
    btn.title = "Pin to Favorites";
  } else {
    const label = localQuantLabel(filePath);
    hubFavorites.unshift({ repoId: "__local__", filename: filePath, quantTier: localQuantTier(label), quantLabel: label });
    saveFavorites();
    btn.classList.add("hub-pinned");
    btn.title = "Unpin";
  }
  renderFavorites();
}

async function deleteLocalModel(filePath, row) {
  if (!confirm(`Delete ${filePath.split(/[\\/]/).pop()}?\n\nThis cannot be undone.`)) return;
  try {
    await api("/v1/local-models", { method: "DELETE", body: JSON.stringify({ path: filePath }) });
    // Remove from favorites if pinned
    hubFavorites = hubFavorites.filter((f) => !(f.repoId === "__local__" && f.filename === filePath));
    saveFavorites();
    renderFavorites();
    row.remove();
    toast(`Deleted ${filePath.split(/[\\/]/).pop()}`);
  } catch (err) {
    alert("Delete failed: " + err.message);
  }
}

async function loadLocalModels() {
  const list = document.getElementById("localModelsList");
  const header = document.getElementById("localModelsHeader");
  if (!list) return;
  list.innerHTML = '<span class="hub-empty">Scanning\u2026</span>';
  try {
    const res = await api("/v1/local-models");
    const models = res.data || [];
    const readyCount = models.filter(m => !m.downloading && !m.mmproj).length;
    const dlCount = models.filter(m => m.downloading && !m.mmproj).length;
    if (header) header.textContent = `Local Models (${readyCount}${dlCount ? `, ${dlCount} downloading` : ``})`;
    if (!models.length) {
      list.innerHTML = '<span class="hub-empty">No GGUF files found in scanned directories.</span>';
      return;
    }
    list.innerHTML = models.map((m) => {
      const label = localQuantLabel(m.name);
      const tier = localQuantTier(label);
      const pinned = isLocalPinned(m.id);
      const mId = escapeAttr(m.id);
      const sizeStr = m.size ? (m.size >= 1e9 ? (m.size / 1e9).toFixed(1) + " GB" : (m.size / 1e6).toFixed(0) + " MB") : "?";
      return `<div class="hub-local-row" id="localrow-${CSS.escape(m.id)}">
        <span class="hub-local-name" title="${mId}">${escapeHtml(m.name)}</span>
        <span class="hub-local-size">${escapeHtml(sizeStr)}</span>
        <span>${quantBadgeHtml(tier, label)}</span>
        <span class="hub-local-actions">
          <button class="hub-pin-btn${pinned ? " hub-pinned" : ""}" data-action="local-pin" data-path="${mId}" title="${pinned ? "Unpin" : "Pin to Favorites"}">&#x2605;</button>
          <button class="hub-local-del" data-action="local-delete" data-path="${mId}" title="Delete file from disk">&#x1F5D1;</button>
        </span>
      </div>`;
    }).join("");
  } catch (err) {
    list.innerHTML = `<span class="hub-empty" style="color:var(--danger)">Error: ${escapeHtml(err.message)}</span>`;
  }
}

// ── Hub search & browse ───────────────────────────────────────────────────

async function searchHub(q, author, tags) {
  const list = document.getElementById("hubResultsList");
  if (!list) return;
  list.innerHTML = '<span class="hub-empty">Searching\u2026</span>';
  try {
    const params = new URLSearchParams({ q: q || "", limit: "20" });
    if (author) params.set("author", author);
    if (tags) params.set("tags", tags);
    const res = await api(`/v1/hub/search?${params}`, { headers: hfHeaders() });
    renderHubResults(res.data || []);
  } catch (err) {
    list.innerHTML = `<span class="hub-empty" style="color:var(--danger)">Error: ${escapeHtml(err.message)}</span>`;
  }
}

async function loadCollection(source) {
  const list = document.getElementById("hubResultsList");
  if (!list) return;
  list.innerHTML = '<span class="hub-empty">Loading\u2026</span>';
  document.querySelectorAll(".hub-collection-tile").forEach((t) => {
    t.classList.toggle("hub-tile-active", t.dataset.source === source);
  });
  try {
    const res = await api(`/v1/hub/collections?source=${encodeURIComponent(source)}`, { headers: hfHeaders() });
    const input = document.getElementById("hubSearchInput");
    if (input) input.value = "";
    renderHubResults(res.data || []);
  } catch (err) {
    list.innerHTML = `<span class="hub-empty" style="color:var(--danger)">Error: ${escapeHtml(err.message)}</span>`;
  }
}

function renderHubResults(models) {
  const list = document.getElementById("hubResultsList");
  if (!list) return;
  if (!models.length) {
    list.innerHTML = '<span class="hub-empty">No results found.</span>';
    return;
  }
  list.innerHTML = models.map((m) => {
    const mId = escapeAttr(m.id);
    return `
    <div class="hub-result-row" id="hubrow-${CSS.escape(m.id)}" data-repo-id="${mId}">
      <div class="hub-result-header" data-action="toggle-repo">
        <span class="hub-result-name">${escapeHtml(m.id)}</span>
        <span class="hub-result-meta">\u2193 ${fmtNum(m.downloads)}  &hearts; ${fmtNum(m.likes)}</span>
        <span class="hub-result-expand">&#x25BA;</span>
      </div>
      <table class="hub-files-table" id="hubtable-${CSS.escape(m.id)}">
        <tbody id="hubtbody-${CSS.escape(m.id)}"><tr><td colspan="4"><span class="hub-empty">Loading files\u2026</span></td></tr></tbody>
      </table>
    </div>`;
  }).join("");
}

async function toggleRepoFiles(repoId) {
  const row = document.getElementById(`hubrow-${CSS.escape(repoId)}`);
  if (!row) return;
  const wasExpanded = row.classList.contains("hub-expanded");
  document.querySelectorAll(".hub-result-row.hub-expanded").forEach((r) => {
    if (r !== row) r.classList.remove("hub-expanded");
  });
  if (wasExpanded) { row.classList.remove("hub-expanded"); return; }
  row.classList.add("hub-expanded");

  if (hubRepoFilesCache[repoId]) {
    renderRepoFiles(repoId, hubRepoFilesCache[repoId]);
    return;
  }

  const tbody = document.getElementById(`hubtbody-${CSS.escape(repoId)}`);
  if (tbody) tbody.innerHTML = '<tr><td colspan="4"><span class="hub-empty">Loading files\u2026</span></td></tr>';

  try {
    const res = await api(`/v1/hub/repo/files?id=${encodeURIComponent(repoId)}`, { headers: hfHeaders() });
    hubRepoFilesCache[repoId] = res.data || [];
    renderRepoFiles(repoId, res.data || []);
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="4"><span class="hub-empty" style="color:var(--danger)">Error: ${escapeHtml(err.message)}</span></td></tr>`;
  }
}

function renderRepoFiles(repoId, files) {
  const tbody = document.getElementById(`hubtbody-${CSS.escape(repoId)}`);
  if (!tbody) return;
  if (!files.length) {
    tbody.innerHTML = '<tr><td colspan="4"><span class="hub-empty">No GGUF files found.</span></td></tr>';
    return;
  }
  const safeRepoId = escapeAttr(repoId);
  const items = groupFiles(files);
  tbody.innerHTML = items.map((item) => {
    if (item.type === "single") {
      const f = item.file;
      const pinned = isPinned(repoId, f.filename);
      const progId = `hubprog-${CSS.escape(repoId + "/" + f.filename)}`;
      const fFn = escapeAttr(f.filename);
      const fQt = escapeAttr(f.quantTier);
      const fQl = escapeAttr(f.quantLabel);
      return `
        <tr>
          <td class="hub-file-name">${escapeHtml(f.filename)}</td>
          <td class="hub-file-size">${fmtBytes(f.size)}</td>
          <td>${quantBadgeHtml(f.quantTier, f.quantLabel)}</td>
          <td class="hub-file-actions">
            <div id="${progId}"></div>
            <button class="hub-pin-btn${pinned ? " hub-pinned" : ""}"
              data-action="pin" data-repo-id="${safeRepoId}" data-filename="${fFn}"
              data-quant-tier="${fQt}" data-quant-label="${fQl}"
              title="${pinned ? "Unpin" : "Pin to Favorites"}">&#x2605;</button>
            <button class="hub-dl-btn"
              data-action="download" data-repo-id="${safeRepoId}" data-filename="${fFn}"
              data-quant-tier="${fQt}" data-quant-label="${fQl}"
              title="Download">\u2193 Download</button>
          </td>
        </tr>`;
    } else {
      // Multi-part group
      const { key, parts } = item;
      const totalSize = parts.reduce((s, p) => s + (p.size || 0), 0);
      const f0 = parts[0];
      const pinned = isPinned(repoId, f0.filename);
      const safeKey = escapeAttr(key);
      const groupCssId = `hubgroup-${CSS.escape(repoId + "/" + key)}`;
      const fQt = escapeAttr(f0.quantTier);
      const fQl = escapeAttr(f0.quantLabel);
      const fFn0 = escapeAttr(f0.filename);
      const partRows = parts.map((f) => {
        const fFn = escapeAttr(f.filename);
        const progId = `hubprog-${CSS.escape(repoId + "/" + f.filename)}`;
        return `
          <tr class="hub-part-row" data-group="${groupCssId}" hidden>
            <td class="hub-file-name hub-part-name">\u2514 ${escapeHtml(f.filename.split("/").pop())}</td>
            <td class="hub-file-size">${fmtBytes(f.size)}</td>
            <td></td>
            <td class="hub-file-actions">
              <div id="${progId}"></div>
              <button class="hub-dl-btn hub-dl-btn-sm"
                data-action="download" data-repo-id="${safeRepoId}" data-filename="${fFn}"
                data-quant-tier="${fQt}" data-quant-label="${fQl}"
                title="Download this part">\u2193</button>
            </td>
          </tr>`;
      }).join("");
      return `
        <tr class="hub-group-row" id="${groupCssId}">
          <td class="hub-file-name">
            <button class="hub-group-toggle" data-action="toggle-group" data-group-id="${groupCssId}" title="Show/hide individual parts">&#x25BA;</button>
            ${escapeHtml(key.split("/").pop())}
            <span class="hub-part-count">${parts.length} parts</span>
          </td>
          <td class="hub-file-size">${fmtBytes(totalSize)}</td>
          <td>${quantBadgeHtml(f0.quantTier, f0.quantLabel)}</td>
          <td class="hub-file-actions">
            <button class="hub-pin-btn${pinned ? " hub-pinned" : ""}"
              data-action="pin" data-repo-id="${safeRepoId}" data-filename="${fFn0}"
              data-quant-tier="${fQt}" data-quant-label="${fQl}"
              title="${pinned ? "Unpin" : "Pin to Favorites"}">&#x2605;</button>
            <button class="hub-dl-btn hub-dl-all-btn"
              data-action="download-all" data-repo-id="${safeRepoId}" data-group-key="${safeKey}"
              title="Download all ${parts.length} parts">\u2193 All ${parts.length}</button>
          </td>
        </tr>
        ${partRows}`;
    }
  }).join("");
}

function togglePin(repoId, filename, quantTier, quantLabel, btn) {
  if (isPinned(repoId, filename)) {
    unpinModel(repoId, filename);
    btn.classList.remove("hub-pinned");
    btn.title = "Pin to Favorites";
  } else {
    pinModel({ repoId, filename, quantTier, quantLabel });
    btn.classList.add("hub-pinned");
    btn.title = "Unpin";
  }
}

async function handleDownloadClick(repoId, filename, quantTier, quantLabel, btn) {
  btn.disabled = true;
  btn.textContent = "\u23F3 Starting\u2026";
  await startDownload(repoId, filename, quantTier, quantLabel);
  btn.textContent = "\u2193 Download";
  btn.disabled = false;
  startDownloadPoll();
}

async function handleDownloadAllClick(repoId, groupKey, btn) {
  const parts = (hubRepoFilesCache[repoId] || []).filter((f) => f.filename.replace(PART_RE, "") === groupKey);
  if (!parts.length) return;
  btn.disabled = true;
  const origText = btn.textContent;
  for (let i = 0; i < parts.length; i++) {
    btn.textContent = `\u23F3 ${i + 1}/${parts.length}\u2026`;
    await startDownload(repoId, parts[i].filename);
  }
  btn.textContent = origText;
  btn.disabled = false;
}

function groupFiles(files) {
  const groups = new Map();
  const order = [];
  for (const f of files) {
    const m = f.filename.match(PART_RE);
    if (m) {
      const key = f.filename.replace(PART_RE, "");
      if (!groups.has(key)) { groups.set(key, []); order.push({ type: "group", key }); }
      groups.get(key).push(f);
    } else {
      order.push({ type: "single", file: f });
    }
  }
  return order.map((item) => {
    if (item.type === "single") return item;
    const parts = groups.get(item.key);
    return parts.length === 1 ? { type: "single", file: parts[0] } : { type: "group", key: item.key, parts };
  });
}

// ── Custom element ────────────────────────────────────────────────────────

class LfHubPage extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
<!-- HF Token card + Favorites side by side -->
<section class="card span-6" id="hubTokenCard">
  <div class="section-header">
    <div><h2>&#x1F511; HuggingFace Token</h2><p class="card-subtitle">Required for gated models. Stored locally in your browser.</p></div>
  </div>
  <div class="hub-settings-strip">
    <input id="hfTokenInput" type="password" class="hub-token-input" placeholder="hf_\u2026 (optional, for gated models)" autocomplete="off" />
    <button id="hfTokenSave" class="hub-token-save" type="button">Save</button>
    <span id="hfTokenStatus" class="hub-token-status"></span>
  </div>
</section>

<section class="card span-6" id="hubFavoritesCard">
  <div class="section-header">
    <div><h2>&#x2B50; Favorites</h2><p class="card-subtitle">Pinned models &mdash; click Launch to pre-fill the instance launcher.</p></div>
  </div>
  <div id="hubFavoritesList" class="hub-favorites-list"><span class="hub-empty">No favorites yet. Pin models from search results below.</span></div>
</section>

<section class="card span-12" id="hubDownloadsCard" hidden>
  <div class="section-header">
    <div><h2>&#x2193; Downloads</h2><p class="card-subtitle">Active and recent downloads.</p></div>
    <button id="hubDownloadsClear" class="copy" type="button">Clear Completed</button>
  </div>
  <div id="hubDownloadsList" class="hub-downloads-list"></div>
</section>

<section class="card span-12" id="localModelsCard">
  <div class="section-header">
    <div><h2>&#x1F4C2; <span id="localModelsHeader">Local Models</span></h2><p class="card-subtitle">GGUF files on disk. Star to pin to Favorites, trash to delete.</p></div>
    <button id="localModelsRefresh" class="copy" type="button">&#x21BB; Refresh</button>
  </div>
  <div id="localModelsList" class="hub-local-list"><span class="hub-empty">Scanning\u2026</span></div>
</section>

<section class="card span-12">
  <div class="section-header">
    <div><h2>Browse Libraries</h2><p class="card-subtitle">Top GGUF repos from popular publishers.</p></div>
  </div>
  <div class="hub-collection-grid">
    <button class="hub-collection-tile" data-source="unsloth">&#x1F9A5; Unsloth</button>
    <button class="hub-collection-tile" data-source="bartowski">&#x1F3AF; bartowski</button>
    <button class="hub-collection-tile" data-source="lmstudio-community">&#x1F5A5; LM Studio</button>
    <button class="hub-collection-tile" data-source="thebloke">&#x1F4E6; TheBloke</button>
  </div>
</section>

<section class="card span-12">
  <div class="section-header">
    <div><h2>Search HuggingFace</h2><p class="card-subtitle">Searches for GGUF-format models sorted by downloads.</p></div>
  </div>
  <div class="hub-search-row">
    <input id="hubSearchInput" class="launch-input hub-search-input" type="text" placeholder="e.g. llama 3.1 8b" />
    <button id="hubSearchBtn" class="launch-start hub-search-btn" type="button">Search</button>
  </div>
  <div class="hub-filter-pills">
    <button class="hub-pill hub-pill-active" data-author="" data-tags="">All</button>
    <button class="hub-pill" data-author="unsloth" data-tags="">Unsloth</button>
    <button class="hub-pill" data-author="" data-tags="gguf,ollama">Ollama</button>
    <button class="hub-pill" data-author="lmstudio-community" data-tags="">LM Studio</button>
    <button class="hub-pill" data-author="bartowski" data-tags="">bartowski</button>
  </div>
  <div id="hubResultsList" class="hub-results-list"><span class="hub-empty">Search or browse a library above.</span></div>
</section>`;

    this._wireEvents();
    renderFavorites();
    loadLocalModels();
    api("/v1/hub/downloads").then((res) => {
      if ((res.data || []).some((j) => j.status === "downloading" || j.status === "pending")) {
        startDownloadPoll();
      }
      renderDownloads(res.data || []);
      updateDlStrip(res.data || []);
    }).catch(() => {});
  }

  _wireEvents() {
    const tokenInput = document.getElementById("hfTokenInput");
    const tokenSave = document.getElementById("hfTokenSave");
    const tokenStatus = document.getElementById("hfTokenStatus");
    if (tokenInput) {
      tokenInput.value = getHfToken();
      tokenInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tokenSave?.click(); });
    }
    if (tokenSave) {
      tokenSave.addEventListener("click", () => {
        saveHfToken(tokenInput?.value || "");
        if (tokenStatus) {
          tokenStatus.textContent = "Saved \u2713";
          setTimeout(() => { tokenStatus.textContent = ""; }, 1800);
        }
      });
    }

    document.querySelectorAll(".hub-collection-tile").forEach((tile) => {
      tile.addEventListener("click", () => loadCollection(tile.dataset.source));
    });

    const searchInput = document.getElementById("hubSearchInput");
    const searchBtn = document.getElementById("hubSearchBtn");
    const runSearch = () => {
      const q = searchInput?.value.trim() || "";
      searchHub(q, hubActiveFilter.author, hubActiveFilter.tags);
      document.querySelectorAll(".hub-collection-tile").forEach((t) => t.classList.remove("hub-tile-active"));
    };
    searchBtn?.addEventListener("click", runSearch);
    searchInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });

    document.querySelectorAll(".hub-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        document.querySelectorAll(".hub-pill").forEach((p) => p.classList.remove("hub-pill-active"));
        pill.classList.add("hub-pill-active");
        hubActiveFilter.author = pill.dataset.author || "";
        hubActiveFilter.tags = pill.dataset.tags || "";
        const q = searchInput?.value.trim() || "";
        if (q || hubActiveFilter.author) runSearch();
      });
    });

    document.getElementById("hubDownloadsClear")?.addEventListener("click", clearCompletedDownloads);
    document.getElementById("localModelsRefresh")?.addEventListener("click", loadLocalModels);

    // Delegated clicks for local models list
    const localList = document.getElementById("localModelsList");
    if (localList) localList.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const { action, path: filePath } = btn.dataset;
      if (action === "local-pin") toggleLocalPin(filePath, btn);
      else if (action === "local-delete") {
        const row = document.getElementById(`localrow-${CSS.escape(filePath)}`);
        deleteLocalModel(filePath, row);
      }
    });

    // Delegated clicks for favorites
    const favList = document.getElementById("hubFavoritesList");
    if (favList) favList.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const { action, repoId, filename } = btn.dataset;
      if (action === "fav-launch") hubLaunchFav(repoId, filename);
      else if (action === "fav-unpin") unpinModel(repoId, filename);
    });

    // Delegated clicks for downloads
    const dlList = document.getElementById("hubDownloadsList");
    if (dlList) dlList.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const { action, jobId, repoId, filename } = btn.dataset;
      if (action === "dl-pause") abortDownload(jobId);
      else if (action === "dl-resume") resumeDownload(repoId, filename);
      else if (action === "dl-discard") discardDownload(jobId);
    });

    // Delegated clicks for search results
    const resultsList = document.getElementById("hubResultsList");
    if (resultsList) resultsList.addEventListener("click", (e) => {
      const header = e.target.closest("[data-action='toggle-repo']");
      if (header) {
        const row = header.closest("[data-repo-id]");
        if (row) toggleRepoFiles(row.dataset.repoId);
        return;
      }
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const { action, repoId, filename, quantTier, quantLabel } = btn.dataset;
      if (action === "toggle-group") {
        const groupId = btn.dataset.groupId;
        const isExpanded = btn.classList.toggle("hub-group-expanded");
        btn.innerHTML = isExpanded ? "&#x25BC;" : "&#x25BA;";
        const tbl = btn.closest("tbody");
        if (tbl) tbl.querySelectorAll(`.hub-part-row[data-group="${CSS.escape(groupId)}"]`).forEach((r) => { r.hidden = !isExpanded; });
      } else if (action === "pin") togglePin(repoId, filename, quantTier, quantLabel, btn);
      else if (action === "download") handleDownloadClick(repoId, filename, quantTier, quantLabel, btn);
      else if (action === "download-all") handleDownloadAllClick(repoId, btn.dataset.groupKey, btn);
    });
  }
}

customElements.define('lf-hub-page', LfHubPage);
