# Plan: Model Orchestration Layer for LlamaFleet

## TL;DR

Add a new concept — **Orchestration Routes** — virtual model names that appear in `/v1/models` and route requests to different backends (local llamafleet instances or OpenAI-compatible frontier APIs) based on static rules evaluated in order, with an optional LLM classifier as a fallback. Zero changes to how existing instances/routing work.

A tool like opencode calls `POST /v1/chat/completions` with `model: "opencode"`. The new layer intercepts before `resolveInstanceByModelName()`, evaluates the route's rules, and forwards to the winning backend. The route is fully transparent to the caller.

**Example routes:**

| Virtual model | Rule | Backend |
|---|---|---|
| `opencode` | `toolsPresent = true` | local `qwen3-35b` |
| `opencode` | *(default)* | frontier `openrouter/kimi2` |
| `hermesagent` | `toolsPresent = true` | local `qwen3-35b` (same pool) |
| `hermesagent` | *(default)* | frontier `openrouter/qwen3-max` |
| `devagent` | `toolNameContains = "execute_command"` | local `gemma4` (terminal tool) |
| `devagent` | `toolNameContains = "web_search"` | local `qwen3-6b` (web search) |
| `devagent` | `toolsPresent = true` | local `qwen3-35b` (any other tool) |
| `devagent` | *(default)* | local `minimax` (planning, no tools) |

Routes can mix and match any combination of local models and frontier APIs. Multiple routes can point at the same local instance pool simultaneously.

---

## Phase 1 — State & Config (foundation)

1. Extend `apps/api/src/lib/state.js` — add `orchestrationRoutes: []` and `frontierBackends: []` to default state
2. Extend shared-config.yaml export in `apps/api/src/lib/config.js` — serialize both fields; **exclude `apiKey`** from frontierBackends in export (same pattern as existing secret exclusions)
3. Add `FRONTIER_TIMEOUT_MS=30000` constant to `apps/api/src/lib/config.js`

**Core data shapes:**

```
OrchestrationRoute: {
  id, name, description,
  rules: [ { id, conditions: [{type, value}], backend } ],
  classifierRule: { model, systemPrompt, mapping: {label: backend} } | null,
  defaultBackend: backend,
  fallbackBackend: backend | null,   ← tried if primary backend errors or local instance unhealthy
  createdAt, updatedAt
}

FrontierBackend: {
  id, name, baseUrl, apiKey (excluded from export), model,
  headersTimeoutMs,
  requestDefaults: { temperature, max_tokens, top_p, ... } | null,  ← merged into outgoing body
  extraHeaders: { "HTTP-Referer": "...", "X-Title": "..." } | null, ← required by OpenRouter
  costPer1kInputTokens: number | null,   ← for cost tracking display (e.g. 0.0014 for Kimi2)
  costPer1kOutputTokens: number | null
}

FrontierBackendStats: {  ← tracked in state, never persisted (reset on restart)
  backendId,
  inflightRequests, totalRequests,
  totalInputTokens, totalOutputTokens,
  estimatedCostUsd,               ← running total since last restart
  localRequestsLastHour,          ← per-route rollup for cost display
  frontierRequestsLastHour
}

backend: { type: "local", model: "ModelName" }
       | { type: "frontier", backendId: "uuid" }

Condition types:
  toolsPresent         — checks BOTH tools.length > 0 AND tool_choice being set
                         (some clients send tool_choice:"auto" without a tools array)
  toolNameContains     — substring match against tools[].function.name array
                         allows routing by specific tool: "execute_command" → gemma4,
                         "web_search" → qwen3-6b, etc. Rules evaluated top-down so
                         specific tool rules should come before generic toolsPresent rules
  systemPromptContains — string match on messages[0].content where role=system
  messageContains      — string match on any message content
  estimatedTokens      — gt/lt against chars/4 heuristic across all messages
                         USE AS SAFETY VALVE: e.g. gt:6000 routes long agentic contexts
                         to frontier before local model hits its configured contextLength
                         (opencode loops grow fast — prevents choking mid-task)
  multiTurnDepth       — gt/lt against messages.length
```

---

## Phase 2 — Core Logic (new files, parallel)

4. **Create `apps/api/src/lib/orchestration.js`**
   - `matchOrchestrationRoute(modelName)` — look up by name in state
   - `evaluateStaticRules(route, body)` — iterate rules in order; return first matching rule's backend or null; `toolNameContains` checks `body.tools[].function.name` for substring match
   - `evaluateClassifier(classifierRule, body)` — POST to local model (`max_tokens:20, temp:0`, 5s timeout); parse label → backend; on timeout return null (never throws)
   - `resolveBackend(route, body)` — static rules → classifier if configured → defaultBackend
   - `estimateTokens(messages)` — chars/4 heuristic

5. **Create `apps/api/src/lib/frontier.js`**
   - `proxyToFrontier(backend, req, res)` — forward to `backend.baseUrl` with `Authorization: Bearer <apiKey>` injected
   - **Rewrite `req.body.model`** from the virtual name to `backend.model` before forwarding
   - Merge `backend.requestDefaults` into request body (caller values win on conflict)
   - Inject `backend.extraHeaders` into outgoing request headers (needed for OpenRouter `HTTP-Referer` / `X-Title`)
   - Reuse buffered SSE streaming pattern from `apps/api/src/lib/proxy.js`
   - Track per-backend inflight and token metrics in state
   - **Known limitation**: if a backend errors after streaming has begun (headers already sent), fallback is impossible — error is logged but the partial stream is closed. Fallback only applies before the first byte is sent.

---

## Phase 3 — API Integration (depends on Phase 1 & 2)

6. **Create `apps/api/src/routes/orchestration.js`** — CRUD:
   - `GET/POST /api/orchestration-routes`
   - `GET/PUT/DELETE /api/orchestration-routes/:id`
   - `GET/POST /api/frontier-backends` — GET masks `apiKey` → `"••••"`
   - `PUT/DELETE /api/frontier-backends/:id`

7. **Modify `apps/api/src/routes/models.js`** — append orchestration route names to `/v1/models` response with `{ id: name, type: "orchestration" }`

8. **Modify `apps/api/src/index.js`** — add pre-check before `resolveInstanceByModelName()` in the completions handler:
   ```
   const orchRoute = matchOrchestrationRoute(model)
   if (orchRoute) {
     const backend = await resolveBackend(orchRoute, req.body)  // static → classifier → default
     try {
       if (backend.type === "local")    → resolveInstanceByModelName(backend.model) → proxyToInstance
       if (backend.type === "frontier") → proxyToFrontier(getFrontierBackend(backend.backendId), req, res)
     } catch (err) {
       if (orchRoute.fallbackBackend) → retry once with fallbackBackend
       else rethrow
     }
     audit("orchestration.routed", { route: orchRoute.name, backend, ruleMatched, latencyMs })
   }
   // else fall through to existing routing unchanged
   ```
   - Fallback only triggers on errors *before* streaming begins (see frontier.js limitation above)
   - For local backends, also check instance health before attempting — skip to fallback if all matching instances are unhealthy
   - Also mount the orchestration CRUD router at `/api`

---

## Phase 4 — Web UI (depends on Phase 3)

9. **Create `apps/web/components/lf-orchestration-panel.js`** — Web Component, follow `lf-instances-panel.js` conventions:
   - Routes list: name, rule count, default backend label, edit/delete actions
   - Route editor dialog: name, description, ordered rule list with up/down reorder buttons, default backend picker, optional fallback backend picker, optional classifier config
   - Rule row: condition-type dropdown → value input → backend picker (local model names from `/v1/models` filtered to non-orchestration type, or frontier backend)
   - UI note: warn when a generic `toolsPresent` rule appears before a `toolNameContains` rule (the specific rule would never fire)
   - Frontier Backends section: list with masked keys, add/edit form (name, baseUrl, model, apiKey, requestDefaults JSON field, extraHeaders JSON field, costPer1kInputTokens, costPer1kOutputTokens)
   - **Cost summary bar**: per-route display showing local vs frontier request split and estimated cost in the last hour — makes savings visible at a glance

10. **Modify `apps/web/app.js`** — register new component, add "Orchestration" nav entry
11. **Modify `apps/web/styles.css`** — panel and rule editor styles

---

## Relevant Files

| File | Purpose |
|---|---|
| `apps/api/src/lib/state.js` | Add new state keys |
| `apps/api/src/lib/config.js` | Config constants + export exclusions |
| `apps/api/src/lib/routing.js` | Reference for `resolveInstanceByModelName` (reuse, don't modify) |
| `apps/api/src/lib/proxy.js` | Reference streaming proxy pattern (reuse in frontier.js) |
| `apps/api/src/index.js` | Intercept completions before existing routing |
| `apps/api/src/routes/models.js` | Extend model list response |
| `apps/web/components/lf-instances-panel.js` | UI template/pattern to follow |
| `apps/web/app.js` | Register new component + nav |
| `apps/web/styles.css` | UI styles |

---

## Verification

1. Unit-test `evaluateStaticRules()` with `toolsPresent` condition → correct backend returned
2. Unit-test `toolsPresent` with `tool_choice:"auto"` and no `tools` array → still matches
3. Unit-test `toolNameContains = "execute_command"` → matches only when that tool name is present
4. Unit-test `estimatedTokens gt 6000` with a long message array → routes to correct backend
5. Unit-test fallback: primary backend throws → fallbackBackend is used instead
6. POST a route + frontier backend via API → name appears in `/v1/models`
7. `POST /v1/chat/completions` with `model:"opencode"` + `tools:[...]` → confirm routes to local model
8. Same request without tools → confirm routes to frontier backend; verify `model` field in forwarded body is rewritten to `backend.model`
9. Verify `extraHeaders` (e.g. `HTTP-Referer`) appear in outgoing frontier request
10. Verify `requestDefaults` are merged, caller values win on conflict
11. Build a message array > 6000 estimated tokens → confirm safety valve routes to frontier
12. Configure classifier rule → send ambiguous prompt → verify classifier fires and maps label
13. Audit log: confirm `orchestration.routed` entry with correct `ruleMatched` and `latencyMs`
14. UI: create/edit/delete route, verify persistence across service restart

---

## Decisions

- API keys live in `state.json` only; stripped from shared-config.yaml export
- Classifier timeout = 5s; always falls through to `defaultBackend` silently — never hard-fails a request
- Static rules always evaluated first; classifier only runs when no rule matched and `classifierRule` is configured
- Fallback triggers on pre-stream errors only — mid-stream backend failure closes the stream and logs; no retry possible
- `requestDefaults` merge strategy: caller-supplied values win over backend defaults (non-destructive injection)
- Only OpenAI-compatible frontier backends (no Anthropic adapter for now)
- Orchestration routes cannot reference other orchestration routes (no nesting)
- Only `/v1/chat/completions` is in scope — embeddings and raw completions not affected
- Rule ordering: simple up/down buttons in UI; UI warns if a broad rule shadows a specific one
- Default classifier system prompt: *"You are a routing classifier. Reply with exactly one word: the task category."* — overridable per route
- No rate-limit or cost budget tracking per frontier backend in this version (future phase)
- Prior art: LiteLLM (fallback chains, requestDefaults pattern), RouteLLM (classifier threshold concept), Portkey (virtual key concept)
- Rule ordering: simple ordered list with up/down buttons in UI (no drag-and-drop)
- Default classifier system prompt: *"You are a routing classifier. Reply with exactly one word: the task category."* — overridable per route

---

## Phase 5 — Routing Inspector

**Goal:** Give visibility into real orchestration decisions and let operators verify that rule changes would have produced the same outcome.

### Components

**In-memory request log (`orchestration.js`)**
- Module-level ring buffer, max 200 entries, resets on service restart (never persisted).
- Appended on every `orchestration.routed` event (after successful dispatch).
- Entry shape: `{ id, at, routeName, ruleId, backend, latencyMs, toolsPresent, toolCount, messageCount, estimatedTokens }`

**API endpoints (`routes/orchestration.js`)**
- `GET /api/orchestration-log` — returns `{ data: [...] }` newest-first.
- `POST /api/orchestration-routes/:id/simulate` — takes `{ messages, tools?, tool_choice? }`, evaluates current rules dry-run (no dispatch), returns full trace.

**Simulate trace shape:**
```
{
  routeId, routeName,
  resolvedBackend,   ← backend object that would be chosen now
  ruleId,            ← "default" or the matched rule id
  trace: [           ← one entry per rule, in order
    { ruleId, conditions: [{type, op, value, result}], matched }
  ],
  estimatedTokens, toolsPresent, toolCount, messageCount
}
```

**UI panel section (`lf-orchestration-panel.js`)**
- Third `orch-section` after Frontier Backends, rendered into a separate `.orch-log-section` div (so log refresh doesn't re-render the rest of the panel).
- Grid table: Time · Route · Rule badge · Backend badge · Latency · Meta chips (tools / messages / tokens).
- Auto-refreshes every 5 seconds via `setInterval`; manual Refresh button.
- **Simulate button** on each row — reconstructs a synthetic request body from stored metadata (tool stubs, message stubs sized to estimatedTokens) and calls the simulate endpoint, then shows:
  - Per-rule pass/fail chips for each condition.
  - Verdict: "Would route to X (same)" or "⚠ Rules changed: was X, now routes to Y".

### Key design decisions
- Log is in-memory only — no disk I/O, no state bloat. Survives only for the lifetime of the process.
- Simulate uses a synthetic body (not the original request body, which is not stored) — sufficient for all static condition types (toolsPresent, toolCount, estimatedTokens, messageCount).
- Log refresh is a lightweight separate fetch that only updates `.orch-log-section`; route/backend edits do a full `_load()` as before.
