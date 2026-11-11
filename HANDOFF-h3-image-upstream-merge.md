# Handoff: merge upstream H3-Image support into fork main

This note is for the coding agent resolving the upstream merge into the fork owner's SwarmUI fork. Do not push, do not restart Swarm, and do not create the preset until the steps below say so.

## Goal

Merge `upstream/master` through `f86858df` into fork `main`.

- Repo: `E:\SwarmUI` (the fork owner's fork `socrasteeze/SwarmUI`, branch `main`)
- Local `main` is at `8512eb0f` (`8512eb0f861659790ae8a7431cf714e8a3d1c940`), message: "Merge upstream/master through 70b9a9c7"
- `origin/main` is in sync with that commit
- Remote `upstream` is `mcmonkeyprojects/SwarmUI`; push to it is disabled
- `upstream/master` is at `f86858df` (`f86858dfe53f8c6138481f4ceae7e4ce9fa71d20`) after a fetch
- Local `main` is **582 commits ahead and 2 behind** `upstream/master`

The two incoming upstream commits (compare: https://github.com/mcmonkeyprojects/SwarmUI/compare/70b9a9c7...master):

1. `5279c53c` (`5279c53c4b60babcfda64a74ac76c8382830589c`) — "first draft H3-Image support", AuthorDate Tue Nov 10, 2026, 6:15 PM PT
2. `f86858df` — "h3 image docs", AuthorDate Wed Nov 11, 2026, 12:01 AM PT

A previous trial merge was aborted. The tree must stay (or be returned to) clean at `8512eb0f` before you start; then:

```
git merge --no-ff upstream/master
```

## What merges cleanly

A trial `git merge --no-commit --no-ff upstream/master` was run and then aborted with `git merge --abort`. The working tree was confirmed clean again at `8512eb0f`.

**The only conflicting file is** `src/Text2Image/T2IModelClassSorter.cs`.

These paths auto-merged with no conflict markers (several were "changed in both" but git resolved them). They were listed as "Changes to be committed" in that trial merge:

- `docs/Model Support.md` (modified)
- `docs/Video Model Support.md` (modified)
- `docs/images/models2/h3image.jpg` (added)
- `src/BuiltinExtensions/ComfyUIBackend/ExtraNodes/SwarmComfyCommon/SwarmModels.py` (modified)
- `src/BuiltinExtensions/ComfyUIBackend/ExtraNodes/SwarmComfyCommon/SwarmText.py` (modified)
- `src/BuiltinExtensions/ComfyUIBackend/WorkflowGenerator.cs` (modified)
- `src/BuiltinExtensions/ComfyUIBackend/WorkflowGeneratorModelSupport.cs` (modified)
- `src/Text2Image/CommonModels.cs` (modified)
- `src/Text2Image/T2IParamTypes.cs` (modified)
- `src/wwwroot/js/genpage/main.js` (modified)

Leave those auto-merges alone unless a later compile or review shows a real problem.

## Important: most of T2IModelClassSorter.cs also auto-merges

In the trial merge, conflict markers appeared in **one hunk only**: the MiniMax H3 detector lambdas.

These nearby additions did **not** conflict and were already present together in the merged working tree:

- Upstream added `CompatMiniMaxH3Image` in the compat-class block.
- Upstream added the `minimax-h3-image` and `minimax-h3-image/vae` `Register(...)` calls (both `StandardWidth` / `StandardHeight` = 2048) just before the Anima section.
- The fork's Anima 3.8B and 2.9B `Register(...)` calls were kept immediately after, still before the base Anima class.

So after you resolve the detector hunk, `isMiniMaxH3Image` **must** exist or the already-merged `Register` calls will not compile. Do not drop the Anima variant registrations.

## Exact conflict hunk

Quoted from the trial merge of `src/Text2Image/T2IModelClassSorter.cs` (markers at lines 226–236). This is the only `<<<<<<<` / `=======` / `>>>>>>>` region.

```
<<<<<<< HEAD
        bool isMiniMaxH3(JObject h) => hasKey(h, "video_patch_proj.weight") && hasKey(h, "audio_patch_proj.weight");
        // Anchor on block 49 (H3 DiT is always 50 blocks): 'token_refiner' is only present when the text encoder was trained, and block 0 is absent from front-pruned loras.
        bool isMiniMaxH3Lora(JObject h) => (hasLoraKey(h, "blocks.49.adaln_proj.linear") || hasLoraKey(h, "blocks.49.attn.qkv_proj") || hasLoraKey(h, "blocks.49.attn.out_proj") || hasLoraKey(h, "blocks.49.mlp.fc2") || hasLoraKey(h, "blocks.49.mlp.fc1"))
                                        && !hasLoraKey(h, "blocks.0.attn.gate") && !hasLoraKey(h, "blocks.0.mlp.gate") && !hasLoraKey(h, "blocks.0.attn.wk")
                                        && !hasLoraKey(h, "blocks.49.attn.gate") && !hasLoraKey(h, "blocks.49.mlp.gate") && !hasLoraKey(h, "blocks.49.attn.wk");
=======
        bool isMiniMaxH3(JObject h) => hasKey(h, "video_patch_proj.weight") && hasKey(h, "audio_patch_proj.weight") && hasKey(h, "blocks.49.attn.out_proj.weight");
        bool isMiniMaxH3Image(JObject h) => hasKey(h, "video_patch_proj.weight") && hasKey(h, "condition_proj.weight") && hasKey(h, "blocks.49.attn.qkv_proj.weight") && !hasKey(h, "audio_patch_proj.weight");
        bool isMiniMaxH3Lora(JObject h) => (hasLoraKey(h, "blocks.0.adaln_proj.linear") || hasLoraKey(h, "blocks.0.attn.qkv_proj")) && hasLoraKey(h, "blocks.49.mlp.fc2") && hasLoraKey(h, "token_refiner.blocks.0.attn.out_proj");
>>>>>>> upstream/master
```

HEAD is fork `main` (`8512eb0f`). `upstream/master` is `f86858df`.

## How the two sides differ

### H3 video detector (`isMiniMaxH3`)

- **Fork (ours):** `video_patch_proj.weight` AND `audio_patch_proj.weight`.
- **Upstream (theirs):** the same two keys, plus `blocks.49.attn.out_proj.weight`.

The fork did not rewrite this detector. It is still the original two-key check from upstream `4a2184707` ("MiniMax H3 support (#1469)", 2026-08-02). Upstream tightened it in `5279c53c` when adding H3-Image.

H3-Image itself should not be caught by either video check: it has `video_patch_proj` and no `audio_patch_proj`. The extra `blocks.49` requirement is what can drop **pruned or finetuned H3 video** checkpoints that still have the video and audio patch projections but lack block 49 (Eros and other pruned finetunes are the ones to check). Those would classify as MiniMax H3 on the fork and as unclassified on upstream.

### H3-Image detector (`isMiniMaxH3Image`)

Upstream only. It matches when all of these are true:

- has `video_patch_proj.weight`
- has `condition_proj.weight`
- has `blocks.49.attn.qkv_proj.weight`
- does **not** have `audio_patch_proj.weight`

Upstream also registers:

- `minimax-h3-image` — name "MiniMax H3 Image", 2048×2048
- `minimax-h3-image/vae` — name "MiniMax H3 Image VAE", 2048×2048 (autodetect returns `false`; the VAE is identified another way)

The target still-image checkpoint is `minimax/minimax_h3_image_pruned_int8_convrot.safetensors`. It is a pruned ConvRot int8 DiT. Confirm after refresh that this detector actually classifies it (it requires `blocks.49.attn.qkv_proj.weight`).

### H3 LoRA detector (`isMiniMaxH3Lora`)

- **Fork (ours):** anchors on block 49 (any of `adaln_proj.linear`, `attn.qkv_proj`, `attn.out_proj`, `mlp.fc2`, `mlp.fc1`). It does **not** require `token_refiner` or block 0. It excludes keys used by Krea2 (`attn.gate`, `mlp.gate`, `attn.wk` on blocks 0 and 49) so those stay `krea-2/lora`.
- **Upstream (theirs):** still the original check: (`blocks.0.adaln_proj.linear` OR `blocks.0.attn.qkv_proj`) AND `blocks.49.mlp.fc2` AND `token_refiner.blocks.0.attn.out_proj`.

Taking upstream's LoRA detector wholesale can miss front-pruned LoRAs (no block 0) and LoRAs trained without the text-encoder `token_refiner` keys.

### Anima

The fork registers Anima 3.8B and 2.9B checkpoint / LoRA / ControlNet classes in this same area of the file. Upstream has only the base Anima classes. These are not in the conflict markers; they already auto-merge. Keep them.

## Fork commits that introduced the detector changes

Check these if you need the reason, not just the diff.

**H3 LoRA relaxation (fork-only, this is the important one):**

- `59d48a14b` (`59d48a14b3da36eb4d3b8d89541c0e17635a3046`)
- Author: socrasteeze, AuthorDate Fri Sep 18, 2026, 9:28 AM PT
- Message: "Relax MiniMax H3 LoRA detection"
- Commit message, in full: detection required `token_refiner` keys, which are only present when the text encoder was trained, and anchored on block 0, which front-pruned LoRAs do not carry. It re-anchored on block 49 because the H3 DiT is always 50 blocks deep, and accepts any of the adaln/attn/mlp projections so MLP-only and attention-only LoRAs match. It guards against Krea2, which shares the block depth but uses wk/wq/gate naming. **Local library result recorded in that commit: 63 of 79 MiniMax LoRAs recognized before, 78 after, with no change across 8221 LoRAs of other architectures.** The remaining file was a Krea2 LoRA stored in the minimax folder.

**Anima variant classes (fork-only, same region of the file, already auto-merges):**

- `9603351e8` (`9603351e83d7f829354bbbea11ee5799319d12bd`) — "Split Anima into base, 2.9B, and 3.8B compat classes", AuthorDate Wed Oct 14, 2026, 9:37 AM PT
- `e34f5a167` (`e34f5a167cff63f51025ecb15e9be22901a2cad1`) — "Fix Anima variant classification and compatibility filtering", AuthorDate Wed Oct 14, 2026, 1:27 PM PT

**Upstream history still on both sides (for context):**

- `4a2184707` — "MiniMax H3 support (#1469)" (2026-08-02): introduced `isMiniMaxH3` as `video_patch_proj` + `audio_patch_proj`. The fork still has this version of the video detector.
- `06bb9c860` — "detect h3 loras" (mcmonkey, 2026-08-04): introduced the LoRA detector that upstream still uses, and that `59d48a14b` later relaxed on the fork.
- `5279c53c` — "first draft H3-Image support": added `isMiniMaxH3Image`, the image model/VAE classes, `CompatMiniMaxH3Image`, and the extra `blocks.49.attn.out_proj.weight` requirement on the video detector. It did not change the LoRA detector.

## Suggested resolution (suggestion, not a decision)

1. Keep the fork's Anima 3.8B / 2.9B registrations (already in the auto-merged Register section).
2. Add upstream's `isMiniMaxH3Image` detector and keep the auto-merged `minimax-h3-image` / `minimax-h3-image/vae` classes and `CompatMiniMaxH3Image`.
3. For `isMiniMaxH3` (video) and `isMiniMaxH3Lora`, **do not blindly take ours or theirs.** Check the fork owner's actual files against both rules before choosing:
   - H3 video checkpoints: `F:\Models\checkpoints\minimax`
   - H3 LoRA folders on `F:\` (the MiniMax LoRA library that `59d48a14b` measured)
   - Pruned or finetuned video checkpoints may lack block 49, so upstream's tighter `isMiniMaxH3` could stop them being detected.
   - Front-pruned LoRAs may lack block 0, and some LoRAs lack `token_refiner`, so upstream's `isMiniMaxH3Lora` could stop them being detected. That is exactly why `59d48a14b` exists.

A likely combined shape, if the file checks confirm the fork still needs its relaxed rules:

- Keep fork `isMiniMaxH3` (two keys, no required block 49) **or** take upstream's three-key version only if every current H3 video checkpoint still has `blocks.49.attn.out_proj.weight`.
- Keep fork `isMiniMaxH3Lora` (block 49 + Krea2 exclusions) **or** take upstream's only if the current LoRA library still all match.
- Always add `isMiniMaxH3Image` from upstream.

## After the merge is committed

1. Build. Code changes in this repo normally go through headless Grok Build (`grok-4.7-build-fast`).
2. **Do not restart Swarm** unless the fork owner explicitly says to restart at that moment. Building is allowed; restarting is not implied.
3. After a restart the fork owner has approved, run TriggerRefresh and verify:
   - `minimax/minimax_h3_image_pruned_int8_convrot` classifies as **MiniMax H3 Image**
   - `minimax_h3_image_vae_fp16` (`F:\Models\vae`) is listed
4. Only once that is verified, create the preset `minimax/H3-Image` with:

   - Size: 2048×2048, aspect 1:1 (upstream's model-class default; keep the size editable per run)
   - Steps: 6
   - CFG: 1
   - Sampler / scheduler: euler / simple
   - Negative: empty
   - VAE: the H3 image VAE (`minimax_h3_image_vae_fp16`)
   - Qwen Model: leave unset. The code default in `GetQwen3vl_32bMiniMaxModel()` is `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`, which already exists in `E:\models\text_encoders`, so Swarm should not auto-download the encoder.
   - Outpath: `minimax/[year]-[month][day][hour][minute][request_time_inc]` (flat into the minimax folder)
   - No LoRAs
   - Compile: unset

5. Do not create a duplicate preset. Do not run a test render unless the fork owner asks.

## Standing rules

- No `.bak` files
- No model renames or deletions
- No edits under `_Archive`
- No test renders unless asked
- No restarts of Swarm, Comfy, or anything else on the desktop unless the fork owner explicitly says so at that moment
- Do not push unless the fork owner asks
- Do not bypass access denials
- Report output paths at their physical `D:\Pictures\.output\...` location if any generations happen later
- Code changes in this repo go through headless Grok Build
