import { state } from "./state.js";
import { resolveInstanceByModelName } from "./routing.js";
import { instanceBaseUrl } from "./urls.js";
import { compressMessages, mergeCompressionConfig } from "./compress.js";
import { proxyToInstance } from "./proxy.js";
import { proxyToFrontier } from "./frontier.js";

const DEFAULT_PANEL_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Internal: call a backend non-streaming and return the assistant text
// ---------------------------------------------------------------------------

async function callPanelForText(backend, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let url, headers, outBody;

    if (backend.type === "local") {
      const resolved = resolveInstanceByModelName(backend.model);
      if (resolved.error) throw new Error(resolved.error);
      url = `${instanceBaseUrl(resolved.instance)}/v1/chat/completions`;
      headers = { "content-type": "application/json" };
      outBody = { ...body, stream: false };
    } else if (backend.type === "frontier") {
      const fb = (state.frontierBackends || []).find((b) => b.id === backend.backendId);
      if (!fb) throw new Error(`Frontier backend "${backend.backendId}" not found`);
      const basePath = String(fb.baseUrl || "").replace(/\/$/, "");
      url = `${basePath}/chat/completions`;
      const rawKey = fb.apiKey || "";
      const resolvedKey = rawKey.startsWith("$") ? (process.env[rawKey.slice(1)] || "") : rawKey;
      headers = {
        "content-type": "application/json",
        "authorization": `Bearer ${resolvedKey}`,
        ...(fb.extraHeaders || {})
      };
      outBody = { ...body, stream: false, model: fb.model };
    } else {
      throw new Error(`Unknown panel backend type: ${backend.type}`);
    }

    // Compress messages to keep panel calls from overflowing context
    const compressionCfg = mergeCompressionConfig(state.settings?.compression);
    const { messages: compressed } = compressMessages(outBody.messages, compressionCfg);
    if (compressed !== outBody.messages) outBody = { ...outBody, messages: compressed };

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(outBody),
      signal: controller.signal
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Panel responded HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (content == null) throw new Error("Panel response contained no content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public: dispatch a fusion backend
//
// fusionBackend shape:
//   panelBackends:    [{type, model|backendId}, ...]   — run in parallel
//   judgeBackend:     {type, model|backendId} | null   — defaults to panelBackends[0]
//   judgeSystemPrompt: string | null                   — appended to system message
//   panelTimeoutMs:   number | null                    — per-panel timeout (default 120s)
// ---------------------------------------------------------------------------

export async function dispatchFusion(fusionBackend, req, res) {
  const panels = Array.isArray(fusionBackend.panelBackends) ? fusionBackend.panelBackends : [];
  if (panels.length < 2) {
    res.status(500).json({ error: { message: "Fusion requires at least 2 panelBackends", type: "server_error" } });
    return;
  }

  const judgeBackend = fusionBackend.judgeBackend || panels[0];
  const panelTimeoutMs = Number(fusionBackend.panelTimeoutMs) || DEFAULT_PANEL_TIMEOUT_MS;
  const judgeSystemPrompt = typeof fusionBackend.judgeSystemPrompt === "string"
    ? fusionBackend.judgeSystemPrompt.trim() : null;
  const originalBody = req.body || {};

  // ── Step 1: run all panels in parallel ───────────────────────────────────
  console.log(`[fusion] firing ${panels.length} panels in parallel`);
  const startedAt = Date.now();

  const panelResults = await Promise.allSettled(
    panels.map((p) => callPanelForText(p, originalBody, panelTimeoutMs))
  );

  const succeeded = [];
  const failed = [];
  for (let i = 0; i < panelResults.length; i++) {
    const r = panelResults[i];
    const label = panels[i].model || panels[i].backendId || `panel-${i}`;
    if (r.status === "fulfilled") {
      succeeded.push({ label, text: r.value });
    } else {
      failed.push(label);
      console.warn(`[fusion] panel "${label}" failed: ${r.reason?.message}`);
    }
  }

  console.log(`[fusion] panels done in ${Date.now() - startedAt}ms — ${succeeded.length} ok, ${failed.length} failed`);

  if (succeeded.length === 0) {
    res.status(502).json({ error: { message: "All fusion panels failed to respond", type: "proxy_error" } });
    return;
  }

  // ── Step 2: build judge context ──────────────────────────────────────────
  // Judge flow (Option B):
  //   original messages
  //   + assistant: judge's own panel response (succeeded[0], assumed to be the judge's model)
  //   + user:      "Another model said: [B's response]. Revise your answer incorporating the best insights."
  //
  // If only one panel succeeded, we skip synthesis and just forward that response.

  let judgeMessages;

  if (succeeded.length === 1) {
    // Only one panel made it — forward directly without synthesis
    judgeMessages = [
      ...(originalBody.messages || []),
      { role: "assistant", content: succeeded[0].text },
      {
        role: "user",
        content: "Please review your response above and confirm or refine it as your final answer."
      }
    ];
  } else {
    // Build the "revise with peer input" turn
    const peerResponses = succeeded.slice(1).map((p, i) => {
      const letter = String.fromCharCode(66 + i); // B, C, D...
      return `[Model ${letter}: ${p.label}]\n${p.text}`;
    }).join("\n\n---\n\n");

    const failureNote = failed.length > 0
      ? `\n\nNote: ${failed.join(", ")} timed out and could not contribute.`
      : "";

    judgeMessages = [
      ...(originalBody.messages || []),
      { role: "assistant", content: succeeded[0].text },
      {
        role: "user",
        content:
          `Another model analyzed this same request independently:\n\n${peerResponses}${failureNote}\n\n` +
          `Compare this analysis with your response above. Incorporate any stronger insights or corrections, ` +
          `fix any errors, and produce the single best final answer. ` +
          `Do not reference this comparison or deliberation process in your response.`
      }
    ];
  }

  // Inject judgeSystemPrompt into the system message if provided
  if (judgeSystemPrompt) {
    const sysIdx = judgeMessages.findIndex((m) => m.role === "system");
    if (sysIdx >= 0) {
      judgeMessages = judgeMessages.map((m, i) =>
        i === sysIdx ? { ...m, content: `${m.content}\n\n${judgeSystemPrompt}` } : m
      );
    } else {
      judgeMessages = [{ role: "system", content: judgeSystemPrompt }, ...judgeMessages];
    }
  }

  // ── Step 3: dispatch judge (streaming, piped to client) ──────────────────
  req.body = { ...originalBody, messages: judgeMessages };

  if (judgeBackend.type === "local") {
    const resolved = resolveInstanceByModelName(judgeBackend.model);
    if (resolved.error) {
      res.status(resolved.status).json({ error: { message: resolved.error, type: "invalid_request_error" } });
      return;
    }
    const targetUrl = `${instanceBaseUrl(resolved.instance)}/v1/chat/completions`;
    await proxyToInstance(resolved.instance, req, res, targetUrl);
  } else if (judgeBackend.type === "frontier") {
    const fb = (state.frontierBackends || []).find((b) => b.id === judgeBackend.backendId);
    if (!fb) {
      res.status(502).json({ error: { message: "Judge frontier backend not found", type: "server_error" } });
      return;
    }
    await proxyToFrontier(fb, req, res, null);
  } else {
    res.status(500).json({ error: { message: `Unknown judge backend type: ${judgeBackend.type}`, type: "server_error" } });
  }
}
