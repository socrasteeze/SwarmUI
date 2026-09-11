# HANDOFF

**Updated:** 2026-09-11 · **Branch:** main · **Base:** 06edad53 (= origin/main) · **Tree:** clean

## State
Florence-2 removed from the Interrogate extension and pushed; build, tests and format green, but the change has
never been seen in a browser because no server is running. The spoke's checkout is current, its build is not.

## Done this session
- Dropped the Florence-2 captioner — `src/BuiltinExtensions/Interrogate/`, 141 deletions
- Fast-forwarded the spoke's checkout `6c0b1438..06edad53`; its `src/bin/last_build` still reads `6c0b1438`
- Reconciled the tracker against commits: filed and closed SWR.77–84, cancelled SWR.58, closed SWR.42 and SWR.12
- Split this file's backlog onto the tracker as SWR.85–88 so Open stays actionable

## Open
Ordered. Everything not listed here is on the tracker — read it rather than re-deriving from the repo.

1. **SWR.85 — deploy the pulled build to the spoke.** Checkout is at `06edad53`, `last_build` at `6c0b1438`. Until these match, the hub backend parks in `loading` (see Traps).
2. **SWR.86 — open the Interrogate modal once.** Method dropdown should list WD14 only, tagger options still render, WD14 round trip still returns tags. Verified statically only.
3. **SWR.59 — set `qwenEdit2511FP8_v10.safetensors` to `qwen-image-edit`** in the Models tab. No code change; cheapest item on the board.
4. **SWR.27 — run the device pass.** Chokepoint: closes itself plus SWR.1 and SWR.2, and is the only acceptance path for SWR.80–83.
5. **Restart SwarmUI and confirm** — Analyze pose completes a WD14 round trip, batch toggles survive a browser close, `/simple` Characters sort and layout work on real data.
6. **AnimaDex** — after the cache drain, restart the container, verify read-only that favourites search returns total 3 and the sidebar shows the star toggle, then commit the staged change in that checkout.
7. **Spoke: a generation routed to the second backend in list order is still unexercised.** The profile itself is live; controller authorization lives in untracked config on both sides, so it is in no delivery.

## Decisions
- Dropped Florence-2 rather than verifying it — this fork's checkpoints are danbooru-tag-trained, so WD14's tags are the native prompt language and prose had no consumer worth a multi-GB download
- Kept the `prose` output kind and `InterrogateBackends.Register` — a documented extension point, so a captioner can be added back without touching the extension
- Cancelled SWR.58 rather than closing it done — the caption index was never verified and now cannot be
- Closed SWR.12 (tailnet auth) as a recorded decision: `RequiredAuthorization` 401s the web UI everywhere but the host and breaks the mobile PWA. Reopen on a guest device, exposure past the tailnet, or an unattended batch run
- Did not port the round-trip prompt check into `/simple` — it reduces metadata on purpose, and the port would duplicate `promptCidMatcher` into the mobile bundle
- Dropped `diffusion_models` from this machine's `SDModelFolder` to match the hub — costs the local ComfyUI 8 unet files; reverse only if something here needs them directly
- Kept every upstream commit byte-identical; no rebase, no reset-author, per the fork's merge rules
- No pull requests from this fork on any remote, ever — upstream is fetch-only and its push URL is disabled

## Traps
- **Tracker keys (`SWR.n`) are local to this machine and must never appear in a commit message.** `linkedCommitSha` is the only durable join between a commit and an item. The next catch-up's window starts at `6c2c5d0b`; drop upstream (mcmonkey-authored) and sync-log commits before grouping, or a routine sync reads as 40 commits of untracked work.
- **Hub and spoke must run the identical commit.** `src/Backends/SwarmSwarmBackend.cs:287` compares the remote against `Utilities.VaryID` and refuses a negotiated spoke on any other build — it sits in `loading` forever rather than erroring. Recovery on a mismatched build: disable/enable the backend.
- **Never let the launcher deploy the spoke.** From the scheduled-task session its `dotnet build` fails silently and it restores `live_release_backup`, leaving the spoke a commit behind. Deploy = stop, pull, `dotnet build src/SwarmUI.csproj -c Release -o src/bin/live_release`, write HEAD to `src/bin/last_build`, restart the task. Redeploy `src/bin/extensions` whenever an extension repo changes: `ExtensionsManager.cs:250` refuses to build in spoke mode. The spoke's shell is `cmd.exe`, so paths need `cd /d`.
- **The spoke model cache fills AFTER a job, in the background, one file at a time** (`Paths.SpokeModelCache`, `src/Core/SpokeModelCache.cs`). It must never move back into the request path: copying before submit held the spoke silent long enough for the hub's claim to time out ("Generation session interrupted").
- **The `--ci_test` boot gate exits 1 on this machine and is currently useless as a signal.** It fails building `src/Extensions/SwarmUI-VideoStages`, which is untracked and gitignored — a local checkout, not repo content. Check what actually failed before treating a non-zero exit as a regression.
- Release caches extension assets in memory and `VaryID` only moves on commit — commit, restart, hard refresh before judging an asset edit failed.
- `git diff HEAD..upstream/master` is misleading here — the fork is hundreds of commits ahead, so fork features render as deletions. Always diff from the merge base.
- Do not run `stop.bat` / `restart.bat` from Git Bash or MSYS: GNU `find` and `timeout` shadow the Windows ones. `launch-windows.bat:67` only builds when `src/bin/live_release/SwarmUI.exe` is missing, so a restart can silently rerun the old binary.

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
```
