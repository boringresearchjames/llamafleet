// Fraction of free VRAM to reserve as a safety buffer when auto-sizing ctx.
// e.g. 0.20 = keep 20% of free VRAM free, use the other 80% for KV cache.
export const autoCtxVramBufferFraction = Math.min(0.9, Math.max(0, Number(process.env.AUTO_CTX_VRAM_BUFFER || 0.05)));
// Bytes of KV cache consumed per context token per layer (fp16 K+V = 2*2 bytes per head).
// This is a conservative heuristic; actual usage depends on model architecture & kv quant.
export const autoCtxBytesPerTokenPerLayer = Number(process.env.AUTO_CTX_BYTES_PER_TOKEN_PER_LAYER || 512);
// MiB of VRAM to reserve per GPU PER SLOT for llama-server compute buffers
// (batch scratch + flash-attention scratch). Scales with --parallel.
// Keep the default lean for mixed 16/32 GB V100 fleets: MiniMax-M2.7 has been
// observed to fit ~196k ctx with ~2 GiB/GPU reserve at parallel=2, while a
// larger default starves the 16 GB cards and forces the safe 8k fallback.
export const autoCtxComputeBufferMibPerSlot = Number(
  process.env.AUTO_CTX_COMPUTE_BUFFER_MIB_PER_SLOT
  ?? process.env.AUTO_CTX_COMPUTE_BUFFER_MIB_PER_GPU // back-compat
  ?? 1024
);
// Fixed per-GPU overhead for one-time graph-reserve allocations (pipeline-parallel
// scheduler buffers, output buffer, CUDA_Host) that don't scale with slots.
export const autoCtxComputeBufferMibBase = Number(process.env.AUTO_CTX_COMPUTE_BUFFER_MIB_BASE || 0);

export function orderGpuIdsForLayerPlacement(freeMibMap, gpuIds) {
  if (!(freeMibMap instanceof Map)) return [...gpuIds].map(String);
  return [...gpuIds].map(String).sort((left, right) => {
    const rightFree = freeMibMap.get(String(right)) ?? 0;
    const leftFree = freeMibMap.get(String(left)) ?? 0;
    if (rightFree !== leftFree) return rightFree - leftFree;
    return Number(left) - Number(right);
  });
}

function estimateLayerCounts(numLayers, orderedGpuIds, freeMibMap, totalFreeMiB) {
  const counts = new Map();
  const remainders = [];
  let assignedLayers = 0;

  for (const id of orderedGpuIds) {
    const freeGpuMib = freeMibMap.get(String(id));
    if (!Number.isFinite(freeGpuMib) || freeGpuMib <= 0 || !Number.isFinite(totalFreeMiB) || totalFreeMiB <= 0) {
      counts.set(String(id), 0);
      continue;
    }
    const exact = numLayers * (freeGpuMib / totalFreeMiB);
    const base = Math.floor(exact);
    counts.set(String(id), base);
    assignedLayers += base;
    remainders.push({ id: String(id), remainder: exact - base, freeMib: freeGpuMib });
  }

  remainders.sort((left, right) => {
    if (right.remainder !== left.remainder) return right.remainder - left.remainder;
    if (right.freeMib !== left.freeMib) return right.freeMib - left.freeMib;
    return orderedGpuIds.indexOf(left.id) - orderedGpuIds.indexOf(right.id);
  });

  for (let remaining = numLayers - assignedLayers, i = 0; remaining > 0 && remainders.length > 0; remaining--, i++) {
    const target = remainders[i % remainders.length];
    counts.set(target.id, (counts.get(target.id) || 0) + 1);
  }

  return counts;
}

// Computes a safe --ctx-size from free VRAM across the assigned GPU set.
// freeMibMap: Map<gpuIndex, freeMiB>; gpuIds: string[]; numLayers: number.
// bytesPerTokenPerLayer: exact KV cost from GGUF metadata (falls back to autoCtxBytesPerTokenPerLayer).
//
// llama.cpp splits layer-mode GPU work at whole-layer boundaries. Mixed or
// partially occupied cards need a per-GPU integer-layer bottleneck check for
// both model weights and KV cache. Otherwise a smaller-share V100 can be
// assigned one extra layer versus the smooth ratio and OOM at startup.
export function computeAutoCtxSize(freeMibMap, gpuIds, numLayers, modelSizeMib = 0, bytesPerTokenPerLayer = null, parallelSlots = 1) {
  const result = {
    ctxSize: null,
    reason: null,
    totalFreeMiB: 0,
    modelSizeMib: 0,
    visibleGpuIds: [],
    perGpuReserveMib: 0,
    parallelSlots: 1,
    kvBudgetMib: 0,
    bottleneckGpu: null,
    bytesPerToken: null,
    perGpu: []
  };

  if (!(freeMibMap instanceof Map) || freeMibMap.size === 0) {
    result.reason = "no_free_mib_map"; return result;
  }
  if (!Array.isArray(gpuIds) || gpuIds.length === 0) {
    result.reason = "no_gpu_ids"; return result;
  }
  if (!Number.isInteger(numLayers) || numLayers <= 0) {
    result.reason = "bad_num_layers"; return result;
  }

  for (const id of gpuIds) {
    const mib = freeMibMap.get(String(id));
    if (!Number.isFinite(mib)) {
      result.reason = `unknown_gpu_free:${id}`;
      return result;
    }
    result.totalFreeMiB += mib;
  }

  const safeModelSizeMib = (Number.isFinite(modelSizeMib) && modelSizeMib > 0) ? modelSizeMib : 0;
  const safeParallelSlots = Math.max(1, Math.min(64, Number(parallelSlots) || 1));
  const perGpuReserveMib = autoCtxComputeBufferMibBase + (autoCtxComputeBufferMibPerSlot * safeParallelSlots);
  const bpt = (Number.isFinite(bytesPerTokenPerLayer) && bytesPerTokenPerLayer > 0)
    ? bytesPerTokenPerLayer
    : autoCtxBytesPerTokenPerLayer;
  const bytesPerToken = numLayers * bpt;

  result.modelSizeMib = safeModelSizeMib;
  result.visibleGpuIds = orderGpuIdsForLayerPlacement(freeMibMap, gpuIds);
  result.perGpuReserveMib = perGpuReserveMib;
  result.parallelSlots = safeParallelSlots;
  result.bytesPerToken = bytesPerToken;

  const layerCounts = estimateLayerCounts(numLayers, result.visibleGpuIds, freeMibMap, result.totalFreeMiB);

  let kvBudgetMib = Infinity;
  let bottleneck = null;
  for (const id of result.visibleGpuIds) {
    const freeGpu = freeMibMap.get(String(id));
    if (!Number.isFinite(freeGpu) || freeGpu <= 0) continue;

    const share = freeGpu / result.totalFreeMiB;
    const kvLayerCount = layerCounts.get(String(id)) || 0;
    const smoothModelShareMib = safeModelSizeMib * share;
    const layerModelShareMib = safeModelSizeMib * (kvLayerCount / numLayers);
    const modelShareMib = Math.max(smoothModelShareMib, layerModelShareMib);
    const remainingMib = freeGpu - modelShareMib - perGpuReserveMib;
    const allowedKvMib = kvLayerCount > 0
      ? Math.max(0, remainingMib * (numLayers / kvLayerCount))
      : 0;
    const entry = {
      id: String(id),
      freeMib: freeGpu,
      share,
      modelShareMib,
      smoothModelShareMib,
      layerModelShareMib,
      kvLayerCount,
      allowedKvMib
    };
    result.perGpu.push(entry);
    if (allowedKvMib < kvBudgetMib) {
      kvBudgetMib = allowedKvMib;
      bottleneck = entry;
    }
  }

  if (!Number.isFinite(kvBudgetMib)) {
    result.reason = "no_valid_gpu_free";
    return result;
  }

  result.kvBudgetMib = kvBudgetMib;
  result.bottleneckGpu = bottleneck;

  if (kvBudgetMib <= 0) {
    result.reason = "kv_budget_exhausted";
    return result;
  }

  const usableBytes = kvBudgetMib * (1 - autoCtxVramBufferFraction) * 1024 * 1024;
  const rawCtx = Math.floor(usableBytes / bytesPerToken);

  if (rawCtx < 512) {
    result.reason = `too_small:${rawCtx}`;
    result.ctxSize = null;
    return result;
  }

  result.ctxSize = Math.floor(rawCtx / 256) * 256;
  result.reason = "ok";
  return result;
}