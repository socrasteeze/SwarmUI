# HANDOFF

**Updated:** 2026-09-07 · **Branch:** main · **Base:** e802a9eb (= origin/main before this push) · **Tree:** clean

## State
Upstream sync plus a spoke-config fix; no fork source work. Merged upstream `519ba0f4` — 6 commits, 7 files,
+32/-9 — as `180a5f6a`, zero conflicts, no fork file needing resolution. All gates green including a clean
`--ci_test` boot. **This machine's Swarm needs a restart** to pick up the `Data/Settings.fds` change below.

## Done this session
- Merged upstream's embed-naming trio, H3 embedding detection, `Frames` default 25→24, and the metadata panel work
- Verified the fork's spoke guard, Civitai LoRA-class mapping, and `ToNet` overload all survived intact
- Confirmed `src/Extensions/SwarmUI-VideoStages` is gone, which is why the boot finally exits 0
- Aligned this machine's `SDModelFolder` and `SDVAEFolder` with the hub's, so all eight Paths settings now
  match — untracked config, so it is not in this delivery

## Open
1. **Embed resolution changed shape** — `<embed:...>` no longer gets its `/` rewritten to the backend separator, and the name is `CleanModelName`'d before the `\0swarmembed:` token. The Comfy node retries with `.safetensors` appended. Untested against a real subfolder embed on either backend.
2. **`Text2Video Frames` and `Video Frames` now default to 24, not 25** — `src/Text2Image/T2IParamTypes.cs:461` and `:650`. Only bites a generation that leaves the toggle off. The SVD path still hardcodes 25 at `src/BuiltinExtensions/ComfyUIBackend/ComfyUIWebAPI.cs:458` and `:483`; that is upstream's own inconsistency, left alone.
3. **`/simple` never got the original-vs-interpreted prompt split.** `m_state.js:331` substitutes `extra.original_prompt` unconditionally; genpage now shows both rows when the original does not round-trip. Deliberate — see the sync log.
4. The desktop app has still never been launched; the Avalonia Wayland backend is Linux-only and compile-verified only — `src/Core/Program.cs:465`
5. `launchtools/install-windows.bat:35` still passes `--launch_mode webinstall`, now only a historical alias to `web`, so a fresh Windows install lands on the normal page, not the install page. Identical in upstream; left alone deliberately.
6. AnimaDex: after the cache drain, restart the `animadex` container, verify read-only that favourites search returns total 3 and the sidebar shows the star toggle, then commit the staged change in that checkout.
7. Restart SwarmUI and confirm: Analyze pose completes a WD14 round trip; batch toggles survive a browser close; `/simple` Characters sort and layout work on real data.
8. Florence-2 caption index unverified — `ListInterrogateBackends` reports `florence2` `available: false`, so install the node pack first.
9. H3 baseline and sheet prompt wording remain untuned against real output — `src/BuiltinExtensions/CharacterSheet/SheetPlan.cs`, GPU session, by eye. Upstream now detects H3 *embeddings* as their own class, which may change what shows in the model browser.
10. Seeds are sectionalizable and SeedVR's derived default moved from `Seed + 500` to `Seed + 9` — still untested on real generations.
11. `Data/Autocompletions/gelbooru_anima_2026-06-11.csv` is superseded and can be deleted — user data, user's call.
12. The `@artist` autocomplete convention has never been A/B checked on the Anima checkpoints.
13. **Spoke profile is live.** Verified 2026-09-07: the spoke reports `spoke_mode: true` and `spoke_controller: true`, the hub backend `RequireSpokeMode` is `true`, and both hub backends read `running` with zero errors in the hub log. `can_load_models` is `false` on the spoke backend, which is the profile working as intended. Controller authorization is set on both sides in untracked config (`Data/Settings.fds` on the spoke, `Data/Backends.fds` on the hub), so it is not in this delivery. The inventory is names only and arrives whole: a negotiated spoke throws rather than accept a partial list, so the `ModelListSanityCap` truncation that applied to the old generic-remote link is gone. Still unexercised: an actual generation routed to the second backend in list order.
14. Dropping `diffusion_models` from this machine's `SDModelFolder` was deliberate — it matches the hub, which never listed that folder — but it costs the local ComfyUI those 8 unet files. Reverse only if something here needs them directly.
15. Addresses, machine names, and share names live in the gitignored `docs/Hub-Spoke-Setup.md`, deliberately never committed.

## Decisions
- Did not port the round-trip prompt check into `/simple` — it reduces metadata on purpose and the port would duplicate `promptCidMatcher` into the mobile bundle
- Kept every upstream commit byte-identical; no rebase, no reset-author, per the fork's merge rules
- No pull requests from this fork on any remote, ever — upstream is fetch-only and its push URL is disabled in `.git/config`

## Traps
- Hub and spoke must run the identical commit. `src/Backends/SwarmSwarmBackend.cs:287` compares the remote version against `Utilities.VaryID` and refuses a negotiated spoke on any other build, so the backend sits in `loading` forever rather than erroring. Update one machine and you must update the other.
- `SwarmSwarmBackend` status `loading` with `remote_inventory_ready: true` and no errors was a wedge, not a slow load: a session re-login ran `ValidateAndBuild`, which invalidated the inventory (RUNNING→LOADING), rebuilt it, and restored nothing, and `IdleMonitorLoop` only probes RUNNING/IDLE, so nothing ever looked at it again. Re-login now keeps the inventory when the server id is unchanged and restores RUNNING otherwise. Recovery on an old build: disable/enable the backend.
- Redeploy `src/bin/extensions` to the spoke whenever an extension repo changes, and never expect the spoke to build them: `ExtensionsManager.cs:250` refuses in spoke mode. Before this fix the launcher also wiped that folder on every commit change (`launch-windows.bat` `must_rebuild` block), which is why the spoke came up with zero extensions after each update; the wipe is now skipped under `SWARM_SPOKE_LAUNCH`. Do not rely on the launcher to rebuild the spoke: from the scheduled-task session its `dotnet build` fails silently and it restores `live_release_backup`, so the spoke comes up one commit behind. Deploy = stop, `git pull`, `dotnet build src/SwarmUI.csproj -c Release -o src/bin/live_release`, write HEAD to `src/bin/last_build`, then `schtasks /end` + `/run` on the "SwarmUI Spoke" task.
- The spoke model cache (`Paths.SpokeModelCache`, `src/Core/SpokeModelCache.cs`) fills AFTER a job, in the background, one file at a time. The first cold load of any model still crosses the tailnet; only the second is local. It must never move back into the request path: copying before submit held the spoke silent long enough for the hub's claim to time out ("Generation session interrupted").
- Folder-shaped models (CLIPSeg is one: seven files in `clipseg/clipseg-rd64-refined-fp16-safetensors/`) are not covered by the file-level cache. `SwarmClipSeg.py` now checks every configured `clipseg` folder before it will download, so a spoke finds the shared copy; it used to take only the first folder, which with the cache listed first was empty, and a spoke refuses the download.
- `LaunchMode` values: `webinstall` is a historical alias for `web`, `electron` is gone. Valid are `none`, `web`, `install`, `app`.
- An empty `src/bin/live_release` breaks every `src/Extensions` build; their csproj resolves SwarmUI through `../../bin/live_release/SwarmUI.dll`
- Release caches extension assets in memory and `VaryID` only moves on commit — commit, restart, hard refresh before judging an asset edit failed
- A `JObject` API parameter receives the whole request payload with `session_id` stripped, not the field sharing its name
- The permission classifier blocks most writes to the network share and `git commit` there; hand restart and commit to the user
- `git diff HEAD..upstream/master` is misleading here — the fork is hundreds of commits ahead, so fork features render as deletions. Always diff from the merge base.

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
