# HANDOFF

**Updated:** 2026-09-11 · **Branch:** main · **Base:** f3a5570 (= origin/main) · **Tree:** clean

## State
Routine scheduled upstream sync only — no fork feature work this session. Merged 1 upstream commit
("FromTo/Alternate hook lora support", `2119891`) with zero conflicts; see the 2026-09-11 entry in
`AGENTS.md`'s Upstream Sync Log for the merge details and the touchpoint re-verification. This ran in a
Linux cloud container with no `dotnet` SDK available (outbound install blocked by the environment's proxy
policy), so the usual `dotnet build`/`dotnet test`/`dotnet format` gates did not run here — brace-balance
and `py_compile` substitute checks passed instead. **Recommend a full `dotnet build` + `dotnet test
SwarmUITests` pass on a machine with the SDK before relying on this merge.** All items below are carried
forward unchanged from the prior session; none were touched by this sync.

## Done this session
- Reconciled the tracker against `1a6d8adc..HEAD`: filed and closed **SWR.77–84**, covering the spoke model cache, the spoke launcher/shortcut fixes, the session re-login wedge, the `/simple` GPU caret picker, the mobile scroll-perf sweep, the TagDex grid tiles, full-tag insert + `HiddenHistoryFolders` + pinned Starred, and the favorite-relay skip
- Closed **SWR.42** (lifecycle scripts — both present on disk, the untested path is SWR.53's clause) and **SWR.12** (tailnet auth — decision was already made, item was masquerading as open work)
- Rewrote **SWR.27**'s checklist: it was missing the Generate-caret GPU picker, five scroll-perf checks, and three TagDex grid/insert checks; raised to `high`
- Reprioritised: SWR.1/SWR.2 high→medium (both gated on SWR.27), SWR.59 and SWR.53 low→medium, SWR.51 medium→low

## Open
1. **SWR.59 — set `qwenEdit2511FP8_v10.safetensors`'s architecture to `qwen-image-edit`** in the Models tab. Two minutes, no code. Until then core SwarmUI skips the edit text-encode path for that checkpoint. Cheapest item on the board.
2. **SWR.27 — run the device pass.** It closes itself plus SWR.1 and SWR.2, and it is the only acceptance path for four things that shipped this week (SWR.80–83) with nothing but in-browser measurement behind them. The caret-picker section includes the specific regression: restart the spoke with the phone page open, then generate — it previously failed with *"Specific backend ID# requested in advanced parameters did not match"*.
3. **SWR.58 — Florence-2 caption index.** `ListInterrogateBackends` reports `florence2` `available: false`, so install the node pack first. Method is written on the item: headless, node 25 `WebSocket` + `POST /API/GetNewSession`. WD14 already cleared the transport chain, so a failure isolates to the node contract and output index.
4. **SWR.53 — exercise `restart.bat` once.** Do it while a spoke is up so it doubles as a check on the SWR.78 launcher fix. Build gate to watch is now `launch-windows.bat:67` (was ~62 before upstream drift): it only builds when `src/bin/live_release/SwarmUI.exe` is missing, so a restart can silently rerun the old binary.
5. **Embed resolution changed shape** — `<embed:...>` no longer gets its `/` rewritten to the backend separator, and the name is `CleanModelName`'d before the `\0swarmembed:` token. The Comfy node retries with `.safetensors` appended. Untested against a real subfolder embed on either backend.
6. **Restart SwarmUI and confirm** — Analyze pose completes a WD14 round trip; batch toggles survive a browser close; `/simple` Characters sort and layout work on real data.
7. **AnimaDex** — after the cache drain, restart the `animadex` container, verify read-only that favourites search returns total 3 and the sidebar shows the star toggle, then commit the staged change in that checkout.
8. **Spoke: a generation routed to the second backend in list order is still unexercised.** The profile itself is live (verified 2026-09-07: spoke reports `spoke_mode: true` / `spoke_controller: true`, hub backend `RequireSpokeMode` true, both hub backends `running`, zero errors; `can_load_models: false` on the spoke is the profile working as intended). Controller authorization is set on both sides in untracked config, so it is not in any delivery.
9. **`Text2Video Frames` and `Video Frames` now default to 24, not 25** — `src/Text2Image/T2IParamTypes.cs:461` and `:650`. Only bites a generation that leaves the toggle off. The SVD path still hardcodes 25 at `src/BuiltinExtensions/ComfyUIBackend/ComfyUIWebAPI.cs:458` and `:483`; upstream's own inconsistency, left alone.
10. **`/simple` never got the original-vs-interpreted prompt split.** `m_state.js:331` substitutes `extra.original_prompt` unconditionally; genpage now shows both rows when the original does not round-trip. Deliberate — see the sync log.
11. Seeds are sectionalizable and SeedVR's derived default moved from `Seed + 500` to `Seed + 9` — still untested on real generations.
12. SWR.51 / SWR.52 — H3 baseline and sheet prompt wording remain untuned against real output (`src/BuiltinExtensions/CharacterSheet/SheetPlan.cs`, GPU session, by eye). Upstream now detects H3 *embeddings* as their own class, which may change what shows in the model browser.
13. SWR.60 — `Data/Autocompletions/gelbooru_anima_2026-06-11.csv` is superseded and can be deleted; user data, user's call. Keep `NoobAIXL1.1_underscore.csv`: it holds 47,136 e621-vocabulary tags the Anima list lacks.
14. SWR.62 — the `@artist` autocomplete convention has never been A/B checked on the Anima checkpoints.
15. The desktop app has still never been launched; the Avalonia Wayland backend is Linux-only and compile-verified only — `src/Core/Program.cs:465`
16. `launchtools/install-windows.bat:35` still passes `--launch_mode webinstall`, now only a historical alias to `web`, so a fresh Windows install lands on the normal page, not the install page. Identical in upstream; left alone deliberately.
17. Dropping `diffusion_models` from this machine's `SDModelFolder` was deliberate — it matches the hub, which never listed that folder — but it costs the local ComfyUI those 8 unet files. Reverse only if something here needs them directly.
18. Addresses, machine names, and share names live in the gitignored `docs/Hub-Spoke-Setup.md`, deliberately never committed.

## Decisions
- Closed SWR.12 (tailnet auth) as a recorded decision rather than leaving it open: `Network.RequiredAuthorization` was rejected because `WebServer.cs` enforces it against every request including page loads, and only loopback is in `AuthBypassIPs` — enabling it 401s SwarmUI's own web UI everywhere but the host and breaks the mobile PWA. Reopen triggers: a guest device, exposure past the tailnet, or an unattended batch run. Public IP means a reverse proxy, not the built-in flag.
- Kept SWR.12 typed `task` rather than `decision` — this workspace's `decision` type requires a `decisionId` not worth inventing
- Left SWR.63 open: it is an `accepted` idea at 100% with end-to-end evidence and, unlike SWR.2, does not say "close only on physical-device evidence" — arguably closeable, but `idea` has no obvious terminal status here. User's call.
- Grouped the catch-up by unit of work, not per commit, so `4f26de34` is linked to SWR.77 (spoke cache, its primary subject) with its `/simple` half recorded on SWR.80
- Did not port the round-trip prompt check into `/simple` — it reduces metadata on purpose and the port would duplicate `promptCidMatcher` into the mobile bundle
- Kept every upstream commit byte-identical; no rebase, no reset-author, per the fork's merge rules
- No pull requests from this fork on any remote, ever — upstream is fetch-only and its push URL is disabled in `.git/config`

## Traps
- **Tracker issue keys (`SWR.n`) are local to this machine and must never appear in a commit message.** They are not shared keys. The tracker says so on every response. `linkedCommitSha` is the only durable join between a commit and an item — an item closed without it is invisible to the next catch-up run and gets re-filed as a duplicate.
- The next catch-up's default window starts at `6c2c5d0baebe38d1d6c0310966681e0e626b66cb` (SWR.83, newest linked SHA). Upstream (mcmonkey-authored) commits and AGENTS/HANDOFF sync-log commits are noise — drop them before grouping, or a routine sync reads as 40 commits of untracked work.
- Hub and spoke must run the identical commit. `src/Backends/SwarmSwarmBackend.cs:287` compares the remote version against `Utilities.VaryID` and refuses a negotiated spoke on any other build, so the backend sits in `loading` forever rather than erroring. Update one machine and you must update the other.
- `SwarmSwarmBackend` status `loading` with `remote_inventory_ready: true` and no errors was a wedge, not a slow load: a session re-login ran `ValidateAndBuild`, which invalidated the inventory (RUNNING→LOADING), rebuilt it, and restored nothing, and `IdleMonitorLoop` only probes RUNNING/IDLE, so nothing looked at it again. Re-login now keeps the inventory when the server id is unchanged and restores RUNNING otherwise. Recovery on an old build: disable/enable the backend.
- Redeploy `src/bin/extensions` to the spoke whenever an extension repo changes, and never expect the spoke to build them: `ExtensionsManager.cs:250` refuses in spoke mode. Before the fix the launcher also wiped that folder on every commit change, which is why the spoke came up with zero extensions after each update; the wipe is now skipped under `SWARM_SPOKE_LAUNCH`. Do not rely on the launcher to rebuild the spoke: from the scheduled-task session its `dotnet build` fails silently and it restores `live_release_backup`, so the spoke comes up one commit behind. Deploy = stop, `git pull`, `dotnet build src/SwarmUI.csproj -c Release -o src/bin/live_release`, write HEAD to `src/bin/last_build`, then `schtasks /end` + `/run` on the spoke task.
- The spoke model cache (`Paths.SpokeModelCache`, `src/Core/SpokeModelCache.cs`) fills AFTER a job, in the background, one file at a time. The first cold load of any model still crosses the tailnet; only the second is local. It must never move back into the request path: copying before submit held the spoke silent long enough for the hub's claim to time out ("Generation session interrupted").
- Folder-shaped models (CLIPSeg is one: seven files in `clipseg/clipseg-rd64-refined-fp16-safetensors/`) are not covered by the file-level cache. `SwarmClipSeg.py` now checks every configured `clipseg` folder before it will download, so a spoke finds the shared copy; it used to take only the first folder, which with the cache listed first was empty, and a spoke refuses the download.
- `LaunchMode` values: `webinstall` is a historical alias for `web`, `electron` is gone. Valid are `none`, `web`, `install`, `app`.
- An empty `src/bin/live_release` breaks every `src/Extensions` build; their csproj resolves SwarmUI through `../../bin/live_release/SwarmUI.dll`
- Release caches extension assets in memory and `VaryID` only moves on commit — commit, restart, hard refresh before judging an asset edit failed
- A `JObject` API parameter receives the whole request payload with `session_id` stripped, not the field sharing its name
- The permission classifier blocks most writes to the network share and `git commit` there; hand restart and commit to the user
- `git diff HEAD..upstream/master` is misleading here — the fork is hundreds of commits ahead, so fork features render as deletions. Always diff from the merge base.
- Do not run `stop.bat` / `restart.bat` from Git Bash or MSYS: GNU `find` and `timeout` shadow the Windows ones. `stop.bat` calls system utilities by absolute path for this reason; the stock launchers do not.

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
