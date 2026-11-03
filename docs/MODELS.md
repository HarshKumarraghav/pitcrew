# Models

What was evaluated, what was measured, and how to pick for your machine. Sources: model cards on
huggingface.co/Qwen, ollama.com/library tag pages (sizes as listed in Nov 2026). "Measured" means
measured on the reference machine (M5, 24 GB); everything else is from vendor documentation.

## Weight size is not memory use

`memory ≈ weights + KV cache(context × parallel slots) + runtime overhead`, and on unified memory it
competes with every open app. Measured example: `qwen3.5:9b` is 7.6 GB on disk, 7.62 GB resident
right after load at 32k context, 8.06 GB after one 5.9k-token request and **17.05 GB** after a
benchmark session with ~19k-token prompts (Ollama's MLX runner keeps prompt caches).
Mixture-of-experts models need *all* experts resident even though few are active per token.

## Candidates (24 GB class)

| model | architecture | params (active) | Ollama 4-bit download | native ctx | tools | verdict on 24 GB |
|---|---|---|---|---|---|---|
| Qwen3.8-27B (Aug 2026) | dense, hybrid Gated DeltaNet / attention | 27B | 18 GB | 256k | yes | best Qwen coder; does not fit beside a normal desktop (GPU limit 17.8 GiB) |
| Qwen3.6-27B | dense, hybrid | 27B | 17 GB | 256k | yes | same problem |
| Qwen3.6-35B-A3B | MoE | 35B (3B) | 22 GB | 256k | yes | too big |
| Qwen3-Coder-30B-A3B | MoE | 30B (3B) | 19 GB | 256k | yes | too big |
| Devstral Small 2 | dense | 24B | 15 GB | 384k | yes | fits the GPU limit, not beside apps |
| Gemma 4 26B-A4B (QAT) | MoE | 26B (4B) | 16 GB | 256k | yes | same |
| **Qwen3.5-9B** | dense, hybrid (8 of 32 layers keep KV) | 9.7B | **7.6 GB (NVFP4, MLX runner)** · 6.6 GB q4_K_M | 256k | yes | **default coder** |
| Gemma 4 12B (QAT) | dense | 12B | 7.2 GB | 256k | yes | alternative coder (not yet benchmarked here) |
| Qwen3.5-2B | dense, hybrid | 2B | 1.9 GB q4 | 256k | yes | light model / helpers |
| **Qwen3.5-0.8B** | dense, hybrid | 0.8B | 1.0–1.2 GB | 256k | yes | **default light model** (titles, short helpers) |

## Measured on the reference machine

| | qwen3.5:9b (NVFP4, MLX) | qwen3.5:0.8b (MXFP8, MLX) |
|---|---|---|
| cold load | 3.9–5.9 s | 0.6–0.9 s |
| resident right after load | 7.1–7.6 GB @ 32k | 1.1 GB @ 8k |
| prefill, 5.9k-token OpenCode prompt | 10.0 s (584 tok/s) cold, ≈0 s warm | — |
| decode | 23–36 tok/s | — |
| title request, thinking on / off | — | 14.4 s, empty / **0.2 s** |
| OpenCode agent suite (M1, direct) | 5/6 tasks | — |

## Picking for your hardware

| unified memory | coder | light model | notes |
|---|---|---|---|
| 16 GB | qwen3.5:4b or qwen3.5:9b with nothing else open | qwen3.5:0.8b | expect swapping with a browser open |
| 24 GB | qwen3.5:9b | qwen3.5:0.8b | measured config of this repo |
| 32 GB | Qwen3.8-27B 4-bit (18 GB) | qwen3.5:0.8b | try it; measure with `pitcrew garage` |
| 48 GB+ | Qwen3.8-27B 8-bit or Qwen3.6-35B-A3B | qwen3.5:2b | MoE gives much faster decode |

Licenses: Qwen3.5 / 3.6 / 3.8 — Apache 2.0. Gemma 4 — Gemma terms. Devstral Small 2 — Apache 2.0.
Check each model card before redistribution; this repository ships no weights.

## Runtime notes

- Ollama ≥ 0.40 on Apple Silicon serves many current tags (e.g. `qwen3.5:9b`) as **safetensors on its
  built-in MLX runner**, not GGUF. llama.cpp cannot load those blobs; a llama.cpp comparison needs a
  separate GGUF download. A separate MLX-LM install mostly duplicates what Ollama already does.
- MLX-runner metadata omits the attention layout, so Pit Crew's footprint model starts from a
  conservative guess and switches to measured sizes after the first load.
- Ollama's OpenAI endpoint cannot set `num_ctx` per request; Pit Crew uses derived models
  (`pitcrew/<model>:<N>k`, metadata only, weights shared). `pitcrew clean --yes` removes them.
