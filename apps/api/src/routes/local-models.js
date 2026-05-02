import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { modelsDir } from "../lib/config.js";
import { requireAdminToken } from "../lib/auth.js";

const router = express.Router();

router.get("/local-models", (_req, res) => {
  const home = os.homedir();
  const primaryDir = path.resolve(modelsDir.replace(/^~/, home));

  const extraDirs = [
    { dir: path.join(home, ".ollama", "models"), tag: "ollama" },
    { dir: "/usr/share/ollama/.ollama/models", tag: "ollama" },
    { dir: path.join(home, ".cache", "huggingface", "hub"), tag: "huggingface" },
    { dir: path.join(home, "unsloth_studio"), tag: "unsloth" },
  ];

  const seen = new Set();
  const results = [];
  const dirsScanned = [];

  function walk(dir, baseDir, tagPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, baseDir, tagPrefix);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);
        const lower = entry.name.toLowerCase();
        const shardMatch = lower.match(/-(\d{5})-of-(\d{5})\.gguf$/);
        if (shardMatch && shardMatch[1] !== "00001") continue;
        const rel = path.relative(baseDir, fullPath);
        const name = tagPrefix ? `[${tagPrefix}] ${rel}` : rel;
        const shards = shardMatch ? parseInt(shardMatch[2], 10) : null;
        let size = null;
        let downloading = false;
        try {
          if (shards) {
            let total = 0;
            for (let i = 1; i <= shards; i++) {
              const shardPath = fullPath.replace(/-\d{5}-of-/i, `-${String(i).padStart(5, "0")}-of-`);
              if (!fs.existsSync(shardPath)) downloading = true;
              try { total += fs.statSync(shardPath).size; } catch { /* skip missing shard */ }
            }
            size = total || null;
          } else {
            const partPath = path.join(path.dirname(fullPath), `downloading_${entry.name}.part`);
            if (fs.existsSync(partPath)) downloading = true;
            size = fs.statSync(fullPath).size;
          }
        } catch { /* ignore */ }
        const mmproj = /(?:^|[-_\/\\])mmproj[-_]/i.test(entry.name);
        results.push({ id: fullPath, name, shards, size, downloading, mmproj });
      }
    }
  }

  if (fs.existsSync(primaryDir)) {
    dirsScanned.push(primaryDir);
    walk(primaryDir, primaryDir, null);
  }

  for (const { dir, tag } of extraDirs) {
    if (dir === primaryDir || !fs.existsSync(dir)) continue;
    dirsScanned.push(dir);
    walk(dir, dir, tag);
  }

  if (results.length === 0 && dirsScanned.length === 0) {
    return res.json({ data: [], warning: `Models directory not found: ${primaryDir}` });
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return res.json({ data: results, dir: primaryDir, dirs: dirsScanned });
});

router.delete("/local-models", requireAdminToken, express.json(), (req, res) => {
  const home = os.homedir();
  const primaryDir = path.resolve(modelsDir.replace(/^~/, home));
  const extraDirs = [
    path.join(home, ".ollama", "models"),
    "/usr/share/ollama/.ollama/models",
    path.join(home, ".cache", "huggingface", "hub"),
    path.join(home, "unsloth_studio"),
  ];
  const allowedRoots = [primaryDir, ...extraDirs];

  const filePath = req.body?.path;
  if (!filePath || typeof filePath !== "string") {
    return res.status(400).json({ error: "path is required" });
  }

  const resolved = path.resolve(filePath);

  // Must end in .gguf
  if (!resolved.toLowerCase().endsWith(".gguf")) {
    return res.status(400).json({ error: "only .gguf files may be deleted" });
  }

  // Must be under one of the allowed scan roots (prevents path traversal)
  const underAllowed = allowedRoots.some((root) => resolved.startsWith(root + path.sep) || resolved === root);
  if (!underAllowed) {
    return res.status(403).json({ error: "path is outside allowed model directories" });
  }

  try {
    fs.unlinkSync(resolved);
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "file not found" });
    return res.status(500).json({ error: String(err.message) });
  }

  // Clean up any associated sidecar files (partial downloads, meta)
  for (const sidecar of [`${resolved}.part`, `${resolved}.part.meta.json`]) {
    try { fs.unlinkSync(sidecar); } catch { /* ignore missing */ }
  }

  return res.json({ success: true, deleted: resolved });
});

export default router;
