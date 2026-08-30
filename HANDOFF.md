# HANDOFF

**Updated:** 2026-08-30 · **Branch:** main · **Base:** 03719fe5 (= origin/main) · **Tree:** dirty (two new .bat files)

## State
Two new builtin extensions are committed but **unpushed and never exercised against a live ComfyUI backend** —
all gates pass, no interrogation or sheet has actually been generated. Everything below turns on that testing.

## Done this session
- Interrogate extension (WD14 tags + Florence-2 caption) — `src/BuiltinExtensions/Interrogate/`
- Character Sheet extension (multi-view sheets, C# compositing) — `src/BuiltinExtensions/CharacterSheet/`
- `stop.bat` / `restart.bat` — uncommitted; restart stops, pulls, then delegates rebuild to `launch-windows.bat`
- Feature index entries — `docs/Features/README.md`

## Open
1. **Interrogate one image end to end.** Highest risk: the WD14 and Florence-2 node inputs were written from
   reading those repos' `nodes.py`, not from a live `object_info`. A wrong field name fails Comfy validation
   before the job runs, and the server log names it. Node IDs/inputs: `InterrogateBackends.cs`
2. **Confirm the Florence-2 caption index.** Caption is wired from `Florence2Run` output 2
   (`image, mask, caption, data`). Empty or garbage output means that index is wrong.
3. **Run the H3 baseline** that was planned but never run: ref2va, two reference images, Frames `2`, front/side/back
   prompt, with and without `minimax_h3_turbo_4step_ckpt500_pruned_comfyui`. The installed 4-step turbos are mostly
   `fl2v` variants and the sheet uses `ref2v`, so that LoRA's compatibility is unverified.
4. **Build one sheet**: face + outfit reference, three views. Check panels stream in, one composite lands in
   history with reusable metadata, captions legible.
5. **Tune the sheet prompt wording** — `SheetPlan.cs`. Pure guesswork until real output exists; the only file that
   needs changing for this, and it is structurally isolated.
6. **Commit `stop.bat` / `restart.bat`.** `stop.bat` is tested; `restart.bat`'s pull-and-launch path is not —
   it was never run, because running it starts a server.
7. **Not built:** the planned "Analyze pose image" button wiring Character Sheet to Interrogate.

## Decisions
- Native orchestration over importing the 2BZ ComfyUI workflow — H3's reference model, 9-image prompt channel and
  still-frame handling are already native, so its `toobusy`/`rgthree` node packs would rebuild what exists.
- `AwaitJobLive` over `RunArbitraryWorkflowOnFirstBackend` — the helper builds its own `T2IParamInput`, so the
  caller can never read the `ExtraMeta` the returned text lands in.
- ComfyUI node packs over a new in-process runtime for interrogation — no new NuGet dependency, uses the GPU.
- Model-agnostic sheet engine over H3-only — the tool stays usable without a 33B install.
- ImageSharp compositing in C# over a Comfy graph — already a dependency; a failed panel does not cost the sheet.
- Model lists read from live `object_info`, not hardcoded — a name absent from the enum fails Comfy validation.
- Feature index points at each extension's README rather than duplicating into `docs/Features/` — one source.

## Traps
- **Release builds cache extension JS/CSS in memory permanently.** Edits to `charsheet.js` / `interrogate.js` do
  nothing until the server restarts, and the browser needs a hard refresh after that.
- **SwarmUI's ComfyUI backends survive killing SwarmUI.** They are launched via an intermediate shell that exits,
  so `taskkill /T` finds nothing to walk. Orphans keep ports 5809+ bound and the next launch fails to bind them.
  `stop.bat` kills SwarmUI first, then the backends — that order matters, or `AutoRestart` respawns them.
- **Do not run the .bat files from Git Bash / MSYS.** GNU `find` and `timeout` shadow the Windows ones; `stop.bat`
  calls system utilities by absolute path for this reason, but the stock launchers do not.
- **`.fds` config escapes a literal backslash as `\s`.** A path there is not malformed; decode before reporting it.
- Qwen Image Edit Plus is hard-capped at 3 reference images by its text encoder, not by choice — `SheetEngines.cs`.
- Push requires the `/clean` skill per fork law; `origin/main` is the only push target.

## Verify
```powershell
dotnet build src/SwarmUI.csproj --configuration Release --no-incremental
dotnet format SwarmUI.sln --verify-no-changes
node --check src/BuiltinExtensions/Interrogate/Assets/interrogate.js
node --check src/BuiltinExtensions/CharacterSheet/Assets/charsheet.js
# Isolated boot check: expect "is now running", both extensions prepped, zero errors.
dotnet src/bin/Release/net8.0/SwarmUI.dll --ci_test true --launch_mode none --loglevel debug --data_dir <throwaway> --port 7899
```
