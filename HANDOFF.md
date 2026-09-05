# HANDOFF

**Updated:** 2026-09-04 · **Branch:** main · **Base:** 775713a0 (= origin/main after this push) · **Tree:** clean

## State
Upstream sync only; no fork feature work this session. Six commits go to `origin/main`: upstream's four
(Wayland desktop backend, aspect autodescribe, sectionalizable seeds, `StepSwapNoisy` fix), the merge `775713a0`,
and this doc update. Zero conflicts, no fork file touched, all gates green. Nothing needs a restart.

## Done this session
- Merged upstream `f185f256` (4 commits, 8 files, +23/-18) — details in the `AGENTS.md` sync log
- Verified no fork-owned code was in the merge path; every hunk auto-merged with no fork text nearby
- Confirmed upstream's new code passes both format gates unmodified this time (last window it did not)

## Open
1. **Seeds are now sectionalizable** — `<refiner>`, `<video>`, `<segment:...>`, SeedVR, and the pixel decoder each take their own `<param[seed]:...>`. Untested on real generations here. Note SeedVR's derived default changed from `Seed + 500` to `Seed + 9`, so SeedVR output on an unchanged prompt will differ from before this merge.
2. The desktop app was never launched, and the new Avalonia Wayland backend is Linux-only and compile-verified only — `src/Core/Program.cs:465`
3. `launchtools/install-windows.bat:35` still passes `--launch_mode webinstall`, now only a historical alias to `web`, so a fresh Windows install lands on the normal page, not the install page. Identical in upstream; left alone deliberately.
4. The gitignored `src/Extensions/SwarmUI-VideoStages` still fails on `RunSeedVR2Stage`, removed by upstream `059dcd69`. Update it from its own upstream; never patch it here.
5. AnimaDex: after the cache drain, restart the `animadex` container, verify read-only that favourites search returns total 3 and the sidebar shows the star toggle, then commit the staged change in that checkout.
6. Restart SwarmUI and confirm: Analyze pose completes a WD14 round trip; batch toggles survive a browser close; `/simple` Characters sort and layout work on real data.
7. Florence-2 caption index unverified — `ListInterrogateBackends` reports `florence2` `available: false`, so install the node pack first.
8. H3 baseline and sheet prompt wording remain untuned against real output — `src/BuiltinExtensions/CharacterSheet/SheetPlan.cs`, GPU session, by eye.
9. `Data/Autocompletions/gelbooru_anima_2026-06-11.csv` is superseded and can be deleted — user data, user's call.
10. The `@artist` autocomplete convention has never been A/B checked on the Anima checkpoints.

## Decisions
- Fixed upstream's whitespace rather than relaxing the gate — the format check is upstream's own CI step and the pre-merge tree passed it
- Left the installer's `webinstall` flag alone — the file is byte-identical to upstream, so the inconsistency is theirs to own
- Kept every upstream commit byte-identical; no rebase, no reset-author, per the fork's merge rules
- No pull requests from this fork on any remote, ever — upstream is fetch-only and its push URL is disabled in `.git/config`
- Server-side store for the batch toggles over changing core defaults — a default change masks the bug and is merge-hostile

## Traps
- `LaunchMode` values changed: `webinstall` is now a historical alias for `web` and `electron` is gone. Valid values are `none`, `web`, `install`, `app`.
- The whitespace fix leaves four lines of permanent divergence from upstream in that switch — a future merge touching it will conflict there.
- An empty `src/bin/live_release` breaks every `src/Extensions` build; their csproj resolves SwarmUI through `../../bin/live_release/SwarmUI.dll`
- Release caches extension assets in memory and `VaryID` only moves on commit — commit, restart, hard refresh before judging an asset edit failed
- A `JObject` API parameter receives the whole request payload with `session_id` stripped, not the field sharing its name
- The permission classifier blocks most writes to the network share and `git commit` there; hand restart and commit to the user

## Verify
```powershell
dotnet build SwarmUI.sln --configuration Release
dotnet test SwarmUITests/SwarmUITests.csproj --configuration Release
dotnet format SwarmUI.sln --verify-no-changes
dotnet format style --verify-no-changes
dotnet build Desktop/Desktop.csproj --configuration Release
dotnet src/bin/Release/net8.0/SwarmUI.dll --ci_test true --launch_mode none --loglevel debug --data_dir "$env:TEMP\swarm-ci\data" --port 7899
# Live server, read-only. Port comes from Data/Settings.fds, never assume 7801.
node tools/swarm_api.mjs GetCurrentStatus
```
