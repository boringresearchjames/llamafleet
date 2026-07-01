# LlamaFleet Copilot Instructions

## Project overview
LlamaFleet is a Node.js monorepo that manages local LLM instances. API at `:8081`, host-bridge at `:8090`. Primary model: MiniMax-M3 (428B MoE, ~23B active) on a server with 11× V100 SXM2 GPUs.

---

## Server access

- **Host**: `192.168.50.146` (not .149), user `zomieai`, passwordless sudo, key auth
- **API auth**: `Bearer df016c586dc342642b344c398ece0a9dfd50e4705e6bf6d1206ecb9b2693f211`
- **API base**: `http://192.168.50.146:8081`
- **Instance port**: 1234 (sparse-attn fork), 1235 (standard build)
- **Model dir**: `/media/zomieai/aidisk/models/lmfleet/`
- **Custom llama-server**: `/home/zomieai/llama.cpp-m3-sparse/build/bin/llama-server` (sparse attention fork for M3)
- **Env file**: `/etc/llamafleet/llamafleet.env` (needs sudo; contains `LLAMA_SERVER_BIN`, `API_AUTH_TOKEN`, `MODELS_DIR`)

---

## Instance lifecycle

**Never use restart alone** on a running instance — use **stop → wait 3s → restart**. Restart on a live instance returns `undefined/undefined`.

```js
// Correct pattern
fetch('/v1/instances/:id/stop', { method: 'POST' })
  .then(() => new Promise(r => setTimeout(r, 5000)))
  .then(() => fetch('/v1/instances/:id/restart', { method: 'POST' }))
```

**If instance stuck in `readiness.retry` with no llama-server process**: GPU memory is held by a zombie PID. Check `nvidia-smi`, `sudo kill -9 <pid>`, then restart.

**List instances** to get state (the `/v1/instances/:id` endpoint returns HTML when running — always use the list endpoint):
```js
fetch('/v1/instances', { headers: { authorization: AUTH } }).then(r => r.json())
```

**Warmup time**: ~4-5 min for model load (fast NVMe). `startupTimeoutMs` must be ≥ 300000. Watch for the compute buffer reservation step (~4 min in) — that's the real OOM gate, not the weight load.

**Instance log** (sudo): `/var/lib/llamafleet/bridge/logs/<id>.log`

**runtimeArgs must be a shell string**, not an object/array — e.g. `"-b 512 -ub 512 --flash-attn on"`. Passing an object produces `[object Object]` corruption.

---

## Current M3 sparse-attention instance

- **ID**: `86562188-aecf-4041-ba63-3fa3eada6acb`, port 1234, ctx 131072
- **GPUs**: 0-4,5-8,10,11 (11 total; GPU 9 is RTX 3050, excluded)
- **runtimeArgs**: `-fit off -b 512 -ub 512 -ngl 999 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --tensor-split 8,8,8,8,4,4,4,4,4,4,4 --temp 1.0 --top-p 0.95 --top-k 40 --reasoning-budget 2048`
- **Binary**: `/home/zomieai/llama.cpp-m3-sparse/build/bin/llama-server`
- **Build**: `cd /home/zomieai/llama.cpp-m3-sparse/build && cmake --build . --target llama-server -j8`
- **Deploy**: `scp <file> zomieai@192.168.50.146:<path>` then build

## Standard M3 instance (opencode/agentic best)

- **ID**: `f356144c-d4ee-4bc3-8b04-b6a4bd385c56`, port 1235, ctx 131072
- **runtimeArgs**: `-b 512 -ub 256 -ngl 999 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --tensor-split 8,8,8,8,4,4,4,4,4,4,4`
- Gen ~28 t/s, prefill ~120 t/s. Prefill is the agentic bottleneck (large code prompts).

---

## GPU / tensor-split layout

llama.cpp CUDA device order differs from `nvidia-smi` physical order:
- **CUDA 0-3** = 32 GB V100s
- **CUDA 4-10** = 16 GB V100s

Even split for 60 layers: `8,8,8,8,4,4,4,4,4,4,4` (eight layers per 32GB card, four per 16GB card). Auto-split overfills a 16GB card at high context → OOM. Always use explicit split.

The tightest card at 128k q8/q8 is idx4 (~169 MiB free). Do not raise `-ub` past 256 on that config — ub384 OOMs. Do not push context past 131072 on q8/q8 without rechecking VRAM.

---

## Benchmarking

### Quick decode benchmark (`/tmp/bench2.py` on server)
```python
import requests
BASE = 'http://127.0.0.1:1234'
PAD = ('The history of computing began with mechanical calculators. ' * 15000)

def bench(label, n_toks):
    prompt = PAD[:n_toks * 5]
    r = requests.post(BASE+'/completion', json={
        'prompt': prompt, 'n_predict': 32,
        'cache_prompt': False,   # use False for isolated tests; True speeds up sequential runs
        'temperature': 0
    }, timeout=600)
    d = r.json()
    u = d['timings']
    ctx = u.get('prompt_n', 0) + u.get('cache_n', 0)
    print(f'{label:<8} ctx={ctx:>7}  decode={u["predicted_per_second"]:>5.1f} t/s')

for label, n in [('55k',55000),('70k',70000),('90k',90000),('110k',110000),('125k',125000)]:
    bench(label, n)
```

**Important**: `cache_prompt: True` accumulates context across sequential tests. At 125k the cached 110k prefix causes an error ("Failed to parse input at pos 0"). Use `cache_prompt: False` for isolated long-context tests.

**Actual tokenized context** is lower than the nominal label (e.g. 125k label → ctx≈93751 tokens). The `timings.prompt_n + timings.cache_n` value is the real context length.

### Quality sanity check (`/tmp/sanity.py`)
- Use varied text (historical facts), NOT purely repetitive filler
- Repetitive filler (identical sentences) is not a valid quality signal for sparse attention — block scores are near-equal and any noise can cause wrong selection
- Test: load ~6-8k ctx with varied wiki-style text, ask a factual question embedded in the text. Correct answer = quality OK.

### Baseline numbers (sparse-attn fork, two-pass scoring, q8_0 KV, ctx=131072)
| ctx label | actual ctx | decode (t/s) |
|-----------|-----------|-------------|
| 55k       | ~41k      | 16.8        |
| 70k       | ~52k      | 15.4        |
| 90k       | ~67k      | 15.0        |
| 110k      | ~82k      | 14.2        |
| 125k      | ~94k      | 13.2        |

Pre-optimization baseline was 8-10 t/s at 90k+ ctx. The gains came from: q8_0 KV cache (biggest), opt1 kernel (2×), two-pass scoring (+5-9% at 90k+).

---

## sparse-attn.cu — deployment gotchas

- **CUDA_CHECK** is the correct macro (not `GGML_CUDA_CHECK`)
- **Static scratch buffers must be per-device**: index by `ctx.device` (0-10). A pointer allocated on GPU 0 is invalid on GPU 1 → XID 31 GPU MMU fault (ACCESS_TYPE_VIRT_WRITE). Use `s_buf[SPARSE_SCORE_MAX_DEVICES]` arrays.
- **Never use `bool used[N] = {}` local arrays in device kernels**: exceeds registers → CUDA local memory (100-cycle access). At O(M×n_blocks) iterations × 57 layers this adds 50-100ms overhead per token. Use shared memory or a parallel reduction instead.
- **topM_select_kernel** must use 512-thread parallel warp reduction (score in smem, M rounds of warp-level max + invalidate), not serial single-thread selection.
- **cudaMalloc/cudaFree in hot path = catastrophic**: 57 layers × 2 per step = 114 GPU pipeline synchronizations per token, each costing 100-1000μs. Use static grow-only buffers (lazy alloc, never freed).
- **smem layout for scoring kernel**: `(block_size + head_dim) * sizeof(float)` = 1536 bytes at bs=256, hd=128. Well within V100's 48KB default.

---

## Proxy.js / tool-call parser (M3-specific)

M3 emits tool calls wrapped in `<]minimax[>` control tokens. The llama-server's own parser 500s on this format. Fix lives in `apps/api/src/lib/proxy.js` — helpers: `hasMinimaxM3ToolCall`, `parseMinimaxM3ToolCalls`, `cleanMinimaxM3ControlTokens`.

Deploy server copy: always LF-normalize (`sed "s/\r$//"`) before writing. Verify with `grep -c "MiniMax-M3 tool call transformation" proxy.js` = 1.

---

## Shell / SSH tips

- **PowerShell expands `$(...)` inside double-quoted strings** before sending to SSH. Use single quotes around remote commands, or escape `\$`, when the remote side needs `$(...)`.
- **CRLF vs LF**: local files (Windows) have CRLF. Always normalize with `sed "s/\r$//"` when copying to server. Git diffs on mixed-EOL files show spurious changes — compare normalized versions.
- `grep` is not available in PowerShell — use `Select-String -Path <file> -Pattern <regex>`.

---

## Context compression

Deterministic proxy-level compressor in `apps/api/src/lib/compress.js`. Cuts prefill latency by reducing token count (not hardware). KV-cache safe (deterministic output). Enabled via `state.settings.compression`. Default: off. Tests: `npx vitest run tests/compress.test.js`.
