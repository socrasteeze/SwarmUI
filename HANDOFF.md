# HANDOFF

**Updated:** 2026-09-06 · **Branch:** main · **Base:** e802a9eb (= origin/main before this push) · **Tree:** clean

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
13. **Spoke is configured but never started.** The hub's `swarmswarmbackend` entry is already `enabled: true`, and all eight of this machine's Paths settings now match the hub's, so it resolves ~173 checkpoints and ~19.5k LoRAs off the shared drive. Nothing has been exercised: start Swarm here via `launch-fork.bat`, confirm the hub leaves idle, then queue enough work to reach the second backend in list order. Expect a slow first model scan — ~20k small files plus sidecars over SMB is the access pattern that share is worst at.
14. Dropping `diffusion_models` from this machine's `SDModelFolder` was deliberate — it matches the hub, which never listed that folder — but it costs the local ComfyUI those 8 unet files. Reverse only if something here needs them directly.
15. Addresses, machine names, and share names live in the gitignored `docs/Hub-Spoke-Setup.md`, deliberately never committed.

## Decisions
- Did not port the round-trip prompt check into `/simple` — it reduces metadata on purpose and the port would duplicate `promptCidMatcher` into the mobile bundle
- Kept every upstream commit byte-identical; no rebase, no reset-author, per the fork's merge rules
- No pull requests from this fork on any remote, ever — upstream is fetch-only and its push URL is disabled in `.git/config`

## Traps
- `LaunchMode` values: `webinstall` is a historical alias for `web`, `electron` is gone. Valid are `none`, `web`, `install`, `app`.
- An empty `src/bin/live_release` breaks every `src/Extensions` build; their csproj resolves SwarmUI through `../../bin/live_release/SwarmUI.dll`
- Release caches extension assets in memory and `VaryID` only moves on commit — commit, restart, hard refresh before judging an asset edit failed
- A `JObject` API parameter receives the whole request payload with `session_id` stripped, not the field sharing its name
- **`.fds` escapes a literal backslash as `\s`.** `ModelRoot: E:\smodels` means `E:\models`, and `DataPath: E:\sSwarmUI\sData` means `E:\SwarmUI\Data`. Never "correct" one of these to a bare backslash — that is what the value already is.
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
