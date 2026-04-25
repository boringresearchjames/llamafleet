import { createServer } from "http";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const host = process.env.WEB_HOST || "0.0.0.0";
const port = Number(process.env.WEB_PORT || 8080);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function safePath(urlPath) {
  const cleaned = urlPath.split("?")[0].split("#")[0];
  const normalized = path.normalize(cleaned).replace(/^([.][.][/\\])+/, "");
  if (normalized === "/" || normalized === "\\") {
    return path.join(__dirname, "index.html");
  }
  return path.join(__dirname, normalized.replace(/^[/\\]+/, ""));
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    let filePath = safePath(req.url || "/");
    let body;

    try {
      body = await readFile(filePath);
    } catch {
      filePath = path.join(__dirname, "index.html");
      body = await readFile(filePath);
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = contentTypes[ext] || "application/octet-stream";

    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store"
    });

    if (method === "HEAD") {
      res.end();
      return;
    }

    res.end(body);
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "internal_error", message: String(error.message || error) }));
  }
});

server.listen(port, host, () => {
  console.log(`lmlaunch web listening on ${host}:${port}`);
});
