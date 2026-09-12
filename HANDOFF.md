# HANDOFF

**Updated:** 2026-09-12 · **Branch:** `claude/prompt-enhancer-local-llm-39bs9z` · **Base:** 64ba46f (= origin/main) · **Tree:** clean

## State
Design session only, no code. `docs/PromptEnhance-Design.md` is new and is the whole deliverable: an
architecture-aware local-LLM prompt enhancer, writer model on a second machine, hub does all generation.
Read that file first — it carries the topology decision, the rejected alternatives with their evidence, and the
phase plan. Build starts at its Phase 1.

Carried from the prior session (2026-09-10): hub and spoke both up, spoke backend healthy, reading `running`
with 14 features after the F: model root was mirrored onto it.

## Done this session
- Surveyed the prompt-enhancer problem across both forks and wrote `docs/PromptEnhance-Design.md`
- Established that the ComfyUI fork already holds the substantive work in `fork_tools/prompt_guides/`: five
  per-architecture writer profiles, non-interactive variants with a `CONFLICT:`/`NEEDS INPUT:` caller contract,
  an Ollama/OpenAI-compatible dry-run harness, and graded results for a Qwen 8B and a Gemma 26B-A4B writer.
  SwarmUI's job is selection and transport only
- Established that SwarmUI's own LLM subsystem is named but not wired: `src/LLMs/LLMParamInput.cs` is a
  self-labeled placeholder, `SimpleRemoteLLMBackend.GenerateLive` throws, both `LLMAPI` routes throw, while
  the permission and both backend type registrations already exist
- Rejected routing LLM work over the spoke protocol, with the evidence recorded in the design doc

## Done in the prior session (2026-09-10)
- Fixed the spoke backend flap (SWR.89): the hub serves 180 models from a second root `F:\Models` the spoke could not see, so `ValidateModelInventoryCoverage` failed every retry. Spoke now mounts the hub's `foxtrot` share as `F:` and runs `ModelRoot: E:\smodels;F:\sModels`, identical to the hub
- Deployed `8555aded` to the spoke (SWR.85): build, `last_build`, restart — ruled out version mismatch as the cause
- Renamed the three comma-named `anima/` LoRAs plus their `.metadata.json` sidecars (`soul calibur 3, X` → `soul calibur 3 X`); they live on `D:\anima\lora` behind a junction
- Caused and then diagnosed three spoke outages from a BOM'd `Settings.fds` — see Traps; recorded as memory `fds-write-no-bom`

## Open
Ordered. Everything else is on the tracker.

1. **Build Prompt Enhance Phase 1** — `docs/PromptEnhance-Design.md`. New extension at
   `src/BuiltinExtensions/PromptEnhance/`, zero core-file edits, Interrogate is the skeleton to copy. Before
   writing any C#, run the existing ComfyUI harness against the real writer host to settle resident-vs-cold
   latency and whether the 26B writer beats the 8B by enough to ship as default; it needs no changes to do that.
2. **SWR.86 — open the Interrogate modal once.** Server is up now; still never done. WD14 only in the Method dropdown, tagger options render, a WD14 round trip returns tags. Also exercise Character Sheet's "Analyze pose" (same helper).
3. **SWR.59 — set `qwenEdit2511FP8_v10.safetensors` to `qwen-image-edit`** in the Models tab. Two minutes.
4. **Route one generation to the spoke** — now actually testable. Pick `G18-API` from the `/simple` Generate caret and confirm it completes; this is the unexercised half of the spoke profile.
5. **SWR.27 — device pass.** Chokepoint for SWR.1, SWR.2 and the acceptance of SWR.80–83.
6. Delete the leftovers on the spoke's `S:\SwarmUI`: `Data\Settings.fds.bak`, `.bak2`, `launch-spoke.bat.bak`. The live files are correct.
7. Cosmetic: the spoke logs a thumbnail-decode error for `F:\Models\diffusion_models\krea\krea2_raw_bf16.preview.jpeg`. Undecodable preview image; the model indexes fine. Same on the hub.
8. AnimaDex — after the cache drain, restart the container, verify favourites search returns total 3, commit the staged change in that checkout.

## Decisions
- **Prompt Enhance runs the writer model on a second machine, reached by plain HTTP, not through the spoke
  protocol.** The hub does all computation and all generation; the writer host does no image work and does not
  need SwarmUI running. This keeps hub VRAM 100% image, gives the writer a whole GPU (so the larger graded
  writer becomes usable), and avoids `VaryID` lockstep deploys entirely
- **Prompt Enhance ships as a fork-owned extension with zero core-file edits**, on the Interrogate pattern,
  rather than implementing upstream's `SimpleRemoteLLMBackend`/`LLMAPI` stubs. Those are upstream core files in
  a high-merge-risk area and upstream will land its own implementation
- **Profiles ship as versioned copies inside the SwarmUI extension**, not as a path reference into the ComfyUI
  checkout. The ComfyUI tree stays the authoring, validation and grading home; the recorded pack version is what
  makes a stale copy detectable
- Mirrored F: onto the spoke (mount + second `ModelRoot`) over removing `F:\Models` from the hub or relocating 180 models — keeps every model routable and leaves the hub's storage untouched
- The mount had to be made in the spoke's interactive desktop session, not over SSH — the spoke task is Interactive-only and inherits that session's drives; an SSH logon has no hub credential
- Did not weaken `ValidateModelInventoryCoverage` — it correctly refuses to route a model the spoke cannot load
- Dropped Florence-2 rather than verifying it; kept the `prose` output kind and `InterrogateBackends.Register` as a documented extension point
- Closed SWR.12 (tailnet auth) as a recorded decision; reopen on a guest device, exposure past the tailnet, or an unattended batch run
- Kept every upstream commit byte-identical; no rebase, no reset-author
- No pull requests from this fork on any remote, ever

## Traps
- **Never register an LLM backend that leaves `CanLoadModels` at its `true` default on a machine the hub treats
  as a Swarm-API backend.** `SwarmSwarmBackend.cs:989` filters remote backends only by
  `HasRoutableModelCapacity(canLoadModels, maxUsages)`, and `AbstractBackend.cs:108` defaults that flag true, so
  a text-only backend is mirrored onto the hub as a nonreal *image* backend, counted in `runningBackends`, and
  offered image jobs. The gap is acknowledged in tree: `// TODO: support remote non-T2I Backends`
  (`SwarmSwarmBackend.cs:1002`). This is the main reason Prompt Enhance does not use the spoke channel
- **Never write `.fds` with PowerShell `Set-Content -Encoding UTF8`.** It adds a UTF-8 BOM and CRLF. SwarmUI dies in `LoadSettingsFile` (`Program.cs:148`) *before* `StartLogSaving` (`:216`), so it exits with **no log**, and `launch-windows.bat:109` hangs at `pause`, holding the task instance so the scheduler refuses new starts (`Last Result -2147020576`). Write with `UTF8Encoding($false)`, keep LF, and verify the first bytes are not `EF BB BF`. Cost three outages and two wrong diagnoses today.
- **`schtasks /end` does not kill `SwarmUI.exe`** and an orphaned `launch-spoke.bat` wrapper stuck at `pause` blocks every later `/run`. Restart the spoke with `stop.bat` (kills SwarmUI then its ComfyUI by `dlbackend` path), kill any `cmd.exe` running `launch-*`, then `/run`. Not from Git Bash.
- **Hub and spoke must run the identical commit.** `SwarmSwarmBackend.cs:287` refuses a negotiated spoke on any other `VaryID` and parks it in `loading` forever. Deploy the spoke by hand: stop, pull, `dotnet build src/SwarmUI.csproj -c Release -o src/bin/live_release`, write HEAD to `src/bin/last_build`, restart. The launcher's own rebuild fails silently from the task session.
- A spoke stuck in `loading`/`idle` with 0 features and no hub error is usually **coverage**, logged only at Verbose (`SwarmSwarmBackend.cs:1126`). Each retry forces a full spoke model rescan (`RequestRemoteModelRefresh` with `strong+force`) — the repeating LoRA warnings are the tell. Check the two machines' `ModelRoot` lines first.
- The spoke model cache fills AFTER a job, in the background. Never move it back into the request path.
- Tracker keys (`SWR.n`) are local to this machine and never go in a commit message. `linkedCommitSha` is the only durable join; config-only fixes (SWR.89) legitimately have none. Next catch-up window starts at `6c2c5d0b`; drop upstream and sync-log commits first.
- The `--ci_test` boot gate exits 1 on this machine for the untracked local extension `src/Extensions/SwarmUI-VideoStages`. Read the log, do not trust the exit code.
- `git diff HEAD..upstream/master` is misleading — always diff from the merge base.

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
