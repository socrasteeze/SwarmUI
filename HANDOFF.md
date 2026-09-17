# HANDOFF

**Updated:** 2026-09-17 · **Branch:** `main` · **Base:** `af86ceef` · **Tree:** clean after this delivery commit

## State
Mobile/PWA fixes and the 2026-09-15 upstream merge (`5f804cce`) are built and pushed; none are verified on a phone and the live server has not been restarted to serve them.
The user waived the handoff line cap; the H3 reference sections below were logged at the user's request.

## Done this session
- Classic preset editor no longer freezes on open: width measurements batch into one pass (951 ms → 75 ms desktop, 690 controls identical) — `src/wwwroot/js/site.js` `AutoWidthBatchHelper.batch`, `src/wwwroot/js/genpage/gentab/presets.js`
- `/simple` preset editor offers FL2VA Image To Video fields — `src/BuiltinExtensions/MobileEnhancements/Assets/m/m_presets.js` (`FL2VAParams`)
- Classic "+" menu splits "Add Temporary Image" (`image/*`) from "Add Temporary Video/Audio" — the combined filter made the iOS Files picker slow to populate — `src/wwwroot/js/genpage/gentab/prompttools.js`
- Installed-PWA "+" button now level with Generate (safe-area padding had centered it 17 px low) — `src/BuiltinExtensions/MobileEnhancements/Assets/mobile.css`
- Merged upstream `5f804cce` ("probably fix video audio input for h3 i2v"), no conflicts — see AGENTS.md Upstream Sync Log
- 2026-09-16: fast-forwarded `main` to `c68744af` (a prepared but unpushed sync branch merging 3 more upstream commits — waveform/duration utility extraction, no conflicts, no `.cs` files) and pushed to `origin/main`; dotnet unavailable in this container so build/format/test gates could not be run — see AGENTS.md Upstream Sync Log
- 2026-09-17: routine automated sync check (unrelated to the mobile/PWA thread above) — `upstream/master` had 0 new commits since the 2026-09-16 second sync, so nothing to merge. Installed `dotnet-sdk-8.0` via apt into this container (previously unavailable) and ran the full gate suite anyway: build clean, headless boot clean (after fetching upstream tags read-only, same as CI), but `dotnet format --verify-no-changes` and `dotnet test` both fail in this sandbox in ways that reproduce identically before touching anything — see AGENTS.md Upstream Sync Log for the detail. Logged only; no feature work touched.
- 2026-09-17 (second sync, later the same day): merged 1 new upstream commit, "Model Downloader: handy manual folder name input" (`7de3e8d`) — 4 files, both fork touchpoints it touched (`GenTabModals.cshtml`'s paste-modal div, `utiltab.js`'s `ForwardImageRequest` fix) auto-merged clean and were re-verified present. Confirmed the format/test/no-tags-boot failures logged above are pre-existing by building and boot-testing the pre-merge tree in a throwaway worktree — all three reproduced identically there, so this merge introduced no new gate failures. Pushed to `origin/main` via `/clean`. This sync ran unattended (scheduled, no human watching live).

- 2026-09-17 (third check, later still): `git fetch upstream` showed 0 new commits past `7de3e8de`; nothing merged, no gates run, nothing pushed. Logged in AGENTS.md Upstream Sync Log. All earlier handoff detail above is unchanged.

## Open
1. Restart Swarm, bypass the PWA cache, then on the iPhone confirm: preset edit opens without freezing, "Add Temporary Image" Files picker opens as fast as `/simple`, "+" is level with Generate.
2. Decide whether `/simple` gets Start frame / End frame slots (send `initimage` / `videoendimage`). Today `/simple` cannot set keyframes; prompt images go to H3 as `<Picture N>` references.
3. Classic preset editor's first open still costs ~1.6 s desktop: `ensurePresetInputsBuilt()` calls full `genInputs()`, rebuilding the main panel too — `presets.js:197`.
4. Run the FL2VA baseline test listed under Reference and record results.
5. Decide on the Ref2VA gaps (audio shift param, ref-video soundtrack wiring, >294-frame warning) — `WorkflowGeneratorModelSupport.cs` `MiniMaxH3SigmaShift`, `WorkflowGenerator.cs` CollectReferences block.
6. Prompt Enhance endpoints point at `qwen3.8-27b-q4` (~12 tok/s) while the decision below says the 8B writer stays; reconcile `Data/PromptEnhance/endpoints.json` with the user (runtime file, user-owned).
7. Carried: `SwarmUI-VideoStages` still references removed `RunSeedVR2Stage` (root boot exits 1); physical-device PWA acceptance; startup/LoRA-metadata performance pass per `docs/WebUI-Performance-Review.md`.
8. Unconfirmed sandbox-only gate failures from the 2026-09-17 sync (see AGENTS.md Upstream Sync Log): `dotnet format --verify-no-changes` reports 122 pre-existing whitespace findings across 6 files, and `dotnet test` fails to build the NUnit suite with 53× `CS0121` ambiguous-overload errors (`TestDelegate` vs `Action`). Both reproduce on a clean checkout with no merge involved, so they're either a real latent issue or an SDK/Roslyn version mismatch with this sandbox's apt-installed `dotnet-sdk-8.0` (8.0.131) — needs confirming on the normal build box.

## Decisions
- Split the classic media menu (option A) over images-only-on-touch (B) or an extension override (C) — keeps video/audio reachable everywhere; accepts an upstream-file edit.
- Batch width measurement inside `AutoWidthBatchHelper` over skipping `triggerChangeFor` in `clearPresetView` — keeps every change listener running, only the layout reads merge.
- `/simple` FL2VA fields prefill only params the server advertises and never overwrite existing values; Init/End images stay out because the editor stores text.
- Prompt Enhance writer stays `huihui_ai/qwen3-vl-abliterated:8b-instruct`; the 27B wrote no better at ~12 vs ~80 tok/s.
- Planned FL2VA config uses H3 Memory Optimization + FirstBlockCache defaults; the Ref2VA cache audio breakage is attributed to reference audio (operator call, unverified on FL2VA).
- Optimize the existing architecture; keep upstream's mobile Genpage layout and the separate `/simple` client.

## Traps
- AGENTS.md is the fork's authority. Never push or open a PR upstream; no attribution trailers; keep the configured author/committer.
- Release builds cache extension assets in memory: restart the server, then bypass browser cache, or you test old JS/CSS.
- Never build into `src/bin/live_release` while the live server holds it; boot tests need a throwaway data dir and free port.
- `--safe-bottom` is defined on `body`, so setting it on `:root` in a probe does nothing; emulate the PWA with `body.pwa-standalone` plus a body-level value.
- A ComfyUI job stuck inside its first H3 step ignores Interrupt until that step ends; very high resolution (e.g. 2176×1696 × 243 frames) looks hung. Restart the backend instead.
- Other sessions commit to `main` concurrently; re-fetch and re-read before editing shared files (HANDOFF.md, m_presets.js changed underneath this session twice).

## Reference: MiniMax H3

**Ref2VA clean ComfyUI config (2026-09-13, 18 runs):** Turbo 8-step LoRA, `euler`/`simple`/8, shift video 8 / audio 5, Memory Optimization only, ≤294 frames, reference clip trimmed so its soundtrack matches the snapped frame count and fed via `ref_video_audio_N`. FirstBlockCache, Spectrum, Sparse Attention broke audio. Swarm gaps: audio shift hard-coded 3; ref-video soundtrack never wired (video-only path); no >294-frame or cache-audio warning; CollectReferences gets the unaligned frame count (node re-snaps).

**FL2VA baseline test:** same prompt/seed at 124 frames, Memory Optimization on, FBC off vs on; then 294 vs 362 with the winner. Judge audio separately; read config back from the output's embedded `prompt` tag. The ≤294 limit and shift 8/5 were measured on Ref2VA only.

**FL2VA path choice:** no image → T2V (FL2VA as main Model). First frame (± last) → I2V (Image To Video group). On T2V, prompt-attached images become `<Picture N>` references, never keyframes; only I2V emits `SwarmMiniMaxH3AddKeyframes`.

| Setting | T2V | I2V |
|---|---|---|
| Model | Model = FL2VA/hybrid | Video Model = FL2VA/hybrid; Init Image = first frame, Creativity **0** |
| Frames / FPS | Text2Video Frames 124/243 (max 362) / 24 | Video Frames 124/243 / Video FPS 24 |
| Steps / CFG | 20 (8 Turbo) / 1 | Video Steps 20 (8 Turbo) / Video CFG 1 |
| Resolution | sides ≤1536, e.g. 1216×704 | Video Resolution sides ≤1536 |
| Last frame | — | Video End Image (optional) |
| Sampler / Scheduler | unset (`res_multistep`/`simple`); Turbo `euler`/`simple` | same (global) |
| Sigma Shift | 12 | 12 |
| Audio Silent Prefix Duration | 0.1 (prefix, not suffix) | 0.1 |
| H3 groups | Memory Optimization on; FBC per planned config; Spectrum/TeaCache/EasyCache off | same |
| LoRA / Prompt | Turbo LoRA only with Turbo steps, not on Turbo-merged checkpoints; describe visuals + audio, no attached images | same |

Leave alone for FL2VA: prompt-attached images/audio/video, Refiner, Video Swap Model, Video Extend.

## Verify
```powershell
dotnet build SwarmUI.sln --configuration Release
dotnet test SwarmUITests/SwarmUITests.csproj --configuration Release
dotnet format SwarmUI.sln --verify-no-changes
dotnet format style --verify-no-changes
node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-presets.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-genpage-startup.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-genpage-loras.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-mobile-layout.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-mobile-perf.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-create-panel.mjs
node tools/swarm_api.mjs GetCurrentStatus
```
