import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, testBase, TEST_TOKEN } from "./helpers/server.js";

const auth = { Authorization: `Bearer ${TEST_TOKEN}` };
const jsonHeaders = { ...auth, "Content-Type": "application/json" };

beforeAll(startServer);
afterAll(stopServer);

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await fetch(`${testBase}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("api");
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("auth", () => {
  it("unauthenticated request returns 401", async () => {
    const res = await fetch(`${testBase}/v1/instances`);
    expect(res.status).toBe(401);
  });

  it("wrong token returns 401", async () => {
    const res = await fetch(`${testBase}/v1/instances`, {
      headers: { Authorization: "Bearer definitely-not-the-token" },
    });
    expect(res.status).toBe(401);
  });

  it("OPTIONS preflight is allowed without auth", async () => {
    const res = await fetch(`${testBase}/v1/instances`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

describe("GET /v1/instances", () => {
  it("returns 200 with an empty instances array on fresh state", async () => {
    const res = await fetch(`${testBase}/v1/instances`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });

  it("includes a gpus array in the response", async () => {
    const res = await fetch(`${testBase}/v1/instances`, { headers: auth });
    const body = await res.json();
    expect(Array.isArray(body.gpus)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

describe("GET /v1/profiles", () => {
  it("returns 200 with an empty profiles array on fresh state", async () => {
    const res = await fetch(`${testBase}/v1/profiles`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });
});

describe("POST /v1/profiles", () => {
  it("requires a name field", async () => {
    const res = await fetch(`${testBase}/v1/profiles`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/i);
  });

  it("creates a profile and returns it with 201", async () => {
    const res = await fetch(`${testBase}/v1/profiles`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "test-profile-vitest" }),
    });
    expect(res.status).toBe(201);
    const profile = await res.json();
    expect(profile.name).toBe("test-profile-vitest");
    expect(typeof profile.id).toBe("string");
  });

  it("created profile appears in GET /v1/profiles", async () => {
    await fetch(`${testBase}/v1/profiles`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "profile-for-list-test" }),
    });

    const listRes = await fetch(`${testBase}/v1/profiles`, { headers: auth });
    const { data } = await listRes.json();
    expect(data.some((p) => p.name === "profile-for-list-test")).toBe(true);
  });
});

describe("DELETE /v1/profiles/:id", () => {
  it("deletes a profile by id", async () => {
    const createRes = await fetch(`${testBase}/v1/profiles`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "profile-to-delete" }),
    });
    const { id } = await createRes.json();

    const delRes = await fetch(`${testBase}/v1/profiles/${id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(delRes.status).toBe(200);
    const body = await delRes.json();
    expect(body.success).toBe(true);

    const listRes = await fetch(`${testBase}/v1/profiles`, { headers: auth });
    const { data } = await listRes.json();
    expect(data.some((p) => p.id === id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

describe("security headers", () => {
  it("includes X-Content-Type-Options: nosniff on all responses", async () => {
    const res = await fetch(`${testBase}/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("includes X-Frame-Options: DENY on all responses", async () => {
    const res = await fetch(`${testBase}/health`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("includes Access-Control-Allow-Origin on authenticated responses", async () => {
    const res = await fetch(`${testBase}/v1/instances`, { headers: auth });
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  it("Referrer-Policy is set", async () => {
    const res = await fetch(`${testBase}/health`);
    expect(res.headers.get("referrer-policy")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 404 on unknown routes
// ---------------------------------------------------------------------------

describe("unknown routes", () => {
  it("returns 404 for unrecognised /v1 path", async () => {
    const res = await fetch(`${testBase}/v1/does-not-exist`, { headers: auth });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

describe("GET /v1/models", () => {
  it("returns OpenAI list shape with empty data when no instances are running", async () => {
    const res = await fetch(`${testBase}/v1/models`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions — routing errors (no live instances needed)
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions routing errors", () => {
  it("returns 400 when model field is absent", async () => {
    const res = await fetch(`${testBase}/v1/chat/completions`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.param).toBe("model");
  });

  it("returns 404 with model_not_found code for an unknown model name", async () => {
    const res = await fetch(`${testBase}/v1/chat/completions`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ model: "nonexistent-model-xyz", messages: [] }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("model_not_found");
  });
});

describe("POST /v1/completions routing errors", () => {
  it("returns 404 with model_not_found code for an unknown model name", async () => {
    const res = await fetch(`${testBase}/v1/completions`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ model: "nonexistent-model-xyz", prompt: "hello" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("model_not_found");
  });
});

// ---------------------------------------------------------------------------
// Hub downloads
// ---------------------------------------------------------------------------

describe("GET /v1/hub/downloads", () => {
  it("returns 200 with an empty download queue on fresh state", async () => {
    const res = await fetch(`${testBase}/v1/hub/downloads`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe("GET /v1/audit", () => {
  it("returns 200 with a data array", async () => {
    const res = await fetch(`${testBase}/v1/audit`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agent capabilities
// ---------------------------------------------------------------------------

describe("GET /v1/agent/capabilities", () => {
  it("returns version and actions manifest", async () => {
    const res = await fetch(`${testBase}/v1/agent/capabilities`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe("1.0");
    expect(Array.isArray(body.actions)).toBe(true);
    expect(body.actions.length).toBeGreaterThan(0);
  });
});

describe("POST /v1/agent/action", () => {
  it("returns 400 with success=false for an unrecognised action", async () => {
    const res = await fetch(`${testBase}/v1/agent/action`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ action: "does.not.exist" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 400 for invalid instanceId on instance-scoped actions", async () => {
    const res = await fetch(`${testBase}/v1/agent/action`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ action: "instances.stop", input: { instanceId: "bad id with spaces" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe("GET /metrics", () => {
  it("returns prometheus-format text when authenticated", async () => {
    const res = await fetch(`${testBase}/metrics`, { headers: auth });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/llamafleet_/);
  });

  it("rejects unauthenticated scrape with 401", async () => {
    const res = await fetch(`${testBase}/metrics`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// System info
// ---------------------------------------------------------------------------

describe("GET /v1/system/info", () => {
  it("returns 200 with platform and arch (bridge unavailable — fallback path)", async () => {
    const res = await fetch(`${testBase}/v1/system/info`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.platform).toBe("string");
    expect(typeof body.arch).toBe("string");
  });

  it("always includes a llamaCppLatest key (null when no cached check yet)", async () => {
    const res = await fetch(`${testBase}/v1/system/info`, { headers: auth });
    const body = await res.json();
    expect("llamaCppLatest" in body).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Local models
// ---------------------------------------------------------------------------

describe("GET /v1/local-models", () => {
  it("returns 200 with a data array", async () => {
    const res = await fetch(`${testBase}/v1/local-models`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("each model entry has name, size, and downloading fields", async () => {
    const res = await fetch(`${testBase}/v1/local-models`, { headers: auth });
    const { data } = await res.json();
    for (const m of data) {
      expect(typeof m.name).toBe("string");
      expect("size" in m).toBe(true);
      expect(typeof m.downloading).toBe("boolean");
    }
  });
});

// ---------------------------------------------------------------------------
// Settings — security
// ---------------------------------------------------------------------------

describe("GET /v1/settings/security", () => {
  it("returns the current security settings object", async () => {
    const res = await fetch(`${testBase}/v1/settings/security`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("api");
    expect(body).toHaveProperty("tls");
    expect(body).toHaveProperty("auth");
  });
});

describe("PUT /v1/settings/security", () => {
  it("can update auth.sessionTtlMinutes and reflects change immediately", async () => {
    const res = await fetch(`${testBase}/v1/settings/security`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ auth: { sessionTtlMinutes: 120 } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auth.sessionTtlMinutes).toBe(120);
  });

  it("can set api.requireApiKey (API_AUTH_TOKEN is configured in test env)", async () => {
    const res = await fetch(`${testBase}/v1/settings/security`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ api: { requireApiKey: true } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.api.requireApiKey).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config export / status / import
// ---------------------------------------------------------------------------

describe("GET /v1/config/status", () => {
  it("returns a 64-char SHA-256 currentExportHash", async () => {
    const res = await fetch(`${testBase}/v1/config/status`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.currentExportHash).toBe("string");
    expect(body.currentExportHash).toHaveLength(64);
  });
});

describe("GET /v1/config/export.yaml", () => {
  it("returns a YAML content-type response", async () => {
    const res = await fetch(`${testBase}/v1/config/export.yaml`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/yaml/i);
  });

  it("YAML body contains a version field", async () => {
    const res = await fetch(`${testBase}/v1/config/export.yaml`, { headers: auth });
    const text = await res.text();
    expect(text).toMatch(/^version:/m);
  });
});

describe("POST /v1/config/import.yaml", () => {
  const yamlHeaders = { ...auth, "Content-Type": "application/yaml" };

  it("returns 400 when body is empty", async () => {
    const res = await fetch(`${testBase}/v1/config/import.yaml`, {
      method: "POST",
      headers: yamlHeaders,
      body: "   ",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/yaml body is required/i);
  });

  it("returns 400 for invalid YAML syntax", async () => {
    const res = await fetch(`${testBase}/v1/config/import.yaml`, {
      method: "POST",
      headers: yamlHeaders,
      body: "{ unclosed: [bracket",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid yaml/i);
  });

  it("returns success:true for a valid dry-run import", async () => {
    const res = await fetch(`${testBase}/v1/config/import.yaml?dryRun=true`, {
      method: "POST",
      headers: yamlHeaders,
      body: "version: '1'\nprofiles: []\nusers: []\n",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.applied).toBe(false);
    expect(typeof body.summary).toBe("object");
  });
});
