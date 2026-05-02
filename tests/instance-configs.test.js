import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, testBase, TEST_TOKEN } from "./helpers/server.js";

const auth = { Authorization: `Bearer ${TEST_TOKEN}` };
const jsonHeaders = { ...auth, "Content-Type": "application/json" };

beforeAll(startServer);
afterAll(stopServer);

// A minimal valid instance config payload — model + port are required per sanitizeInstanceConfigPayload
const validConfig = {
  name: "Test Config",
  instances: [
    { name: "inst-1", model: "/models/test.gguf", port: 11100, gpus: [] },
  ],
};

// ---------------------------------------------------------------------------
// GET /v1/instance-configs — empty list on fresh state
// ---------------------------------------------------------------------------

describe("GET /v1/instance-configs", () => {
  it("returns 200 with an empty data array on fresh state", async () => {
    const res = await fetch(`${testBase}/v1/instance-configs`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/instance-configs — input validation
// ---------------------------------------------------------------------------

describe("POST /v1/instance-configs validation", () => {
  it("returns 400 when instances array is empty", async () => {
    const res = await fetch(`${testBase}/v1/instance-configs`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "empty", instances: [] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/at least one/i);
  });

  it("returns 400 when instance entry has no model", async () => {
    const res = await fetch(`${testBase}/v1/instance-configs`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "bad", instances: [{ port: 11100 }] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when instance entry has no valid port", async () => {
    const res = await fetch(`${testBase}/v1/instance-configs`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "bad", instances: [{ model: "/models/test.gguf", port: 99999 }] }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// CRUD round trip
// ---------------------------------------------------------------------------

describe("instance-configs CRUD", () => {
  let savedId;

  it("POST creates a config and returns 201 with id, name, and instances", async () => {
    const res = await fetch(`${testBase}/v1/instance-configs`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(validConfig),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe("string");
    expect(body.name).toBe("Test Config");
    expect(Array.isArray(body.instances)).toBe(true);
    expect(body.instances).toHaveLength(1);
    expect(body.instances[0].model).toBe("/models/test.gguf");
    savedId = body.id;
  });

  it("config appears in the GET list with correct summary fields", async () => {
    const res = await fetch(`${testBase}/v1/instance-configs`, { headers: auth });
    const { data } = await res.json();
    const entry = data.find((c) => c.id === savedId);
    expect(entry).toBeDefined();
    expect(entry.name).toBe("Test Config");
    expect(entry.instanceCount).toBe(1);
  });

  it("GET /v1/instance-configs/:id returns the full config", async () => {
    const res = await fetch(`${testBase}/v1/instance-configs/${savedId}`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(savedId);
    expect(body.name).toBe("Test Config");
    expect(Array.isArray(body.instances)).toBe(true);
  });

  it("POST with the same id upserts without creating a duplicate", async () => {
    const res = await fetch(`${testBase}/v1/instance-configs`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ ...validConfig, id: savedId, name: "Updated Config" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(savedId);
    expect(body.name).toBe("Updated Config");

    const listRes = await fetch(`${testBase}/v1/instance-configs`, { headers: auth });
    const { data } = await listRes.json();
    expect(data.filter((c) => c.id === savedId)).toHaveLength(1);
  });

  it("GET /v1/instance-configs/:id/export.yaml returns YAML", async () => {
    const res = await fetch(`${testBase}/v1/instance-configs/${savedId}/export.yaml`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/yaml/i);
    const text = await res.text();
    expect(text).toMatch(/kind:\s*lmlaunch-instance-config/);
  });

  it("DELETE /v1/instance-configs/:id removes the config", async () => {
    const res = await fetch(`${testBase}/v1/instance-configs/${savedId}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const listRes = await fetch(`${testBase}/v1/instance-configs`, { headers: auth });
    const { data } = await listRes.json();
    expect(data.some((c) => c.id === savedId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 404 for unknown id
// ---------------------------------------------------------------------------

describe("GET /v1/instance-configs/:id for unknown id", () => {
  it("returns 404", async () => {
    const res = await fetch(`${testBase}/v1/instance-configs/nonexistent-id-xyz`, { headers: auth });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /v1/instance-configs/:id for unknown id", () => {
  it("returns 404", async () => {
    const res = await fetch(`${testBase}/v1/instance-configs/nonexistent-id-xyz`, {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(404);
  });
});
