# HANDOFF

**Updated:** 2026-09-06 · **Branch:** main · **Base:** b72f14ee · **Tree:** this sweep's work, committed on top

## State
A six-group agent sweep implemented the open fork backlog that needed no operator decision. Every group was written by one
agent and then verified by a second reading the diff rather than the report; the verifiers found and fixed 19 defects the
implementers had missed, several of them behaviour-breaking. Details per group are in `AGENTS.md`'s Fork Delta under the
2026-09-06 heading. Nothing is pushed.

## Done this session
- `/simple` Prompt Coach shipped — `Assets/m/m_coach.js`, phases 1-4 plus a basic phase 5 of `docs/SimplePromptCoach-Plan.md`
- Mobile viewer §2b/§2c — rubber-band at the ends, edge-fling while zoomed, tap-toggled chrome overlay
- Output paths — `MaxOutPathDepth` is now enforced, and a `v1.0` prefix no longer saves as `v10`
- TagDex — an `anima_styles` thumbnail push is now actually served instead of silently discarded
- Genpage — LoRA dropdown opens in ~50ms instead of ~10.6s; boot payload 749KB → 292KB on the wire
- `/simple` — single-select presets, signature-gated re-renders (the iOS page-jump), checkpoint-compat LoRA filtering

## Open
1. Every device- and GPU-dependent item is untouched and still owed — the physical phone passes, the four by-eye generation checks, and the live-server actions. They are on the tracker, unchanged. **Nothing further here can be done without you**; the automatable backlog is empty.
2. Nothing in this sweep has been seen in a browser against the live server. The harnesses stub core or drive a throwaway instance, so a restart-and-look pass is the first thing worth doing.
3. The gitignored `src/Extensions/SwarmUI-VideoStages` still fails to build on `RunSeedVR2Stage`. Update it from its own upstream; never patch it here.
4. Two tracker items are closer to done than they look: `qwenEdit2511FP8_v10`'s architecture is a one-field edit in the Models tab with no code behind it, and the TagDex/AnimaDex favorites idea is complete except for phone acceptance, which the device checklist already owns.

## Decisions
- Verifiers were told to fix what they found rather than report it back, and to mark a task landed only on their own evidence. That is what caught the LoRA-browser click doing nothing, and a depth clamp that a backslash walked straight past.
- `Utilities.StrictFilenameClean` was left alone; the dot bug was one call site in `BuildImageOutputPath`, and the shared helper has ten-plus other callers with pinned tests.
- Genpage perf landed as core edits rather than in a fork extension: select2 init wiring and the boot `ListT2IParams` call site have no hook. Kept minimal and recorded.
- The `compact: true` flag already existed server-side, so the payload cut needed no C# change.
- A `tagdex_sync.py` named in one ticket does not exist in this repo, its history, or its tree. That half of the report points somewhere else.

## Traps
- **A lazy multiselect carries no `<option>` list.** Any code that assigns a value it did not first append selects nothing, silently. That single mistake produced four separate defects this session. Ask the question on every edit near one.
- The viewer's boundary logic mirrors core's `shiftToNextImagePreview`, including the `only_arrows` value of `ui.imageshiftingcycles`. An upstream merge touching `currentimagehandler.js` or `outputhistory.js` can desync it; re-run `verify-mobile-viewer.mjs`.
- Release caches extension assets in memory and `VaryID` only moves on commit — commit, restart, hard refresh before judging an asset edit failed.
- An empty `src/bin/live_release` breaks every `src/Extensions` build. Never build into `src/bin/live_release` while the server holds it.
- The `--ci_test` boot exits 1 on the VideoStages extension error alone; read the log rather than the exit code.

## Verify
```powershell
dotnet build SwarmUI.sln --configuration Release
dotnet test SwarmUITests/SwarmUITests.csproj --configuration Release   # 72 passing
dotnet format SwarmUI.sln --verify-no-changes
dotnet src/bin/Release/net8.0/SwarmUI.dll --ci_test true --launch_mode none --loglevel debug --data_dir "$env:TEMP\swarm-ci\data" --port 7899
# Playwright harnesses are opt-in and boot no server; 440 checks across thirteen suites.
node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-coach.mjs
# verify-genpage-clipboard.mjs needs a throwaway server with IsInstalled:true in its Settings.fds.
```
