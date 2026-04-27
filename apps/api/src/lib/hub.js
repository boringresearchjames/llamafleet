import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { modelsDir } from "./config.js";

export const hubDownloadJobs = new Map();

export function parseQuantTier(filename) {
  const f = filename.toUpperCase();
  if (/IQ[234]_[A-Z0-9_]+/.test(f)) return { tier: "imatrix", label: f.match(/IQ[234]_[A-Z0-9_]+/)[0] };
  if (/Q8_0/.test(f)) return { tier: "quality", label: "Q8_0" };
  if (/Q6_K/.test(f)) return { tier: "quality", label: "Q6_K" };
  if (/Q5_K_M/.test(f)) return { tier: "balanced", label: "Q5_K_M" };
  if (/Q5_K_S/.test(f)) return { tier: "balanced", label: "Q5_K_S" };
  if (/Q5_K/.test(f)) return { tier: "balanced", label: "Q5_K" };
  if (/Q4_K_M/.test(f)) return { tier: "recommended", label: "Q4_K_M" };
  if (/Q4_K_S/.test(f)) return { tier: "recommended", label: "Q4_K_S" };
  if (/Q4_K/.test(f)) return { tier: "recommended", label: "Q4_K" };
  if (/IQ4_XS/.test(f)) return { tier: "recommended", label: "IQ4_XS" };
  if (/Q4_0/.test(f)) return { tier: "recommended", label: "Q4_0" };
  if (/Q3_K_M/.test(f)) return { tier: "imatrix", label: "Q3_K_M" };
  if (/Q2_K/.test(f)) return { tier: "imatrix", label: "Q2_K" };
  if (/BF16/.test(f)) return { tier: "large", label: "BF16" };
  if (/F16/.test(f)) return { tier: "large", label: "F16" };
  if (/F32/.test(f)) return { tier: "large", label: "F32" };
  const qMatch = f.match(/[QIq]\d[_A-Z0-9]*/);
  if (qMatch) return { tier: "other", label: qMatch[0] };
  return { tier: "other", label: "GGUF" };
}

const HF_API = "https://huggingface.co";

export async function hfFetch(urlPath, hfToken) {
  const headers = { "User-Agent": "LlamaFleet/1.0" };
  if (hfToken) headers["Authorization"] = `Bearer ${hfToken}`;
  const res = await fetch(`${HF_API}${urlPath}`, { headers });
  if (!res.ok) throw Object.assign(new Error(`HF API ${res.status}`), { status: res.status });
  return res;
}

/**
 * Fire-and-forget async download. The job object is mutated in-place so
 * callers that hold a reference to the same object in hubDownloadJobs will
 * see live progress updates.
 */
export async function executeHubDownload(job, hfToken) {
  const { repoId, filename: safeFilename, destPath, partPath, metaPath } = job;
  let resumedFrom = job.resumedFrom;
  let fileHandle = null;
  let reader = null;

  try {
    job.status = "downloading";
    const dlUrl = `${HF_API}/${repoId}/resolve/main/${encodeURIComponent(safeFilename)}?download=true`;
    const headers = { "User-Agent": "LlamaFleet/1.0" };
    if (hfToken) headers["Authorization"] = `Bearer ${hfToken}`;
    if (resumedFrom > 0) headers["Range"] = `bytes=${resumedFrom}-`;

    const dlRes = await fetch(dlUrl, { headers, signal: job.abortController.signal, redirect: "follow" });
    if (!dlRes.ok) throw new Error(`HF download ${dlRes.status}`);

    // If server responded 200 despite a range request, restart from zero
    if (resumedFrom > 0 && dlRes.status === 200) {
      resumedFrom = 0;
      job.bytesReceived = 0;
    }

    const contentLength = dlRes.headers.get("content-length");
    job.totalBytes = contentLength ? resumedFrom + Number(contentLength) : null;

    fileHandle = fs.createWriteStream(partPath, { flags: resumedFrom > 0 ? "a" : "w" });
    let streamErr = null;
    fileHandle.on("error", (err) => { streamErr = err; });

    reader = dlRes.body.getReader();
    let abortReject;
    const abortRace = new Promise((_, reject) => { abortReject = reject; });
    const onAbort = () => {
      reader.cancel().catch(() => {});
      const e = new Error("Paused");
      e.name = "AbortError";
      abortReject(e);
    };
    job.abortController.signal.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), abortRace]);
        if (done) break;
        if (streamErr) throw streamErr;
        const canContinue = fileHandle.write(value);
        job.bytesReceived += value.length;
        const rateNow = Date.now();
        const rateElapsed = (rateNow - job._rateAt) / 1000;
        if (rateElapsed >= 1.0) {
          job.bytesPerSec = Math.round((job.bytesReceived - job._rateBytes) / rateElapsed);
          job._rateAt = rateNow;
          job._rateBytes = job.bytesReceived;
        }
        if (!canContinue) await new Promise((resolve) => fileHandle.once("drain", resolve));
      }
    } finally {
      job.abortController.signal.removeEventListener("abort", onAbort);
    }

    if (streamErr) throw streamErr;
    if (job.abortController.signal.aborted) {
      const e = new Error("Paused");
      e.name = "AbortError";
      throw e;
    }

    await new Promise((resolve, reject) => fileHandle.end((err) => (err ? reject(err) : resolve())));
    fileHandle = null;

    try { fs.unlinkSync(metaPath); } catch { /* already gone */ }
    fs.renameSync(partPath, destPath);
    job.status = "done";
  } catch (err) {
    if (fileHandle && !fileHandle.destroyed) {
      try { await new Promise((resolve) => fileHandle.end(resolve)); } catch { fileHandle.destroy(); }
    }
    if (reader) { try { reader.cancel().catch(() => {}); } catch { /* ignore */ } }
    if (err.name === "AbortError") {
      job.status = "paused";
    } else {
      job.status = "error";
      job.error = err.message;
    }
  }
}

export function restorePartialDownloads() {
  const home = os.homedir();
  const dir = path.resolve(modelsDir.replace(/^~/, home));
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }

  for (const name of entries) {
    if (!name.endsWith(".gguf.part")) continue;
    const partPath = path.join(dir, name);
    const metaPath = partPath + ".meta.json";
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { continue; }
    if (!meta.repoId || !meta.filename) continue;

    const destPath = partPath.slice(0, -5); // strip ".part"
    const alreadyTracked = [...hubDownloadJobs.values()].some((j) => j.destPath === destPath);
    if (alreadyTracked) continue;

    let size = 0;
    try { size = fs.statSync(partPath).size; } catch { /* ignore */ }

    const jobId = crypto.randomUUID();
    hubDownloadJobs.set(jobId, {
      id: jobId, repoId: meta.repoId, filename: meta.filename,
      destPath, partPath, metaPath,
      bytesReceived: size, totalBytes: null, resumedFrom: size,
      status: "paused", error: null, abortController: new AbortController(),
      bytesPerSec: null, _rateAt: Date.now(), _rateBytes: size,
    });
    console.log(`Restored paused download: ${meta.repoId}/${meta.filename} (${size} bytes)`);
  }
}
