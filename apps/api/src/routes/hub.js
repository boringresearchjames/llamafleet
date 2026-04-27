import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import express from "express";
import { modelsDir } from "../lib/config.js";
import { requireAdminToken } from "../lib/auth.js";
import { hubDownloadJobs, parseQuantTier, hfFetch, executeHubDownload } from "../lib/hub.js";

const HF_API = "https://huggingface.co";

const router = express.Router();

// GET /hub/search?q=&limit=20&author=&tags=
router.get("/hub/search", requireAdminToken, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const author = String(req.query.author || "").trim();
    const tags = String(req.query.tags || "").trim();
    const hfToken = String(req.headers["x-hf-token"] || "").trim() || undefined;

    const params = new URLSearchParams({
      search: q,
      filter: "gguf",
      sort: "downloads",
      direction: "-1",
      limit: String(limit),
      full: "false",
    });
    if (author) params.set("author", author);
    if (tags) params.set("tags", tags);

    const hfRes = await hfFetch(`/api/models?${params}`, hfToken);
    const models = await hfRes.json();
    const data = models.map((m) => ({
      id: m.modelId || m.id,
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      tags: m.tags || [],
      pipeline: m.pipeline_tag || null,
      lastModified: m.lastModified || null,
    }));
    res.json({ data });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// GET /hub/repo/files?id=<repoId>
router.get("/hub/repo/files", requireAdminToken, async (req, res) => {
  try {
    const repoId = String(req.query.id || "").trim();
    if (!repoId) return res.status(400).json({ error: "id required" });
    const hfToken = String(req.headers["x-hf-token"] || "").trim() || undefined;
    const hfRes = await hfFetch(`/api/models/${repoId}?blobs=true`, hfToken);
    const model = await hfRes.json();
    const siblings = (model.siblings || []).filter((s) => s.rfilename && s.rfilename.toLowerCase().endsWith(".gguf"));
    const files = siblings.map((s) => {
      const { tier, label } = parseQuantTier(s.rfilename);
      return { filename: s.rfilename, size: s.lfs?.size || s.size || null, quantLabel: label, quantTier: tier };
    });
    const tierOrder = { recommended: 0, balanced: 1, quality: 2, imatrix: 3, large: 4, other: 5 };
    files.sort((a, b) => (tierOrder[a.quantTier] ?? 5) - (tierOrder[b.quantTier] ?? 5) || a.filename.localeCompare(b.filename));
    res.json({ data: files, repoId, cardData: { modelId: model.modelId, downloads: model.downloads, likes: model.likes, tags: model.tags } });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// GET /hub/collections?source=unsloth|bartowski|lmstudio-community|thebloke
router.get("/hub/collections", requireAdminToken, async (req, res) => {
  const source = String(req.query.source || "unsloth").toLowerCase();
  const authorMap = {
    unsloth: "unsloth",
    bartowski: "bartowski",
    "lmstudio-community": "lmstudio-community",
    thebloke: "TheBloke",
  };
  const author = authorMap[source];
  if (!author) return res.status(400).json({ error: "Unknown source" });
  const hfToken = String(req.headers["x-hf-token"] || "").trim() || undefined;
  try {
    const params = new URLSearchParams({ author, filter: "gguf", sort: "downloads", direction: "-1", limit: "30", full: "false" });
    const hfRes = await hfFetch(`/api/models?${params}`, hfToken);
    const models = await hfRes.json();
    const data = models.map((m) => ({
      id: m.modelId || m.id,
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      lastModified: m.lastModified || null,
    }));
    res.json({ data, author });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// POST /hub/download { repoId, filename, hfToken? }
router.post("/hub/download", requireAdminToken, async (req, res) => {
  try {
    const { repoId, filename } = req.body || {};
    const hfToken = String(req.body?.hfToken || req.headers["x-hf-token"] || "").trim() || undefined;

    if (!repoId || !filename) return res.status(400).json({ error: "repoId and filename required" });

    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.\-]*\/[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/.test(repoId)) {
      return res.status(400).json({ error: "Invalid repoId format" });
    }

    const safeFilename = path.basename(filename);
    if (safeFilename !== filename || safeFilename.includes("..")) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    if (!safeFilename.toLowerCase().endsWith(".gguf")) {
      return res.status(400).json({ error: "Only .gguf files allowed" });
    }

    const home = os.homedir();
    const destDir = path.resolve(modelsDir.replace(/^~/, home));
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, safeFilename);
    const partPath = destPath + ".part";
    const metaPath = partPath + ".meta.json";

    for (const job of hubDownloadJobs.values()) {
      if (job.destPath === destPath && (job.status === "downloading" || job.status === "pending")) {
        return res.json({ id: job.id, resumed: false, alreadyRunning: true });
      }
    }

    for (const [id, job] of hubDownloadJobs.entries()) {
      if (job.destPath === destPath && job.status !== "downloading" && job.status !== "pending") {
        hubDownloadJobs.delete(id);
      }
    }

    let resumedFrom = 0;
    if (fs.existsSync(partPath)) {
      try { resumedFrom = fs.statSync(partPath).size; } catch { resumedFrom = 0; }
    }

    const jobId = crypto.randomUUID();
    const job = {
      id: jobId, repoId, filename: safeFilename, destPath, partPath, metaPath,
      bytesReceived: resumedFrom, totalBytes: null, resumedFrom,
      status: "pending", error: null, abortController: new AbortController(),
      bytesPerSec: null, _rateAt: Date.now(), _rateBytes: resumedFrom,
    };
    try { fs.writeFileSync(metaPath, JSON.stringify({ repoId, filename: safeFilename })); } catch { /* non-fatal */ }
    hubDownloadJobs.set(jobId, job);

    // Fire-and-forget — do not await
    void executeHubDownload(job, hfToken);

    res.json({ id: jobId, resumedFrom });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /hub/downloads — clear all non-active jobs
router.delete("/hub/downloads", requireAdminToken, (_req, res) => {
  let cleared = 0;
  for (const [id, job] of hubDownloadJobs.entries()) {
    if (job.status !== "downloading" && job.status !== "pending") {
      hubDownloadJobs.delete(id);
      cleared++;
    }
  }
  res.json({ ok: true, cleared });
});

// GET /hub/downloads
router.get("/hub/downloads", requireAdminToken, (_req, res) => {
  const jobs = [];
  for (const job of hubDownloadJobs.values()) {
    const pct = job.totalBytes ? Math.round((job.bytesReceived / job.totalBytes) * 100) : null;
    jobs.push({
      id: job.id, repoId: job.repoId, filename: job.filename,
      bytesReceived: job.bytesReceived, totalBytes: job.totalBytes,
      resumedFrom: job.resumedFrom, status: job.status, pct, error: job.error,
      bytesPerSec: job.status === "downloading" ? job.bytesPerSec : null,
    });
  }
  res.json({ data: jobs });
});

// DELETE /hub/downloads/:id — abort, keep .part for resume
router.delete("/hub/downloads/:id", requireAdminToken, (req, res) => {
  const job = hubDownloadJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status === "downloading" || job.status === "pending") {
    job.abortController.abort();
  }
  res.json({ ok: true, id: job.id, partKept: true });
});

// DELETE /hub/downloads/:id/discard — remove job and delete .part file
router.delete("/hub/downloads/:id/discard", requireAdminToken, (req, res) => {
  const job = hubDownloadJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status === "downloading" || job.status === "pending") {
    job.abortController.abort();
  }
  try { fs.unlinkSync(job.partPath); } catch { /* already gone */ }
  try { fs.unlinkSync(job.metaPath); } catch { /* already gone */ }
  hubDownloadJobs.delete(job.id);
  res.json({ ok: true, id: job.id });
});

export default router;
