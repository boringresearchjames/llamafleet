import { describe, it, expect } from "vitest";
import {
  autoCtxComputeBufferMibBase,
  autoCtxComputeBufferMibPerSlot,
  autoCtxVramBufferFraction,
  computeAutoCtxSize
} from "../apps/host-bridge/src/auto-ctx.js";

function oldSmoothKvBudgetMib(freeMibMap, gpuIds, modelSizeMib, parallelSlots) {
  const totalFreeMiB = gpuIds.reduce((sum, id) => sum + freeMibMap.get(String(id)), 0);
  const perGpuReserveMib = autoCtxComputeBufferMibBase + (autoCtxComputeBufferMibPerSlot * parallelSlots);
  return Math.min(...gpuIds.map((id) => {
    const freeGpu = freeMibMap.get(String(id));
    return Math.max(0, totalFreeMiB - modelSizeMib - perGpuReserveMib * (totalFreeMiB / freeGpu));
  }));
}

describe("computeAutoCtxSize", () => {
  it("uses integer KV layer counts instead of fractional VRAM shares on uneven GPUs", () => {
    const freeMibMap = new Map([
      ["0", 28_000],
      ["1", 28_000],
      ["2", 25_000],
      ["3", 19_000]
    ]);
    const gpuIds = ["0", "1", "2", "3"];
    const numLayers = 61;
    const modelSizeMib = 36_000;
    const bytesPerTokenPerLayer = 512;
    const parallelSlots = 4;

    const diag = computeAutoCtxSize(
      freeMibMap,
      gpuIds,
      numLayers,
      modelSizeMib,
      bytesPerTokenPerLayer,
      parallelSlots
    );

    const smoothKvBudgetMib = oldSmoothKvBudgetMib(freeMibMap, gpuIds, modelSizeMib, parallelSlots);
    const smoothCtx = Math.floor(
      (smoothKvBudgetMib * (1 - autoCtxVramBufferFraction) * 1024 * 1024) /
      (numLayers * bytesPerTokenPerLayer)
    );

    expect(diag.reason).toBe("ok");
    expect(diag.bottleneckGpu.id).toBe("3");
    expect(diag.bottleneckGpu.kvLayerCount).toBe(12);
    expect(diag.ctxSize).toBeLessThan(Math.floor(smoothCtx / 256) * 256);
  });

  it("keeps equal-memory GPUs close to the smooth total budget", () => {
    const freeMibMap = new Map([
      ["0", 32_000],
      ["1", 32_000],
      ["2", 32_000],
      ["3", 32_000]
    ]);

    const diag = computeAutoCtxSize(freeMibMap, ["0", "1", "2", "3"], 60, 62_000, 512, 4);

    expect(diag.reason).toBe("ok");
    expect(diag.perGpu.map((gpu) => gpu.kvLayerCount)).toEqual([15, 15, 15, 15]);
    expect(diag.bottleneckGpu.allowedKvMib).toBeCloseTo(diag.kvBudgetMib, 6);
  });

  it("reports exhausted budget when a selected card cannot hold its KV layers and reserve", () => {
    const diag = computeAutoCtxSize(
      new Map([["0", 32_000], ["1", 5_000]]),
      ["0", "1"],
      60,
      20_000,
      512,
      4
    );

    expect(diag.reason).toBe("kv_budget_exhausted");
    expect(diag.ctxSize).toBeNull();
    expect(diag.bottleneckGpu.id).toBe("1");
  });

  it("places the 32GB MiniMax cards before the 16GB cards", () => {
    const freeMibMap = new Map([
      ["0", 16_140],
      ["1", 16_140],
      ["2", 16_140],
      ["3", 16_140],
      ["4", 32_490],
      ["5", 32_490],
      ["6", 32_490],
      ["7", 32_490]
    ]);

    const diag = computeAutoCtxSize(
      freeMibMap,
      ["0", "1", "2", "3", "4", "5", "6", "7"],
      62,
      134_259,
      2048,
      2
    );

    expect(diag.reason).toBe("ok");
    expect(diag.visibleGpuIds.slice(0, 4)).toEqual(["4", "5", "6", "7"]);
    expect(diag.perGpu.find((gpu) => gpu.id === "0").kvLayerCount).toBe(5);
    expect(diag.ctxSize).toBeGreaterThan(8192);
    expect(diag.ctxSize).toBeGreaterThan(196608);
  });

  it("avoids fallback for MiniMax parallel 4 by placing 32GB cards first", () => {
    const freeMibMap = new Map([
      ["0", 16_140],
      ["1", 16_140],
      ["2", 16_140],
      ["3", 16_140],
      ["4", 32_490],
      ["5", 32_490],
      ["6", 32_490],
      ["7", 32_490]
    ]);

    const diag = computeAutoCtxSize(
      freeMibMap,
      ["0", "1", "2", "3", "4", "5", "6", "7"],
      62,
      134_259,
      2048,
      4
    );

    expect(diag.reason).toBe("ok");
    expect(diag.ctxSize).toBeGreaterThan(8192);
    expect(diag.visibleGpuIds.slice(0, 4)).toEqual(["4", "5", "6", "7"]);
    expect(diag.perGpu.find((gpu) => gpu.id === "0").kvLayerCount).toBe(5);
  });
});