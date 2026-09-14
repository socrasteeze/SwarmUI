# HANDOFF

**Updated:** 2026-09-12 | **Branch:** `main` | **Base:** `ee7869a4` (`origin/main` at review) | **Tree:** clean-delivery snapshot; verify current Git status

## State

The review and initial handoff were committed as `251db0ec`. The first WebUI performance tranche is implemented and validated; this handoff accompanies its clean delivery commit.
The user waived the handoff line cap. Commit, tracker reconciliation, and push to `origin/main` are authorized. The tracked-source boot passes; the live server was not restarted and its separate user-extension failure remains open.

## Done this session

- Committed the initial review and handoff as `251db0ec`, with the required author and committer. No push was performed.
- Applied user settings before the initial form build. Startup now builds once, keeps preset inputs deferred, and does not build hidden server settings. Settings failure falls back to one default build.
- Batched parameter/settings width measurements in separate read, append, measure, write, and cleanup phases. Isolated wrappers preserve long-label wrapping at phone and desktop widths.
- Deferred model browsers through SwarmUI's movable-tab click handler. Relocated selected tabs work; loaded catalogs retain refresh behavior. Model wrappers use a prebuild threshold of 50 with progressive sections.
- Added bounded individual LoRA metadata loads for selected-LoRA details before catalog activation. Added timeout, shared pending requests, canonical caching, and shared stale-popup intent guards.
- Corrected deferred section offsets so progressive cards keep unique menu IDs and action ownership across multiple chunks.
- Deferred Genpage autocomplete. Boot user data is 30 KB instead of 7.55 MB decoded. Exact-source loading preserves Genpage escaping while retaining standalone defaults; formatting yields, publishes atomically, and rejects stale responses.
- Recorded two matched baseline and candidate runs in [the review](docs/WebUI-Performance-Review.md). Largest-task mean fell 46.8%; diagnostic blocking-work sum fell 75.7%; startup DOM count fell 73.7%. These are local Chromium diagnostics, not phone benchmarks.
- Release build passed with zero warnings/errors. Full NUnit: 122 passed. Both format checks passed. Existing browser harnesses: 50/50 mobile performance, 27/27 LoRAs, 11/11 mobile layout, 91/91 standalone Create. Three new focused harnesses pass.
- Root-checkout boot reached running but exited 1 because ignored `SwarmUI-VideoStages` still references removed `RunSeedVR2Stage`. A detached tracked-source worktree with all 16 publishable overlay files passed Release build and isolated boot with exit 0; source hashes matched. The temporary worktree was removed without changing user extensions.
- Rechecked the supplied behavioral guardrails. Root guidance already contained all four; added explicit final-diff/acceptance checks, removed unused autocomplete bookkeeping and response metadata, and strengthened settings-invalidation tests. Autocomplete checks and all 122 NUnit tests still pass.

- Reconciled the local tracker: first-tranche source delivery, remaining performance work, the VideoStages bug, and the existing device checklist. Local descriptions were read back successfully; collaborative body storage remains unavailable after retry.

## Open

Work in this order. The review contains implementation evidence and remaining acceptance criteria.

1. Confirm the delivery state from Git before resuming: the first-tranche source delivery is distinct from production deployment and physical-device acceptance.
2. Resolve the existing `SwarmUI-VideoStages` compatibility failure separately before treating the full boot gate as passed.
3. When deployment is authorized, run the new compiled runtime, then bypass browser caches and verify exact-source autocomplete with the live server. Hub/spoke compatibility must be respected. Current browser measurements used JavaScript response overrides; the new endpoint has compiled NUnit coverage.
4. Complete actual installed-PWA and physical Android/iOS checks: cold/warm load, keyboard, orientation, gesture reversal, app resume, and final-image behavior.
5. Investigate remaining startup tasks around 1.5 seconds and first catalog opens above the interaction target. Rich LoRA metadata is still approximately 17 MB decoded; API paging and more selective hidden-form construction need a separate measured pass.
6. Continue the planned search/history package: filter with cached search text before full descriptors, reuse parsed metadata, and preserve refresh/scroll/action semantics.
7. Keep mobile drag, progress/preview coalescing, and polling changes separate. Collect appropriate live interaction traces before changing generation-display behavior.

### Prompt Enhance Strength (shipped 2026-09-12, live-verified)

The writer profiles default to a faithful rewrite, so "Enhance" rarely added anything. A **Strength** control (Faithful / Expand / Full scene, default Full scene) prepends a directive to the user message; the six profile assets stay byte-identical to the pack.

- Faithful = nothing; Expand = `Mode: expand`; Full scene = `Mode: expand` + a build-a-complete-scene instruction that forbids naming an unrequested art style and echoing the instruction. The first wording ("keep the art style I asked for") was echoed into Krea 2 prompts verbatim; do not reintroduce it.
- Edit profiles (`qwen-image-edit-2511`) cap at Expand: live test showed Full scene invents a new setting and contradicts the edit.
- A user-typed `/rewrite`, `/expand` or `Mode:` prefix wins; no directive is added.
- Directive is applied after `Shield`; strength joins the cache key and the provenance JSON; `ListPromptEnhanceStatus` reports allowed strengths.
- One Sonnet builder. Gates: Release build, `dotnet test`, both format checks, `verify-promptenhance.mjs`, then live Krea 2 ×3 strengths, Illustrious Full scene (tags stay tags), Qwen Edit cap.
- Writer stays `huihui_ai/qwen3-vl-abliterated:8b-instruct` (same family as Krea 2's Qwen3-VL-4B encoder). The 27B Qwen3.8 Q4 ran at 11.7 tok/s vs ~80 and wrote no better.

### MiniMax H3 Ref2VA: Swarm vs the clean ComfyUI config (logged 2026-09-13, no action decided)

Clean-audio ComfyUI run (18 runs, 2026-09-13): Turbo 8-step LoRA, `euler`/`simple`/8, sigma shift video 8 / audio 5, H3 Memory Optimization only, ≤294 frames, reference clip trimmed so its soundtrack matches the post-snap frame count and fed via `ref_video_audio_N`. FirstBlockCache, Spectrum and Sparse Attention all broke audio. Swarm differs:

- Audio sigma shift is hard-coded to 3 (`WorkflowGeneratorModelSupport.cs` `MiniMaxH3SigmaShift` node); only video shift is a param (default 12). Audio 5 is not reachable.
- Reference-video soundtrack is never wired: `WorkflowGenerator.cs` sends only frames to `SwarmMiniMaxH3CollectReferences` (the `// TODO: Handle videos with embedded audio properly`), so `ref_video_audio_N` stays empty. Swarm's ref-video path is video-only, a different path from the tested one.
- No guard or warning above 294 frames (362 broke audio every run); no warning that FirstBlockCache/Spectrum break H3 audio.
- `length` passed to CollectReferences is the raw frame count, not the 17k+5-aligned one (node re-snaps; likely harmless).
- Reachable by hand today: video shift 8, euler/simple/8 + Turbo LoRA, Memory Optimization on, ≤294 frames, no caches.

Candidate changes if pursued: audio shift param, wire the ref video's soundtrack, frame cap/warning.

### MiniMax H3 FL2VA: suggested starting config (logged 2026-09-13, untested)

No measured FL2VA run exists; all 18 runs above were Ref2VA. Baseline is the documented default (`docs/Video Model Support.md`), which Swarm already uses: CFG 1, 20 steps (10 often enough), `res_multistep`/`simple`, sigma shift video 12 / audio 3 (audio fixed), frames 5+17n up to 362, sides ~512–1536, Audio Silent Prefix Duration ~0.1. Use the Image To Video group with the FL2VA model; "Video End Image" sets the last frame.

- Cache audio breakage does not carry over (operator, 2026-09-13): the Ref2VA FirstBlockCache/Spectrum/Sparse Attention failures are attributed to the reference-audio input, which FL2VA does not have. Unverified on FL2VA until a run confirms it.
- Planned FL2VA config: H3 Memory Optimization + H3 FirstBlockCache at its defaults (Custom, Safe-preset values, Temporal Guard on). FBC is silently skipped (log warning only) if Spectrum, TeaCache or EasyCache is also active, so keep those off. FBC reuse is bounded (0.10–0.95 window, max 2 hits), so its gain is small at Turbo step counts and real around 20 steps.
- Untested: Turbo LoRA at `euler`/`simple`/8.
- Does not transfer: the ≤294-frame limit (measured on the reference path only) and shift 8/5 (tuned with Turbo on Ref2VA; audio 5 unreachable in Swarm).
- Suggested test to get a real baseline: same prompt and seed at 124 frames, Memory Optimization on, FBC off vs on; then 294 vs 362 frames with the winner. Judge audio separately and read the config back from the output's embedded `prompt` tag.

#### FL2VA parameter lists (Swarm UI)

Pick the path by input: **no image → T2V** (FL2VA as main Model); **first frame (± last) → I2V** (Image To Video group). On the T2V path, images attached to the prompt box go to `SwarmMiniMaxH3CollectReferences` as `<Picture N>` (Ref2VA-style), never as a keyframe; only the I2V path emits `SwarmMiniMaxH3AddKeyframes`.

T2V (text only):

| Group | Param | Value |
|---|---|---|
| Core | Model | FL2VA (or hybrid) |
| Core | Steps / CFG Scale | 20 (8 with Turbo) / 1 |
| Resolution | Width × Height | sides ≤1536, e.g. 1216×704 |
| Video | Text2Video Frames / Video FPS | 124 or 243 (max 362) / 24 |
| Sampling | Sampler / Scheduler | unset (`res_multistep`/`simple`); Turbo: `euler`/`simple` |
| Sampling | Sigma Shift | 12 |
| Audio | Audio Silent Prefix Duration | 0.1 (prefix, not suffix) |
| H3 Memory Optimization | enable | on, defaults |
| H3 FirstBlockCache | enable | per planned config above (defaults); Spectrum/TeaCache/EasyCache off |
| LoRAs | Turbo 8-step | only with Turbo steps; skip on Turbo-merged checkpoints (e.g. Dasiwa hybrid Turbo) |
| Prompt | — | visuals + audio; no attached images |

I2V (first/last frame): same Sampling, Audio, H3 and prompt rows as T2V, plus:

| Group | Param | Value |
|---|---|---|
| Init Image | Init Image / Creativity | first frame / **0** (main-model Steps/CFG then barely matter) |
| Image To Video | Video Model | FL2VA (or hybrid) |
| Image To Video | Video Frames / Steps / CFG | 124 or 243 (max 362) / 20 (8 Turbo) / 1 |
| Image To Video | Video Resolution / FPS | sides ≤1536 / 24 |
| Image To Video | Video End Image | last frame (optional) |

Leave alone for FL2VA: prompt-attached images/audio/video (Ref2VA inputs), Refiner, Video Swap Model, Video Extend.

Observed 2026-09-13 21:19: a T2V job on `DasiwaMinimaxH3_dasiwaHybridTurboV2` at 2176×1696 × 243 frames with a prompt-attached image and no Memory Optimization sat at `0/8 Model Initializing` for 11+ min (GPU 100 % util at 111 W, 32 GB VRAM full, i.e. offload-thrashing). Cause: resolution (~1M tokens), not a hang.

Prior unrelated open items remain separate from performance work. Their live status was not rechecked during this review:

- Publication of the external prompt-guide repository remains unverified. Prompt Enhance source is already part of this repository's main history.
- MiniMax H3 prompt doctrine remains deferred pending real generations. Do not infer quality from static review.
- Interrogate modal: verify the WD14-only method list, options, a returned-tag round trip, and Character Sheet's Analyze Pose action.
- Confirm the intended Qwen Image Edit model architecture assignment in the Models tab.
- Route one generation through the configured spoke and verify completion.
- Prior physical-device acceptance, spoke backup-file cleanup, a preview-decode warning, and the companion service restart remain unverified. Do not perform unrelated cleanup or restart during this tranche.


## Decisions

- Optimize the existing architecture. Keep upstream's native mobile Genpage layout and the separate `/simple` client.
- First tranche: startup build/sizing, hidden model-browser loading, and lazy Genpage autocomplete. Search/history and gesture/progress work follow measurements.
- Preserve compact `ListT2IParams`, paged lazy LoRA Select2 results, lazy `/simple` autocomplete, cached mobile geometry, frame-coalesced layout, thumbnails, compression, and versioned asset caching.
- One lower-tier implementation owner per bounded package. Centralize integration and validation. Avoid review panels, duplicated scans, and concurrent edits to the same files.
- Keep reports short and retain durable findings in the review. A runtime trace is stronger evidence than a source pattern alone.
- A single animation-frame callback around the existing layout loop is not batching. Separate measurement and write phases to remove repeated forced layout.
- A model browser's DOM cap does not cap its API response. If on-demand loading leaves first-open latency high, scope API paging separately.
- Permission-aware model caches, workers, and full virtualization are conditional follow-ups, not first-tranche prerequisites.
- The line-cap exception applies to this handoff. Preserve useful decisions and traps without copying the entire review.
- Preserve Prompt Enhance contracts: profiles are versioned assets; provenance uses a hidden parameter; cache lookup intentionally precedes endpoint-health rejection. No redesign is in scope.

## Traps

- Read root [AGENTS.md](AGENTS.md). It is the fork's authority. Keep upstream commits byte-identical and never push or open a pull request upstream.
- Every commit must retain the configured author and committer identity. Do not add attribution trailers. Run the clean workflow before delivery.
- Before this refresh, the working tree contained only the untracked review. Preserve changes that appear from other sessions.
- Lower-tier sessions share editor metadata. They must not rename this session or change its phase. The main session owns metadata updates.
- Runtime directories and downloaded backends are not implementation targets. Do not edit user settings, models, output, backend dependencies, or production data.
- Release builds cache extension assets in memory. Browser cache bypass alone cannot refresh them. Schedule a server restart separately, then bypass browser cache.
- Never build into `src/bin/live_release` while the live server holds the executable. Use the default Release output.
- Boot tests need a throwaway data directory and free port. Otherwise they can load live settings and collide with the running server.
- Diagnostic probes disabled service workers and blocked automatic `TriggerRefresh`, non-allowlisted APIs, and external origins. They are not unrestricted production benchmarks.
- Temporary probes are not tracked or portable. Recreate a bounded probe or maintain a source-backed harness; do not depend on a particular temporary file.
- Fresh browser contexts do not clear server caches. CPU slowdown is uncalibrated diagnostic stress, not a physical phone model.
- Baseline call tracing found two initial `genInputs` calls. The new path calls `loadSettingsEditor(true, callback)` before session-ready callbacks and builds once. Do not restore the old settings session-ready registration.
- Width batching must preserve font-sensitive widths, `nogrow`, selection values, minimum sizes, and stable geometry. Hidden controls must size correctly on first display.
- First-open model and autocomplete loading must not move the startup freeze to the first action. Preserve retry and invalidation behavior.
- Keep intermediate preview coalescing separate from final-image, error, and completion delivery. Never drop terminal generation messages.
- Prior integration trap: do not mirror an LLM backend as an image backend when `CanLoadModels` is true. This is outside the current scope.
- Prior integration trap: fixed prompt popovers belong under `document.body` to avoid transformed or scrolling ancestors becoming their containing block.
- Do not write runtime `.fds` files with a BOM. Their backslash and empty-string escaping is intentional. Runtime edits require a separate stopped-service workflow.
- Hub/spoke commit compatibility remains a deployment gate. Do not deploy one side implicitly during frontend verification.

## Verify

Documentation commit checks:

```powershell
git status --short
git diff --check
git diff -- HANDOFF.md
git log origin/main..HEAD --format="%h %an <%ae> | %cn <%ce> %s"
```

Existing targeted checks, rerun and passed for this tranche:

```powershell
node src/BuiltinExtensions/MobileEnhancements/verify/verify-mobile-perf.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-genpage-loras.mjs
```

New focused checks, passed:

```powershell
node src/BuiltinExtensions/MobileEnhancements/verify/verify-genpage-startup.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-genpage-model-loading.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-genpage-autocomplete.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-mobile-layout.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-create-panel.mjs
```
Implementation gates. Build, tests, and both formatting checks passed for this tranche:

```powershell
dotnet build SwarmUI.sln --configuration Release
dotnet test SwarmUITests/SwarmUITests.csproj --configuration Release
dotnet format SwarmUI.sln --verify-no-changes
dotnet format style --verify-no-changes
dotnet build Desktop/Desktop.csproj --configuration Release
```

Isolated boot example. Choose a free port and a new throwaway directory. The root-checkout run returned 1 due to the existing VideoStages issue; the isolated tracked-source run returned 0.

```powershell
dotnet src/bin/Release/net8.0/SwarmUI.dll --ci_test true --launch_mode none --loglevel debug --data_dir "$env:TEMP\swarm-perf-ci\data" --port 7899
```

Read-only live status commands:

```powershell
node tools/swarm_api.mjs GetCurrentStatus
node tools/swarm_api.mjs ListBackends
```
