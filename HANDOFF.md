# HANDOFF

**Updated:** 2026-08-30 · **Branch:** main · **Base:** cd5e15f4 (= origin/main) · **Tree:** clean · **Pushed**

> Line cap intentionally bypassed. Two separate work streams are recorded below: the extensions session
> (Interrogate + Character Sheet, still untested), and a later TagDex session that shipped and verified a
> two-way image sync with AnimaDex.

## State
Two new builtin extensions are committed and pushed but **never exercised against a live ComfyUI backend** —
all gates pass, no interrogation or sheet has actually been generated. Everything under "Open" turns on that
testing, and it is unchanged.

The TagDex work that followed **is** exercised: thumbnails, the AnimaDex push and the full round trip were all
verified against the running server. `stop.bat` / `restart.bat` are now committed (they were listed as
uncommitted above; that is stale).

## Done — extensions session
- Interrogate extension (WD14 tags + Florence-2 caption) — `src/BuiltinExtensions/Interrogate/`
- Character Sheet extension (multi-view sheets, C# compositing) — `src/BuiltinExtensions/CharacterSheet/`
- `stop.bat` / `restart.bat` — restart stops, pulls, then delegates rebuild to `launch-windows.bat`
- Feature index entries — `docs/Features/README.md`

## Done — TagDex session (2026-08-30, commits `069867b4` → `cd5e15f4`)

**Thumbnail import matching widened.** `TagDexAPI.Normalize` now folds filename-illegal characters and
trailing dots, because external exporters sanitise them out: a thumbnail for `2b_(nier:automata)` lands on
disk as `2b (nier automata)` and could never match the colon-bearing trigger. Recovered **1,643 characters
and 51 artists** (32,648 → 34,291). The fold makes 85 tag pairs collide (`awa`/`awa.`, `unown`/`unown_?`),
which is why the match dict is `TryAdd` and not assignment — `Entries` is count-descending, so first-wins
gives the thumbnail to the tag the model actually learned.

**Datasets populated from an AnimaDex export.** 34,291 character + 15,867 artist thumbnails imported, and the
`anima_styles` dataset installed (42,509 entries, 1:1 coverage). Totals now **92,667 references on disk**
across three datasets. The export was recovered from the live AnimaDex Docker container, not the old tar.

**Thumbnails are WebP now, not 256px JPEG.** `ImageFile.ToMetadataJpg` is upstream's *model preview* helper —
it forces a 256px short side and hard-codes JPEG. Measured across five cards holding both formats, those
JPEGs ran 90 KB against 82 KB of equivalent WebP: **9% larger while holding fewer pixels**. Anime line art is
near the worst case for JPEG. Now 445px-tall WebP, matching AnimaDex's `thumb_height` so an 896×1344 render
reduces to exactly 297×445 on both sides. All existing JPEGs were swept and converted.

**Optional lossless archive.** `keep_originals` writes the untouched full-resolution PNG to
`Data/TagDex/originals/{source}/{name}.png`. Already-PNG input is stored verbatim, so the archive is the
generator's exact output. ~0.5–1.5 MB per image, opt-in.

**Two-way sync with AnimaDex.** `TagDexAnimaDex.PushAsync` POSTs to AnimaDex's `/api/dev/ingest` after a
generate or a set, wired through `WriteThumbAndSync`. Fire-and-forget: a sync failure never fails the
thumbnail. Config in `Data/TagDex/local.json` (gitignored).

**`SheetPlan.cs` per-panel prompts fixed** (`cd5e15f4`). The shared style text said "character reference
sheet", which is right for one-shot mode and wrong everywhere else — a per-panel generation drew an entire
multi-view sheet inside each panel and the composite came out a sheet of sheets. Split into `BaseStyle` /
`OneShotStyle` / `SinglePanelStyle`. This partly addresses Open item 5, though the wording is still untuned
against real output.

### TagDex facts that are load-bearing

- **The push sends the pre-downscale image.** `WriteThumb` stores a 256px JPEG; AnimaDex keeps a full-size PNG
  and derives its own 297×445 WebP. Pushing the thumbnail would cap AnimaDex's quality permanently.
- **`syncBack=false` breaks the cycle.** AnimaDex sets it when calling `TagDexSetThumbnail`; without it the
  image AnimaDex just pushed is pushed straight back, rewriting the file it came from and double-bumping its
  version.
- **`ToIS` must never be disposed.** It is a cache on the `ImageFile` itself (`ImageFile._CacheISImg`), so a
  `using` on it leaves the same file unusable for the originals write and the push that follow in one call.
- **`ThumbnailFor` probes `.jpg` before `.webp`.** `WriteThumb` therefore deletes same-stem siblings after a
  successful write — without that, the format change is invisible because the old JPEG keeps being served.
- **Config is a file, not `TagDexPrefs`.** Prefs sit behind `tagdex_use` (USER tier by default) and
  `TagDexSetPrefs` stores the request body verbatim with no whitelist, so a push target there would let any
  ordinary user redirect generated images to a host of their choosing — and `ToJson` echoes every field to
  every browser. `Settings.cs` was rejected too: a core edit for one extension's feature, costing TagDex its
  zero-core-edit property.
- **Only the danbooru datasets map to AnimaDex.** e621 and `anima_styles` have no rows there; a 404 back from
  AnimaDex is normal (~6% of even danbooru characters) and is logged at Debug, not Warning.

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
6. **Exercise `restart.bat` once.** Its pull-and-launch path was never run, because running it starts a server.
   `stop.bat` is tested.
7. **Not built:** the planned "Analyze pose image" button wiring Character Sheet to Interrogate.

### Open — TagDex
8. **SwarmUI is unauthenticated and AnimaDex now depends on it.** Bound `0.0.0.0:8085`, the `local` user holds
   `*`, so anything on the LAN or tailnet can drive it. `Network.RequiredAuthorization` was deliberately
   **rejected**: `WebServer.cs` enforces it against *every* request including page loads, and only loopback is
   in `AuthBypassIPs`, so enabling it returns 401 for SwarmUI's own web UI everywhere except the host — it
   breaks the mobile PWA. The accepted residual is `ShutdownServer` (recoverable); `delete_models`, already
   accepted on the same network, is permanent. Revisit on a guest device, exposure beyond the tailnet, or an
   unattended batch run. The proper answer if this ever faces a public IP is a reverse proxy with real auth.
9. **Two ComfyUI installs both target GPU 0.** SwarmUI's own `dlbackend/comfy` (ports 5809–5814) and the
   standalone install on 8888. Only relevant if the standalone one is driven at the same time.
10. **`anima_styles` cannot receive pushes** (see Traps). If two-way sync with that 42,509-entry dataset ever
    matters, `ThumbnailFor`'s early return on a pre-resolved `ThumbPath` is the thing to fix.
11. **410 of the on-disk character stems carry the hash suffix.** Never rebuild a thumbnail URL client-side
    from a slug — call `TagDexSearchEntries` and read the server-supplied `thumb` field.

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
- **An UNCOMMITTED asset edit does not move `VaryID`.** It is `Version + ".GIT-" + GitCommit`, so a JS fix that
  is built and deployed but not committed leaves the fingerprinted URL identical and every browser keeps
  serving its cached copy. This cost a full round trip: a fixed `tagdex_tab.js` looked like it had not worked,
  and a user re-triggered the original bug from stale script. Commit asset fixes before concluding they failed.
- **`launch-windows.bat` only builds when `src/bin/live_release/SwarmUI.exe` is MISSING** (line ~62). Stopping
  the server and relaunching silently reruns the old binary. To make a source edit live:
  `dotnet build src/SwarmUI.csproj --configuration Release -o src/bin/live_release`, the same invocation line 66
  uses. Also note a `///` doc comment never reaches the DLL, so it is useless as a liveness marker.
- **Release builds cache extension JS/CSS in memory permanently.** Edits to `charsheet.js` / `interrogate.js` do
  nothing until the server restarts, and the browser needs a hard refresh after that.
- **`imageToData`'s `resize256` shrinks to 65,536 total pixels and re-encodes as JPEG.** Harmless when the
  server also downscales, actively destructive now that TagDex stores 445px and archives originals — an
  896×1344 render arrived as ~212×309 and was scaled back up. `ToThumbWebp` additionally clamps so it can never
  enlarge; upscaling is the worse failure because it is silent, landing at exactly the expected dimensions.
- **Never call `TagDexDeleteThumbnail` to clear a generated image.** It deletes `.jpg`, `.webp` *and* `.png` for
  the stem, so it also destroys an imported original underneath.
- **Never push to `anima_styles`.** Those entries resolve thumbnails by a pre-set path and the serve route
  early-returns on it, so a write is accepted, reported as success, and then never served. `tagdex_sync.py`
  refuses that source outright.
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
