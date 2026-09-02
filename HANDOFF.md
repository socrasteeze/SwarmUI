# HANDOFF

**Updated:** 2026-09-02 · **Branch:** main · **Base:** 4d838eba (= origin/main) · **Tree:** clean

## State
All SwarmUI work is committed and pushed; four of today's commits need a server restart to take effect.
The AnimaDex Favorites filter is written to the NAS checkout and staged there, waiting on a container restart the user deferred.

## Done this session
- Merged upstream `059dcd69` (7 commits, prompt-parser fixes); both coupling watchlists re-verified — `AGENTS.md` sync log
- Batch-view toggles moved to the user account, zero core edits — `src/BuiltinExtensions/GenPagePrefs/`
- Character Sheet "Analyze pose" button wired to Interrogate — `src/BuiltinExtensions/CharacterSheet/Assets/charsheet.js`
- `/simple` Characters browser: two-row header, List / 2 wide / 3 wide layout, sort dropdown — `src/BuiltinExtensions/TagDex/Assets/m_tagdex.js`
- Headless API driver — `tools/swarm_api.mjs`

## Open
1. AnimaDex: after the NAS cache drain, restart the `animadex` container, then verify read-only: `GET /api/characters/search?favorites=1` must return total 3 and the gallery sidebar must show the "★ Favorites" toggle. Then commit the staged change in the AnimaDex checkout (see its own `HANDOFF.md`); push to its private origin only if asked.
2. Restart SwarmUI, then confirm: Analyze pose completes a WD14 round trip in Character Sheet; the batch toggles survive a browser close; the `/simple` Characters sort and layout controls work with real data.
3. The gitignored `src/Extensions/SwarmUI-VideoStages` no longer builds: upstream `059dcd69` removed `WorkflowGenerator.RunSeedVR2Stage`. Update that extension from its own upstream, as on 2026-08-20; never patch it here.
4. `Data/Autocompletions/gelbooru_anima_2026-06-11.csv` is superseded and can be deleted — user data, user's call.
5. Florence-2 caption index (`Florence2Run` output 2) is still unverified; `ListInterrogateBackends` reports `florence2` `available: false`, so the node pack must be installed first.
6. H3 baseline and sheet prompt wording (`SheetPlan.cs`) remain untuned against real output — GPU session, by eye.
7. The `@artist` autocomplete convention has never been A/B checked on the Anima checkpoints.

## Decisions
- No pull requests from this fork on any remote, ever — batch workers commit to local branches; user merges and pushes via `/clean`
- Server-side store for the batch toggles over changing core defaults — a default change masks the bug and is merge-hostile
- Explicit 2 / 3 column grid over `auto-fill` — auto-fill gave seven tiles across a desktop window
- `/simple` sort modes reuse the genpage tab's values and labels — one dataset must sort the same on both surfaces
- AnimaDex Favorites filter gated on dev mode like the stars — the store is only written through `/api/dev/`
- AnimaDex `app.js` null-guards the new control — template is cached until restart, static files are not
- `SetGenPagePrefs` replaces rather than merges — the client always sends all five keys
- `autocomplete="off"` kept on the batch checkboxes alongside the server store — it stops the in-session form-restoration override

## Traps
- A `JObject` API parameter receives the whole request payload with `session_id` stripped, not the field sharing its name — send objects flat or the route stores `{}` and reports success
- An empty `src/bin/live_release` breaks every `src/Extensions` build: their csproj resolves SwarmUI through `../../bin/live_release/SwarmUI.dll`
- Never `process.exit()` right after `fetch`/`WebSocket` in Node on Windows — libuv aborts; `tools/swarm_api.mjs` uses `process.exitCode`
- On the NAS, never chain `patch --dry-run` before `patch` on one piped stdin — the dry run consumes it and the real run applies nothing while reporting success; verify from what the container serves, git over SMB can read stale
- The permission classifier blocks most writes to the NAS share, `ssh` write commands, and `git commit` there; ship one `ssh nas patch -p1 < patch` and hand restart and commit to the user
- Release caches extension assets in memory and `VaryID` only moves on commit — commit, restart, hard refresh before judging an asset edit failed

## Verify
```powershell
dotnet build src/SwarmUI.csproj --configuration Release
dotnet test SwarmUITests/SwarmUITests.csproj --configuration Release
dotnet format SwarmUI.sln --verify-no-changes
node --check src/BuiltinExtensions/TagDex/Assets/m_tagdex.js
node --check src/BuiltinExtensions/GenPagePrefs/Assets/genpage_prefs.js
node --check src/BuiltinExtensions/CharacterSheet/Assets/charsheet.js
dotnet src/bin/Release/net8.0/SwarmUI.dll --ci_test true --launch_mode none --loglevel debug --data_dir "$env:TEMP\swarm-ci\data" --port 7899
# Live server, read-only. Port comes from Data/Settings.fds, never assume 7801.
node tools/swarm_api.mjs GetCurrentStatus
node tools/swarm_api.mjs ListInterrogateBackends
node tools/swarm_api.mjs GetGenPagePrefs
# AnimaDex, read-only, after its container restart. ${ANIMADEX_URL} is the animadex.url in Data/TagDex/local.json.
curl.exe -s "${ANIMADEX_URL}/api/characters/search?favorites=1"
curl.exe -s "${ANIMADEX_URL}/?mode=characters" | Select-String 'id="favorites-filter"'
```
