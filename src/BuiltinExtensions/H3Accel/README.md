# H3Accel

Fork-owned builtin extension. Exposes two third-party MiniMax H3 ComfyUI accelerator nodes as native SwarmUI
parameters: **H3 Memory Optimization** and **H3 FirstBlockCache**. Neither node ships with this extension —
both are separately-installable Comfy node packs, detected the same way core detects TeaCache/EasyCache/
Nunchaku/etc: by scanning the backend's live `object_info` for a known node class name
(`ComfyUIBackendExtension.NodeToFeatureMap`) and advertising an install button
(`InstallableFeatures.RegisterInstallableFeature`) when it's missing.

Zero core-file edits. All code lives in `H3AccelExtension.cs`; tests in `SwarmUITests/H3AccelTests.cs`.

## What each node does

**H3 Memory Optimization** (node `H3MemoryOptimization`, from
[Zironic/H3-Optimizations](https://github.com/Zironic/H3-Optimizations)) streams Q/K/V and chunks MLP/
FinalLayer execution in bounded token pieces, cutting peak VRAM during MiniMax H3 generation. User-facing
controls: MLP memory optimization (Auto/Off), QKV streaming (Off/Auto/Forced), and Attention memory mode
(Standard/Lower VRAM (slower)). Advanced: Precision mode and Activation chunk rows. Three more node inputs
(`fused_qkv`, `preserve_precision`, `embedding_memory_mode`) are legacy serialized-workflow slots the node
itself marks hidden and ignores functionally — this extension always sends the node's own defaults for those
three and never exposes them as SwarmUI parameters.

**H3 FirstBlockCache** (node `ApplyMiniMaxH3FirstBlockCache`, from
[duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache](https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache))
runs the first transformer block every step and reuses the cached remaining-block residual when the change is
small enough. Controls: Mode (Safe/Fast/Aggressive presets, Experimental, or Custom), Threshold, Start/End
percent, Max consecutive hits, and Temporal guard.

**Important node quirk:** the node's three named presets (Safe/Fast/Aggressive) hard-code their own threshold/
window/hit-limit values *and always ignore the Temporal Guard input*, even if it's turned on. Only Custom mode
actually reads Threshold/Start/End/Max Hits/Temporal Guard. This extension's default Mode is therefore
**Custom, pre-filled with the Safe preset's own numbers** (threshold 0.08, window 0.10–0.95, max 2 consecutive
hits) **plus Temporal Guard on** — the only way to get "Safe's calibrated numbers" and "the extra motion-aware
safety check" at the same time.

## Attachment order

1. **H3 Memory Optimization** attaches directly onto every `MiniMaxH3SigmaShift` node's output (step priority
   500 — after every core step, since core's last is priority 200), so it becomes the *base* of the H3 patch
   chain. It never wraps the third-party SwarmUI-H3Attn extension's Sol-Attn ("Sparse Attention") node or its
   AIMDO limiter — the reverse is true: everything H3Attn attaches later (Window/Sol-Attn/Spectrum, step
   priority 1000) wraps around Memory Optimization instead.
2. **H3 FirstBlockCache** attaches last (step priority 1500 — after H3Attn's step), directly onto whatever
   model connection each `SwarmKSampler` node currently has, walking through however many intermediate patch
   nodes to confirm the chain actually originates from a `MiniMaxH3SigmaShift` node before attaching. This
   covers both the base sampler and any refiner/second-stage sampler, exactly like H3Attn's own per-sampler
   Window attachment.

Both steps are strictly H3-only: if the generated workflow has no `MiniMaxH3SigmaShift` node (i.e. the loaded
model isn't MiniMax H3), the step silently no-ops rather than erroring or attaching anything.

## Exclusion rule

H3 FirstBlockCache is skipped — with a `Logs.Warning` naming the reason — whenever any of the following is
also active on the same generation:

- **TeaCache** (`TeaCacheMode` != `disabled`)
- **EasyCache** (`EasyCacheMode` != `disabled`)
- **Spectrum** (the third-party H3Attn extension's `SpectrumApplyMiniMaxH3` node is present in the generated
  workflow — detected purely by scanning the workflow for that class name, so this has no compile-time or
  runtime dependency on H3Attn; Spectrum detection works whether or not that extension is even installed)

All three change or skip the same per-step transformer execution FirstBlockCache reads its residual diff from;
stacking FirstBlockCache underneath any of them would corrupt its cache/skip decision.

## Defaults rationale

Every default in this extension is chosen for **no wobble, keep reference identity** — i.e. stay as close as
possible to an ordinary (unaccelerated) MiniMax H3 generation, and let a user dial up aggressiveness
deliberately rather than opt into drift by default:

- Memory Optimization's three user-facing defaults (MLP memory: Auto, QKV streaming: Auto, Attention memory:
  Standard) are the node's own defaults — Auto/Standard preserve the node's normal behavior without forcing a
  more aggressive memory posture.
- FirstBlockCache defaults to the Safe preset's own calibrated numbers (not Fast, the node's own default) with
  Temporal Guard on, because Safe is the least aggressive named preset and Temporal Guard is an extra
  motion-aware check against exactly the kind of local flicker ("wobble") a cache-skip can introduce in video.
