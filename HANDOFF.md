# HANDOFF

**Updated:** 2026-09-12 · **Branch:** `prompt-enhance-phase1` · **Base:** f5bb8c8b (= origin/main) · **Tree:** clean

## State
Prompt Enhance Phase 1 is built, gated, deployed to the live hub (`last_build` = branch HEAD) and live-checked against the writer host: disabled-with-reason on no model and on an unmapped class, streamed rewrite with the `<lora:…>` tag shielded and re-appended, cache hit on repeat, `CONFLICT:` hard stop, Apply → provenance present in the generated PNG's metadata, provenance cleared on edit. Ready to merge.

## Done this session
- Landed the design branch on main, then built `src/BuiltinExtensions/PromptEnhance/` (six C# files, JS/CSS, five verbatim non-interactive profiles + `VERSION`, node harness) and `SwarmUITests/PromptEnhanceTests.cs` — one Sonnet builder per file group, one wiring agent
- One review pass, triaged in the main session to 26 concrete fixes, applied by one Sonnet fixer (streaming loop, caps, cache-before-health, NOTES split, provenance `IntentionalUnused`, compat-class `anima`, klein class IDs, endpoint normalisation, disabled-button tooltip, provenance clearing, desktop layout) and re-gated here
- Measured the 8B writer on the writer host with the ComfyUI harness: 58/68, cold 7.8 s, resident 0.23 s at ~103 tok/s — numbers in the extension README
- Wrote the extension README, one AGENTS.md Fork Delta entry, and the AGENTS.md token-economy rule the fork owner asked for

## Open
Ordered. Everything else is on the tracker.

1. **Merge `prompt-enhance-phase1` into main via `/clean` and push** — fork owner only. `Data/PromptEnhance/endpoints.json` on the hub already points at the writer host (gitignored)
2. **Phase 2 first item:** Illustrious derivatives stored under `ill/` (e.g. `ill/Auralis_v3`, class `stable-diffusion-xl-v0_9-base`) resolve to no profile — the filename override matches only `illustrious|noob`. Add a folder/`ModelClass` aware override map (`docs/PromptEnhance-Design.md` Phase 2) before the manual override UI
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
