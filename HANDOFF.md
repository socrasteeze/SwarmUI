# HANDOFF

**Updated:** 2026-09-17 (H3 preset session) · **Branch:** `main` · **Base:** `e82a24b5` · **Tree:** clean

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

- 2026-09-18: routine automated sync check. `git fetch upstream` showed `upstream/master` still at `7de3e8de`, 0 new commits since the 2026-09-17 second sync; nothing to merge, no gates run (no source changed). Logged in AGENTS.md Upstream Sync Log and pushed via `/clean`. This sync ran unattended (scheduled, no human watching live). All earlier handoff detail above is unchanged.

- 2026-09-19: routine automated sync check (fresh container, no `dotnet` preinstalled, `upstream` remote missing — both set up from scratch per AGENTS.md). Local `main` was found 46 commits behind `origin/main` (unrelated prior-session work already pushed) and was fast-forwarded first. `git fetch upstream` showed `upstream/master` still at `7de3e8de`, 0 new commits since 2026-09-17's second sync; nothing to merge, no conflicts, no AGENTS.md-reintroduction risk. Unlike the 2026-09-16 sync, `dotnet-sdk-8.0` installed cleanly via apt this time, so the full gate suite ran for real: build clean (0 warnings/errors), headless boot clean, `dotnet format` and `dotnet test` reproduce the same pre-existing 122-whitespace / 53×`CS0121` sandbox failures logged since 2026-09-17 (counts re-confirmed by grep, not assumed carried-over). `dlbackend/` does not exist in this container (bare source checkout, never run) so there was no ComfyUI backend or custom_nodes to review/fast-forward — noted honestly per the task's own instruction not to fabricate that work. Logged in AGENTS.md Upstream Sync Log and pushed via `/clean`. Ran unattended (scheduled, no human watching live). All earlier handoff detail above is unchanged.

- 2026-09-17 (H3 preset session, separate thread from the mobile/PWA work above): created 12 MiniMax H3 sampling presets via the AddNewPreset API and researched which accelerators actually apply at turbo step counts. Details in "Reference: MiniMax H3" → the three new subsections. Two prior beliefs were corrected (sparse attention does not harm FL2VA; the Sol INT8 defaults are fine on ComfyUI 0.36.0) and the FBC/MemOpt line under Decisions was struck. No repo source was touched by this work — presets live in `Users.ldb`. Separately committed two pre-existing uncommitted edits found in the tree (`e82a24b5`, Ultralytics/SAM path forwarding + Anima LoRA detection), which were **not** from this session; the user confirmed committing them.

- 2026-09-21: routine automated sync check. Fresh container (no `dotnet`, no `upstream` remote, checked-out branch was a leftover `noble/trusting-dijkstra-gh18mu` matching `origin/main`) — both set up from scratch, local `main` fast-forwarded 55 commits to `origin/main` first (all already-pushed prior work). `git fetch upstream` found 1 new commit, "Adds Qwen2.1 support" (#1548, `2de300f`) — merged clean, no conflicts, the 3 fork touchpoints it overlapped (`T2IModelClassSorter.cs` Anima/Ideogram/SAM3 detection, `WorkflowGeneratorModelSupport.cs` MiniMaxH3SigmaShift, `WorkflowGenerator.cs` CollectReferences) re-verified present and disjoint after the merge. Merge commit `031230f`. Full gate suite ran: build clean, headless boot clean, `dotnet format`/`dotnet test` reproduce the same pre-existing sandbox failures (122 whitespace findings, now 55×`CS0121` — the +2 is `TagDexLibraryTests.cs`, added by the TagDex feature work this sync fast-forwarded in, hitting the same known Roslyn artifact, confirmed pre-existing by testing a throwaway worktree of the pre-merge tip). Found a separate `/home/user/ComfyUI` checkout in this container with a `custom_nodes/` dir — it's an unrelated sibling fork (`socrasteeze/ComfyUI`, own AGENTS.md/history), not SwarmUI's `dlbackend/` and not referenced by this checkout, holds only ComfyUI's stock example files, left untouched as out of scope. Logged in AGENTS.md Upstream Sync Log and pushed via `/clean`. Ran unattended (scheduled, no human watching live). All earlier handoff detail above is unchanged.

## Open
1. Restart Swarm, bypass the PWA cache, then on the iPhone confirm: preset edit opens without freezing, "Add Temporary Image" Files picker opens as fast as `/simple`, "+" is level with Generate.
2. Decide whether `/simple` gets Start frame / End frame slots (send `initimage` / `videoendimage`). Today `/simple` cannot set keyframes; prompt images go to H3 as `<Picture N>` references.
3. Classic preset editor's first open still costs ~1.6 s desktop: `ensurePresetInputsBuilt()` calls full `genInputs()`, rebuilding the main panel too — `presets.js:197`.
4. Run the FL2VA baseline test listed under Reference and record results. **Note:** its FBC-off-vs-on arm is superseded for turbo checkpoints — see "Turbo H3 acceleration". Still valid on the non-distilled 25-step path.
4b. Run the sampler shootout: Grid Gen presets axis, fixed seed + init image, four `AB/s8` presets. The only open H3 question research cannot answer (author's style/motion/audio claims are subjective and untested on this content).
4c. Write prompts in ref2va/t2va format in preference to i2v style — all 19 new presets carry **no prompt** by design, so the operator supplies it and the Grid Gen override trap does not apply. See the softened prompt-format note under "Eros Max author guidance": the failure case is a thin prompt plus i2v style, not i2v style alone. The two original `minimax/FL2VA*` presets still carry their own prompt scaffold.
5. Decide on the Ref2VA gaps (audio shift param, ref-video soundtrack wiring, >294-frame warning) — `WorkflowGeneratorModelSupport.cs` `MiniMaxH3SigmaShift`, `WorkflowGenerator.cs` CollectReferences block.
6. Prompt Enhance **verified working 2026-09-17** (extension loads 7 writer profiles, pack 1.3.0; all 3 endpoints reachable). Config still points at `qwen3.8-27b-q4` while the decision below says the 8B stays — user chose to **leave it as-is** after verification. Raw-API A/B on the laptop host: 27B 16.0 tok/s and leaked chain-of-thought into the output ("We need answer user's request..."), 8B 47.5 tok/s and returned a clean usable prompt. That test bypassed the writer profiles, so the leak may be suppressed in real use. Second data point 2026-09-18, on the **ComfyUI** node (image-to-prompt, not this feature): a 27B vision model beat a 4B decisively on Danbooru-tag output (80/80 vs 41/80 format-clean over 280 runs each). That does not contradict the 8B decision here — text-to-text prompt expansion is an easy task where 8B suffices, while image-to-tags is hard. Judge each task separately rather than carrying one model verdict across both. Both models are already present on the laptop host, so switching needs no download.
6b. **Parked until the user is ready:** test the installed `OllamaVision` extension (`src/Extensions/OllamaVision`, third-party `Urabewe/OllamaVision`) as the image-to-prompt path in Swarm. Scoped 2026-09-18, no code written. It already supports the two-axis design used by the ComfyUI `llm-prompter` node with **zero code changes**: `systemPrompt` and `prompt` are separate request fields on every backend (Ollama sends a top-level `system` field plus `prompt` + `images`, `OllamaVisionAPI.cs:516-538`; OpenAI/OpenRouter/textgen send distinct `system`/`user` role messages, `:331-365`, `:406-444`, `:464-508`), and `loadPresetPrompt()` only writes `#responsePrompt`, never `#modelSystemPrompt`, so a scope preset cannot clobber a format system prompt. To test: paste one format preset into Model Settings -> System Prompt, save the scope text as a custom preset, analyze. The 7 format presets and 4 scope presets live in the ComfyUI fork at `custom_nodes/ComfyUI-llm-prompter` (`prompts/*.txt` and `INSTRUCTION_PRESETS` in `presets.py`).
   Findings that shape the test: (a) System Prompt is a **single global textarea** with no save/load/name UI, so switching target model means pasting by hand — the only thing a fork would buy, at ~300-400 lines of JS duplicating the existing preset CRUD. (b) Presets are **browser localStorage only** (`ollamaVision_customPresets`); the server-side `SaveUserPrompt` is a stub that persists nothing — export before investing. (c) **One image per request** everywhere (`:520` is a hardcoded single-element `images` array); Image Fusion is N separate vision calls merged by a later text-only call, so a style-transfer scope cannot work here. (d) `AnalyzeImageAsync` is a real HTTP API (`/API/AnalyzeImageAsync`, permission `use_ollamavision`) accepting `systemPrompt`, so a scripted format x scope matrix needs no UI work at all — likely the better first test than the UI. **Do not fork yet:** checkout is clean at `241d0ff`, exactly on `origin/main`, no local edits; 10,186 lines (7,764 JS) from an upstream whose commits read "update with new stuff and things".
7. Carried: `SwarmUI-VideoStages` still references removed `RunSeedVR2Stage` (root boot exits 1); physical-device PWA acceptance; startup/LoRA-metadata performance pass per `docs/WebUI-Performance-Review.md`.
8. Unconfirmed sandbox-only gate failures from the 2026-09-17 sync (see AGENTS.md Upstream Sync Log): `dotnet format --verify-no-changes` reports 122 pre-existing whitespace findings across 6 files, and `dotnet test` fails to build the NUnit suite with 53× `CS0121` ambiguous-overload errors (`TestDelegate` vs `Action`). Both reproduce on a clean checkout with no merge involved, so they're either a real latent issue or an SDK/Roslyn version mismatch with this sandbox's apt-installed `dotnet-sdk-8.0` (8.0.131) — needs confirming on the normal build box.

## Decisions
- Split the classic media menu (option A) over images-only-on-touch (B) or an extension override (C) — keeps video/audio reachable everywhere; accepts an upstream-file edit.
- Batch width measurement inside `AutoWidthBatchHelper` over skipping `triggerChangeFor` in `clearPresetView` — keeps every change listener running, only the layout reads merge.
- `/simple` FL2VA fields prefill only params the server advertises and never overwrite existing values; Init/End images stay out because the editor stores text.
- Prompt Enhance writer stays `huihui_ai/qwen3-vl-abliterated:8b-instruct`; the 27B wrote no better at ~12 vs ~80 tok/s.
- ~~Planned FL2VA config uses H3 Memory Optimization + FirstBlockCache defaults~~ — **superseded 2026-09-17**, see "Turbo H3 acceleration" below. On turbo checkpoints at 4-9 steps run turbo alone: FBC measures 0.8% at 4 steps, and H3 Memory Optimization is not numerically neutral. The Ref2VA cache audio breakage remains attributed to reference audio (operator call, unverified on FL2VA).
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

### Turbo H3 acceleration (2026-09-17) — supersedes the FBC/MemOpt plan above

On turbo-merged checkpoints (Eros Max, DaSiWa) at 4-9 steps, **run turbo alone.** The backend already has `--use-sage-attention` and `--disable-comfy-compiler` in ExtraArgs, so no config change is needed.

- **Step-skipping caches are dead at turbo step counts.** Measured A/B: 4-step run 68.23s → 68.83s with FBC (**0.8%, noise**); the same node gives 18.6% at 20 steps. TeaCache/EasyCache/FBC/Spectrum are all tuned for ~20 steps. They remain legitimate on the non-distilled 25-step path.
- **Avoid H3 Memory Optimization.** Measured 1.27x but **changed output at an identical seed** (mean pixel diff 2.27/255) and breaks on GGUF. Block swap is OOM-only, and 32GB fits the W4A8 checkpoint resident.
- **Sparse/window attention does not harm FL2VA** — the opposite of the earlier assumption. FL2VA held 0.8498-0.9144 SSIM under aggressive sparsity vs T2VA's 0.7584-0.7765 (LMSYS, 2026-08-27), via a "first frame sink". Moot at turbo anyway: the first ten denoising steps run dense regardless of config.
- **Sol INT8 QK/PV defaults are fine on this install.** The sm_120 Sage noise bug (pure noise above ~160k tokens) was the INT8 double-quantization concern and was fixed in ComfyUI 0.31.1; local is 0.36.0. Do not hand-disable them.
- "JuanAttn" (`juanattnbeta` param group) returns zero web results — no identifiable upstream, so do not assume its window semantics match published benchmarks.
- **Remaining bottleneck is VAE decode**, a fixed ~43.5s — over half of a ~79s run, untouched by any sampler setting. PyTorch is already 2.9.0+cu130.

### Eros Max author guidance (2026-09-17, from pasted beta5/4/3 release notes)

- **Prefer ref2va or t2va prompt format over i2v, even with a single image input** — treat that image as a reference, not frame 1. The author's failure case is conditional: *"if you run an underdeveloped or manually written prompt you will get odd outputs, random camera changes, and blue lighting color shifts when you use the i2v prompt style"* — thin prompt **plus** i2v style. Reported to be lenient in practice on simple single-reference work, strict on multi-reference or complex motion; prompt depth matters more than format compliance. Prompt-format issue, not a missing checkpoint. Random camera changes or blue shift is the known signature — check the prompt before blaming a sampler or checkpoint.
- Use `TURBO-hybrid_int8` by default (local: `10Eros_Max_h3_TURBO-hybrid_beta5_w4a8_14gb_optimized`). TURBO files bake in turbo-delta fusion, saving 4.2GB vs loading both ref and fl turbos.
- **Non-turbo full-step audio is always better than turbo audio**; the author calls H3's integrated audio "terrible". Use the non-turbo checkpoint for dialogue.
- Concept LoRAs (mystic_v4, anatomy enhancer) stack readily on beta5 at **0.2-0.6 strength** — lower than usual.
- Sampler table (beta5, confirmed verbatim): `er_sde`/`beta57` 4-6 (best style preservation, least drift) · `res_multistep`/`simple` 6-9 (good motion; beta at 8-9 is sharpest for fast motion but plastic/burned) · `LCM`/`simple` 6-8 (best turbo audio) · `euler`/`simple` 4-8. CFG 1 throughout.

### H3 presets created (2026-09-17) — in `Users.ldb`, not the repo

12 presets via the AddNewPreset API, all carrying **no prompt** (operator supplies it), all pinned `exactbackendid=0`, all labeled `[HYBRID - REF2VA or FL2VA]` with the ref2va warning in the description. The 8 Eros presets pin the TURBO-hybrid beta5 W4A8 checkpoint.

- `AB/s8 {er_sde-beta57, res_multistep-simple, lcm-simple, euler-simple}` — step-matched at 8 for a clean sampler shootout; only sampler/scheduler varies. Note er_sde at 8 is **above** its 4-6 author band; recheck a weak result at 6 before blaming the sampler.
- `minimax/Eros {er_sde-beta57 6, res_multistep 9, lcm 8, euler 8}` — author-band steps.
- `minimax/DaSiWa Turbo {4, 8}` — shift 12, model unset (any DaSiWa turbo build).
- `minimax/DaSiWa NonDistill {res_multistep, euler} 25` — pins `dasiwaHybridV2_int8`, shift 12. **CFG 3.5 is a guess, not author-published** — the author gives no CFG for non-distilled rows. Tune it.

Preset sets, all prompt-free and backend-0 pinned (operator sets prompt, init image, and a FIXED seed):

- `AB/s8 *` (4) — sampler shootout, checkpoint pinned to TURBO-hybrid beta5. Single axis, 4 cells.
- `GRID/samp *` (4) — same samplers, **no checkpoint pinned**, for a 2-axis grid against a Video Model axis.
- `LEN/{10s 240f, 15s 360f, 20s 480f}` (3) — clip-length scaling, **sampler unset** (set the shootout winner outside the grid), checkpoint pinned. Run after the shootout.

Checkpoint axis was pruned by hashing: `h3ErosMax_beta5` is **byte-identical** to `10Eros_Max_h3_TURBO-hybrid_beta5_w4a8` (same SHA over the first 20MB, both 13350MB) — testing both wastes a row. Also excluded: the non-turbo `hybrid` (needs 20-25 steps), and the 20GB variants of both families (different quant, not comparable at matched settings). That leaves 2 genuinely distinct turbo checkpoints: TURBO-hybrid beta5 and `dasiwaHybridTurboV2_3203313`.

Caveat on the 2-axis grid: DaSiWa wants shift 12 and the GRID presets leave shift unset (default 3), so DaSiWa runs off-spec. Sampler comparison *within* each model row is still clean; cross-model is not. Eros beta5 publishes no shift value, so no single setting serves both.

Length caveat: 480f (20s) **exceeds** the 294-frame limit measured on Ref2VA and the <=362 noted max — may fail or degrade. 360f (15s) is inside it, and is the first length where JuanAttn is worth measuring (set Window Seconds below 15 or it silently no-ops).

Grid Gen presets axis for the shootout (fixed seed + init image set outside the grid):
`AB/s8 er_sde-beta57 || AB/s8 res_multistep-simple || AB/s8 lcm-simple || AB/s8 euler-simple`

Grid Gen precedence trap: `GridGeneratorExtension.cs:198` applies presets **after** cloning base params, so a preset with a stored prompt **overwrites** the grid-level prompt — avoided here by leaving prompt unset on all 12. Preset names match lowercased; a miss aborts the whole grid.

API trap: `AddNewPreset` takes `param_map` at the **top level**, not nested under `raw` as the docstring implies — any `JObject` parameter binds to the whole request body (`APICallReflectBuilder.cs:46`). The documented shape throws an unguarded NRE at `BasicAPIFeatures.cs:552`, surfacing as a bare HTTP 400.

**Parked:** `smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models` (HF) — weight-selection merge of MiniMax's official fl2va+ref2va, no training, int8 only, **no turbo variant**, no published sampling settings. Not an upgrade; useful only as a neutral official-weights baseline if Eros Max output looks stylistically skewed by its merged LoRAs. Try `b25-49` first. Deferred by the user 2026-09-17.

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
