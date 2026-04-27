import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Minimal markdown → HTML renderer for /help. Only handles patterns used in docs/api.md.
function renderApiDocs(md) {
  const blocks = [];
  const save = (html) => { blocks.push(html); return `\x00B${blocks.length - 1}\x00`; };

  // Fenced code blocks
  md = md.replace(/```(?:\w+)?\n([\s\S]*?)```/gm, (_, c) =>
    save(`<pre>${c.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</pre>`));
  // Inline code
  md = md.replace(/`([^`\n]+)`/g, (_, c) =>
    save(`<code>${c.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</code>`));

  // Escape remaining HTML
  md = md.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  // Tables (simple: | col | col |)
  md = md.replace(/((?:^\|.+\|\n)+)/gm, (table) => {
    const rows = table.trim().split("\n").filter(r => !/^\|[-| ]+\|$/.test(r));
    const toRow = (r, tag) => `<tr>${r.replace(/^\||\|$/g,"").split("|")
      .map(c => `<${tag}>${c.trim()}</${tag}>`).join("")}</tr>`;
    return save(`<table>${rows.map((r,i) => toRow(r, i===0?"th":"td")).join("")}</table>`);
  });

  const METHOD_COLORS = { GET:"#4cdb8e", POST:"#5ca5ff", PUT:"#ffbe5c", DELETE:"#ff5c7a", PATCH:"#c084fc", DEL:"#ff5c7a" };
  const methodBadge = (m) => {
    const c = METHOD_COLORS[m] || "#9fb0d8";
    return save(`<span style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:700;font-family:monospace;background:${c}22;color:${c};margin-right:6px">${m}</span>`);
  };

  // Headings — detect METHOD /path pattern in h3/h4
  md = md.replace(/^### (GET|POST|PUT|DELETE|PATCH|DEL) (.+)$/gm,
    (_, m, rest) => `<h3>${methodBadge(m)}<code>${rest.replace(/\s\*\*\[admin\]\*\*/,"")}</code>${rest.includes("**[admin]**") ? save(`<span style="font-size:10px;background:rgba(255,190,92,.15);color:#ffbe5c;border:1px solid rgba(255,190,92,.3);border-radius:3px;padding:1px 5px;margin-left:6px">admin</span>`) : ""}</h3>`);
  md = md.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  md = md.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  md = md.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Inline formatting
  md = md.replace(/\*\*\[admin\]\*\*/g, save(`<span style="font-size:10px;background:rgba(255,190,92,.15);color:#ffbe5c;border:1px solid rgba(255,190,92,.3);border-radius:3px;padding:1px 5px;margin-left:6px">admin</span>`));
  md = md.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  md = md.replace(/\*(.+?)\*/g, "<em>$1</em>");
  md = md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a href="$2">$1</a>`);

  // HR
  md = md.replace(/^---$/gm, "<hr>");

  // Lists
  md = md.replace(/^- (.+)$/gm, "<li>$1</li>");
  md = md.replace(/(<li>[\s\S]*?<\/li>)(\n(?!<li>))/g, "$1</ul>\n");
  md = md.replace(/(<li>)/, "<ul>$1");

  // Paragraphs
  md = md.split(/\n\n+/).map(chunk => {
    chunk = chunk.trim();
    if (!chunk) return "";
    if (/^<(h[1-4]|hr|ul|pre|table)/.test(chunk)) return chunk;
    return `<p>${chunk.replace(/\n/g, " ")}</p>`;
  }).join("\n");

  // Restore blocks
  return md.replace(/\x00B(\d+)\x00/g, (_, i) => blocks[+i]);
}

const router = express.Router();

router.get("/help", (_req, res) => {
  const docsPath = path.resolve(__dirname, "../../../../docs/api.md");
  let md;
  try { md = fs.readFileSync(docsPath, "utf8"); }
  catch { return res.status(500).send("API reference not found. Expected at docs/api.md"); }

  // Strip leading h1 + first paragraph (rendered in the HTML header instead)
  md = md.replace(/^#[^\n]*\n+[^\n#]+\n+---\n+/, "");

  const body = renderApiDocs(md);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LlamaFleet — API Reference</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🦙</text></svg>" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
  <style>
    :root { --bg-0:#06070b; --bg-1:#0b1020; --bg-2:#111936; --border:rgba(154,181,255,0.22); --ink:#e7eeff; --muted:#9fb0d8; --accent:#5ca5ff; --accent-2:#7df8dd; }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; }
    body { color: var(--ink); font-family: "Manrope", "Segoe UI", sans-serif; background: linear-gradient(165deg, var(--bg-0) 0%, var(--bg-1) 45%, var(--bg-2) 100%); line-height: 1.6; }
    .bg-grid { pointer-events:none; position:fixed; inset:0; background-image:linear-gradient(rgba(130,162,255,0.055) 1px,transparent 1px),linear-gradient(90deg,rgba(130,162,255,0.055) 1px,transparent 1px); background-size:30px 30px; mask-image:radial-gradient(circle at center,black 35%,transparent 100%); z-index:0; }
    .bg-orb { pointer-events:none; position:fixed; border-radius:999px; filter:blur(10px); opacity:0.5; z-index:0; }
    .orb-a { width:460px; height:460px; left:-120px; top:-130px; background:radial-gradient(circle at center,rgba(92,165,255,0.5),rgba(92,165,255,0)); }
    .orb-b { width:420px; height:420px; right:-120px; bottom:-150px; background:radial-gradient(circle at center,rgba(125,248,221,0.4),rgba(125,248,221,0)); }
    .topbar { position:relative; z-index:1; max-width:900px; margin:0 auto; padding:32px 28px 20px; border-bottom:1px solid rgba(154,181,255,0.12); }
    .badge { display:inline-block; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:var(--accent); background:rgba(92,165,255,0.1); border:1px solid rgba(92,165,255,0.25); border-radius:6px; padding:2px 8px; margin-bottom:6px; }
    .topbar h1 { font-size:28px; font-weight:800; margin:0 0 4px; line-height:1.1; }
    .topbar p { font-size:13px; color:var(--muted); margin:0; }
    .content { position:relative; z-index:1; max-width:900px; margin:0 auto; padding:28px 28px 60px; }
    h2 { font-size:14px; font-weight:700; margin:32px 0 8px; color:var(--accent-2); border-bottom:1px solid rgba(125,248,221,0.18); padding-bottom:4px; letter-spacing:0.04em; text-transform:uppercase; }
    h3 { font-size:13px; font-weight:600; margin:20px 0 4px; color:var(--muted); }
    p, li { font-size:13px; color:#c4d2f4; margin:4px 0; }
    ul { padding-left:20px; }
    code { font-family:"JetBrains Mono",Consolas,monospace; font-size:12px; background:rgba(92,165,255,0.12); padding:1px 5px; border-radius:4px; color:#9dd8ff; }
    pre { background:rgba(5,8,19,0.8); border:1px solid rgba(159,176,216,0.2); border-radius:8px; padding:12px; font-family:"JetBrains Mono",Consolas,monospace; font-size:12px; color:#c4d2f4; overflow-x:auto; white-space:pre-wrap; margin:8px 0; }
    a { color:var(--accent); }
    hr { border:none; border-top:1px solid rgba(159,176,216,0.12); margin:24px 0; }
    strong { color:var(--ink); }
    table { border-collapse:collapse; width:100%; margin:8px 0; font-size:12px; }
    th, td { text-align:left; padding:5px 10px; border:1px solid rgba(159,176,216,0.15); color:#c4d2f4; }
    th { background:rgba(92,165,255,0.08); color:var(--muted); }
  </style>
</head>
<body>
<div class="bg-orb orb-a"></div>
<div class="bg-orb orb-b"></div>
<div class="bg-grid"></div>
<header class="topbar">
  <div class="badge">API Reference</div>
  <h1>Llama<span style="color:var(--accent)">Fleet</span></h1>
  <p>All endpoints require <code>Authorization: Bearer &lt;token&gt;</code> when auth is enabled. Endpoints marked <span style="font-size:10px;background:rgba(255,190,92,.15);color:#ffbe5c;border:1px solid rgba(255,190,92,.3);border-radius:3px;padding:1px 5px">admin</span> require the server API token.</p>
</header>
<div class="content">
${body}
</div>
</body>
</html>`);
});

export default router;
