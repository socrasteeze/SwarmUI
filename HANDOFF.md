# HANDOFF

**Updated:** 2026-09-12 · **Branch:** `prompt-enhance-phase1` · **Base:** f5bb8c8b (= origin/main) · **Tree:** clean

## State
Prompt Enhance Phases 1 and 2 are built, gated and live-verified on the hub (`last_build` = branch HEAD). Six writer profiles, pack 1.2.0+0d2a1cd9. Gates: Release build 0 warnings, 120 tests, both format checks clean, node harness 66/66, zero core-file edits.
Nothing is pushed. The ComfyUI pack work sits on its own local branch `prompt-guides-1.2.0` in that checkout.

## Done this session
- Built the extension end to end: profile registry, writer transport (Ollama NDJSON + OpenAI SSE), syntax shield, endpoint registry with health probe, cache, websocket API, genpage UI, provenance param, 120 NUnit tests and a 66-check node harness
- Phase 2: tri-state mode control (off/review/auto), auto-enhance intercepting the single generate funnel in capture phase, config-driven folder override map, manual profile picker, stale-status-reply sequence guard
- Authored and graded a sixth profile (Krea 2) in the ComfyUI pack; 11 Krea checkpoints now resolve. `^ill/` folder rule recovered ~100 Illustrious derivatives whose filenames carry no family name
- Settled the writer model: 8B and 12B both score 68/79, but the 12B emits invalid JSON in /json mode on 5 of 6 profiles and contradicts itself between identical calls. 8B ships
- Live-verified against the writer host: streamed rewrite, LoRA tag shielded and restored, cache hit, CONFLICT blocking generation in auto mode, provenance in the generated PNG, provenance cleared on edit

## Open
Ordered. Everything else is on the tracker.

1. **Merge and push** — `prompt-enhance-phase1` in this repo and `prompt-guides-1.2.0` in the ComfyUI checkout, both via `/clean`. Fork owner only
2. **MiniMax H3 profile** — deferred by decision. Its 5 checkpoints resolve to no profile and show the disabled reason; the manual picker can force one. Video prompt doctrine is much thinner than the image profiles, so this needs real generations to validate, not desk research
3. **SWR.86 — open the Interrogate modal once.** WD14 only in the Method dropdown, tagger options render, a WD14 round trip returns tags. Also exercise Character Sheet's "Analyze pose"
4. **SWR.59 — set `qwenEdit2511FP8_v10.safetensors` to `qwen-image-edit`** in the Models tab
5. **Route one generation to the spoke** — pick `G18-API` from the `/simple` Generate caret and confirm it completes
6. **SWR.27 — device pass.** Chokepoint for SWR.1, SWR.2 and the acceptance of SWR.80–83
7. Spoke leftovers (`Data\Settings.fds.bak`, `.bak2`, `launch-spoke.bat.bak`), the krea2 preview-decode warning, and the AnimaDex container restart — all still open, all cosmetic or two-minute

## Decisions
- Writer runs on a second machine over plain HTTP, not the spoke protocol — a spoke LLM backend is mirrored as a phantom image backend (`SwarmSwarmBackend.cs:989`, `AbstractBackend.cs:108`), and spoke code means `VaryID` lockstep deploys
- Fork-owned extension over implementing upstream's `SimpleRemoteLLMBackend`/`LLMAPI` stubs — high-merge-risk core files that upstream will fill itself
- Profiles ship as versioned copies (`Assets/profiles/` + `VERSION`) over a path into the ComfyUI checkout — no cross-repo build dependency; the recorded version makes a stale copy detectable
- Only the non-interactive profile set ships — the interactive set asks questions that would reach the text encoder
- Explicit Enhance button with a preview and Apply, not auto-enhance on generate — user reviews first, no generation-path risk, reproducible
- Provenance rides one hidden registered T2I param — lands in image metadata with no core edit; presets never capture it
- Builders are Sonnet agents, one per job, no review fan-outs or adversarial panels — the fork owner's rule, now codified in AGENTS.md Code conventions; this session plans, reviews diffs, and runs gates, writing no implementation code itself
- Kept every upstream commit byte-identical; no PRs from this fork on any remote, ever

## Traps
- **Never register an LLM backend that leaves `CanLoadModels` at its `true` default** on any machine the hub treats as a Swarm-API backend — it becomes a nonreal image backend and is offered image jobs (`SwarmSwarmBackend.cs:1002` has the `TODO`)
- Anything `position: fixed` under `.alt_prompt_region` must be rooted at `document.body` — the mobile keyboard lift puts a `transform` on that region (`prompttools.js:416`). The Enhance preview panel included
- Release builds cache extension assets in memory — restart the server to see JS/CSS edits
- **Never write `.fds` with PowerShell `Set-Content -Encoding UTF8`** — BOM+CRLF kills SwarmUI before it opens its log and the launcher hangs at `pause`. Use `UTF8Encoding($false)`, keep LF
- **Hub and spoke must run the identical commit** (`SwarmSwarmBackend.cs:287`). Deploy the spoke by hand: stop, pull, `dotnet build src/SwarmUI.csproj -c Release -o src/bin/live_release`, write HEAD to `src/bin/last_build`, restart
- **Cache is checked before endpoint health on purpose** (`PromptEnhanceAPI.EnhancePrompt_Internal`) — the endpoint used for the cache key is the first healthy one, or else simply the first enabled entry; that ordering is what lets a repeat prompt hit the cache while the writer host is asleep. Do not "fix" it into a health-first order

## Verify
```powershell
dotnet build SwarmUI.sln --configuration Release
dotnet test SwarmUITests/SwarmUITests.csproj --configuration Release
dotnet format SwarmUI.sln --verify-no-changes
dotnet format style --verify-no-changes
dotnet build Desktop/Desktop.csproj --configuration Release
# Exits 1 on this machine for an unrelated untracked extension - read the log, do not trust the exit code.
dotnet src/bin/Release/net8.0/SwarmUI.dll --ci_test true --launch_mode none --loglevel debug --data_dir "$env:TEMP\swarm-ci\data" --port 7899
# Live server, read-only. Port comes from Data/Settings.fds, never assume 7801.
node tools/swarm_api.mjs GetCurrentStatus
node tools/swarm_api.mjs ListBackends
```
