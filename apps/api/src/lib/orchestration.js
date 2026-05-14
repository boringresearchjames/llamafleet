import { state } from "./state.js";

// ---------------------------------------------------------------------------
// Token estimation (chars / 4 heuristic)
// ---------------------------------------------------------------------------

export function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    if (typeof m?.content === "string") chars += m.content.length;
    else if (Array.isArray(m?.content)) {
      for (const part of m.content) {
        if (typeof part?.text === "string") chars += part.text.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

function evaluateCondition(condition, body) {
  const { type, op, value } = condition;
  switch (type) {
    case "toolsPresent": {
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const hasToolChoice = body.tool_choice !== undefined && body.tool_choice !== null;
      return hasTools || hasToolChoice;
    }
    case "toolNameContains": {
      if (!Array.isArray(body.tools) || !value) return false;
      const needle = String(value).toLowerCase();
      return body.tools.some((t) => String(t?.function?.name || "").toLowerCase().includes(needle));
    }
    case "systemPromptContains": {
      if (!value || !Array.isArray(body.messages)) return false;
      const sys = body.messages.find((m) => m?.role === "system");
      const content = typeof sys?.content === "string" ? sys.content : "";
      return content.toLowerCase().includes(String(value).toLowerCase());
    }
    case "messageContains": {
      if (!value || !Array.isArray(body.messages)) return false;
      const needle = String(value).toLowerCase();
      return body.messages.some((m) => {
        const c = m?.content;
        if (typeof c === "string") return c.toLowerCase().includes(needle);
        if (Array.isArray(c)) return c.some((p) => typeof p?.text === "string" && p.text.toLowerCase().includes(needle));
        return false;
      });
    }
    case "estimatedTokens": {
      const tokens = estimateTokens(body.messages);
      const threshold = Number(value);
      if (!Number.isFinite(threshold)) return false;
      return op === "gt" ? tokens > threshold : tokens < threshold;
    }
    case "multiTurnDepth": {
      const depth = Array.isArray(body.messages) ? body.messages.length : 0;
      const threshold = Number(value);
      if (!Number.isFinite(threshold)) return false;
      return op === "gt" ? depth > threshold : depth < threshold;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate all conditions in a rule (AND logic).
 */
function evaluateRule(rule, body) {
  if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) return false;
  return rule.conditions.every((c) => evaluateCondition(c, body));
}

/**
 * Walk rules in order; return the first matching rule's backend, or null.
 */
export function evaluateStaticRules(route, body) {
  if (!Array.isArray(route.rules)) return null;
  for (const rule of route.rules) {
    if (evaluateRule(rule, body)) return { backend: rule.backend, ruleId: rule.id };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classifier rule evaluation
// ---------------------------------------------------------------------------

/**
 * Call a local model to classify intent.
 * Returns the mapped backend or null (never throws).
 */
export async function evaluateClassifier(classifierRule, body) {
  if (!classifierRule?.model || !classifierRule?.mapping) return null;

  const systemPrompt = classifierRule.systemPrompt ||
    "You are a routing classifier. Reply with exactly one word: the task category.";

  // Build a compact representation of the request for classification
  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: (Array.isArray(body.messages) ? body.messages : [])
        .map((m) => {
          const content = typeof m?.content === "string" ? m.content :
            Array.isArray(m?.content) ? m.content.map((p) => p?.text || "").join(" ") : "";
          return `[${m?.role}] ${content}`;
        })
        .slice(-4) // last 4 turns only to keep it fast
        .join("\n")
    }
  ];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    // Determine base URL for local model call — use state to find instance
    const modelName = classifierRule.model;
    const instance = (state.instances || []).find(
      (inst) => inst.state === "ready" &&
        (inst.modelRouteName === modelName || inst.effectiveModel === modelName)
    );
    if (!instance) return null;

    const baseUrl = instance.proxyBaseUrl || `http://${instance.host}:${instance.port}`;

    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, messages, max_tokens: 20, temperature: 0 }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) return null;
    const data = await resp.json();
    const label = data?.choices?.[0]?.message?.content?.trim().toLowerCase();
    if (!label) return null;

    // Check mapping (case-insensitive key match)
    const mapping = classifierRule.mapping;
    for (const key of Object.keys(mapping)) {
      if (label.includes(key.toLowerCase())) return { backend: mapping[key], ruleId: "classifier" };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------

/**
 * Look up an orchestration route by virtual model name.
 * Returns the route object or null.
 */
export function matchOrchestrationRoute(modelName) {
  if (!modelName || !Array.isArray(state.orchestrationRoutes)) return null;
  return state.orchestrationRoutes.find((r) => r.name === modelName) || null;
}

/**
 * Resolve which backend to use for a given route and request body.
 * Order: static rules → classifier (if configured) → defaultBackend.
 * Always returns a backend object — never throws.
 */
export async function resolveBackend(route, body) {
  // 1. Static rules
  const staticMatch = evaluateStaticRules(route, body);
  if (staticMatch) return staticMatch;

  // 2. Classifier
  if (route.classifierRule) {
    const classifierMatch = await evaluateClassifier(route.classifierRule, body);
    if (classifierMatch) return classifierMatch;
  }

  // 3. Default
  return { backend: route.defaultBackend, ruleId: "default" };
}

/**
 * Look up a frontier backend by id.
 */
export function getFrontierBackend(backendId) {
  return (state.frontierBackends || []).find((b) => b.id === backendId) || null;
}
