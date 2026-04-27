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
