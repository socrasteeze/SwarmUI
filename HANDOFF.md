# HANDOFF

**Updated:** 2026-09-12 · **Branch:** main · **Base:** 94e13d75 (= origin/main after this push) · **Tree:** clean

## State
Design landed on main; Prompt Enhance Phase 1 build is starting. Builders are Sonnet subagents; this session
orchestrates and gates. Nothing under `src/BuiltinExtensions/PromptEnhance/` exists yet.

## Done this session
- Verified the repo was not mid-merge from the earlier sync session — that merge had landed elsewhere and this checkout only fast-forwarded
- Reviewed `docs/PromptEnhance-Design.md` and the ComfyUI fork's `fork_tools/prompt_guides/` pack end to end; every code reference in the design checks out against the tree
- Fast-forwarded the docs-only design branch onto main and deleted it on origin
- Verified the writer host live: Ollama bound on all interfaces, four writer models pulled, LM Studio not running, no Open WebUI. Phase 1 needs Ollama only
- Re-ran the pack grader read-only: gemma-4-26B v3 66/68, qwen3-vl-8B v2 57/68; the 8B fails every `9 runtime/lora` case (`NO-NOTES`)
- Folded the Karpathy behavioral guidelines into `AGENTS.md` Code conventions

## Open
Ordered. Everything else is on the tracker.

1. **Build Prompt Enhance Phase 1** per `docs/PromptEnhance-Design.md` — new `src/BuiltinExtensions/PromptEnhance/`, zero core-file edits, Interrogate is the skeleton. Ship default writer `huihui_ai/qwen3-vl-abliterated:8b-instruct`; the 26B is 18 GB on disk and spills on the writer host's 16 GB card. Add a pre-send syntax shield for `<lora:…>` / `__wildcard__` / `embedding:` markers — that is the 8B's graded failure and this fork's real workload
2. **Grade the 12B gemma and time cold vs resident** with the existing harness (`PROMPT_GUIDES_OLLAMA=http://<writer-host>:11434 python <comfy>/fork_tools/prompt_guides/harness/dryrun.py <model> <profiles-noninteractive> <out>.json`, then `grade.py`). Only the shipped default depends on it
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
- Builders are Sonnet subagents; this session reviews diffs and runs gates, writes no implementation code
- Kept every upstream commit byte-identical; no PRs from this fork on any remote, ever

## Traps
- **Never register an LLM backend that leaves `CanLoadModels` at its `true` default** on any machine the hub treats as a Swarm-API backend — it becomes a nonreal image backend and is offered image jobs (`SwarmSwarmBackend.cs:1002` has the `TODO`)
- Anything `position: fixed` under `.alt_prompt_region` must be rooted at `document.body` — the mobile keyboard lift puts a `transform` on that region (`prompttools.js:416`). The Enhance preview panel included
- Release builds cache extension assets in memory — restart the server to see JS/CSS edits
- **Never write `.fds` with PowerShell `Set-Content -Encoding UTF8`** — BOM+CRLF kills SwarmUI before it opens its log and the launcher hangs at `pause`. Use `UTF8Encoding($false)`, keep LF
- **Hub and spoke must run the identical commit** (`SwarmSwarmBackend.cs:287`). Deploy the spoke by hand: stop, pull, `dotnet build src/SwarmUI.csproj -c Release -o src/bin/live_release`, write HEAD to `src/bin/last_build`, restart
- The `--ci_test` gate exits 1 on this machine for the untracked `SwarmUI-VideoStages` extension — read the log, not the exit code. Tracker keys (`SWR.n`) never go in commit messages

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
