# HANDOFF

**Updated:** 2026-09-01 · **Branch:** main · **Base:** 15927c24 (= origin/main) · **Tree:** clean · **Pushed**

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
7. ~~**Not built:** the planned "Analyze pose image" button wiring Character Sheet to Interrogate.~~ **Shipped 2026-09-01** (`c20fb2b4`): the button under the pose slot runs the image through the Interrogate tool's selected backend and appends the result to Extra Panels. Verified only against a backend-less server (button, request, clean error path); the full WD14 round trip on the live server is still untested.

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

### Done — batch session (2026-09-01, `c02a6bad` → `15927c24`)
- Both coupling watchlists (MobilePWA plan, TagDex plan) re-verified after upstream merge `b24d62b3`; nothing broken, line hints refreshed.
- AGENTS.md "Build / run / verify" corrected (NUnit suite, Windows launchers, headless `--ci_test` DLL form); MobilePWA Phase 5 item 1 marked obsolete (`start_url` is already `/simple`).
- New `src/BuiltinExtensions/TagDex/README.md`; new `tools/swarm_api.mjs` headless API driver (`--ws` for websocket routes; use `process.exitCode`, never `process.exit()` right after fetch/WebSocket on Windows or Node aborts in libuv).
- Interrogate gained additive `interrogate()`, `fillOptionDefaults()`, and `refreshBackends(callback, errorCallback, timeoutMs)`; `run()` behaviour unchanged.
- Process rule: this fork never opens pull requests, on any remote. Workers commit to local branches; merge locally and push `origin/main` only.

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

## Done — verification session (2026-08-30, after `cd5e15f4`)

Everything here was run against the **live server on port 8085** by driving the websocket API headlessly, not
through the browser. **Open items 1, 4 and 5 below are now closed**; item 2 and 6 are not.

**Interrogate works end to end (closes Open 1).** A real image through `wd14tagger` returned ~50 coherent tags.
That exercises the whole chain: `SwarmLoadImageB64` -> `WD14Tagger|pysssss` -> `SwarmAddSaveMetadataWS` ->
the 12347 text channel -> `ExtraMeta` -> the websocket route. The node contract, written from reading that
repo's `nodes.py` rather than from a live `object_info`, was correct.

**WD14 was already installed** on the ComfyUI backend, so no node pack had to be added. `ListInterrogateBackends`
enumerated 11 tagger models off the live `object_info`, confirming the `RawObjectInfoParsers` hook works.
**Those model names carry no `.onnx` suffix** (`wd-v1-4-moat-tagger-v2`, not `...-v2.onnx`) - `ResolveWD14Model`
matches by prefix, which is the only reason a hardcoded default did not fail Comfy validation.

**Character Sheet orchestration works (closes Open 4).** A 2-panel per-panel run on a fast SDXL checkpoint
produced two generations and one composited 1024x533 sheet in history with both captions drawn correctly.
That covers panel planning, the `CreateImageTask` fan-out, ImageSharp compositing, labelling, and the save path.

**Model-family caps verified.** `CharacterSheetInfo` returns `minimax_h3` cap 9 / one-shot / frames 2,
`flux2` cap 4, and `qwen_image_edit_plus` cap 3 with the correct reason string.

**The per-panel prompt defect was found by that test, not by reading** - each panel drew several figures because
the shared style text said "character reference sheet". Fixed in `cd5e15f4`. Open 5 is therefore partly closed:
the pathological case is gone, but the wording is still untuned against real output.

### Load-bearing facts from this session

- **These routes can be driven headlessly.** Node 25's global `WebSocket` plus `POST /API/GetNewSession` is
  enough to exercise `InterrogateImage` and `CharacterSheetRun` without a browser, which is how everything above
  was verified. Far faster than clicking, and it is the way to test any future websocket route.
- **`qwenEdit2511FP8_v10.safetensors` is mis-tagged and it is not this fork's bug.** SwarmUI classifies it as
  architecture `qwen-image`, not `qwen-image-edit`, so `IsQwenImageEdit()` is false for it and **core SwarmUI
  will not use the edit text-encode path for that checkpoint either** - the sheet tool reporting `generic` cap 1
  is just agreeing with core. The other five Qwen Edit checkpoints are tagged `qwen-image-edit-plus` and behave
  correctly. Fix is to set the architecture on that one file in the Models tab.
- **`live_release` cannot be rebuilt while the server is running** - it holds `SwarmUI.exe` and the copy fails
  with MSB3027. Stop the server first, or build to the default output and deploy on the next restart.

### Autocomplete word list - state of play

The active `AutoCompletionsSource` is **`NoobAIXL1.1_underscore.csv`**, the oldest of the three lists on disk.
Measured, normalized for convention:

| File | Rows | `1girl` count | Convention | Vocabulary |
|---|---|---|---|---|
| `NoobAIXL1.1_underscore.csv` | 141,802 | 6,160,038 | 100% underscore | danbooru + e621 |
| `gelbooru_anima_2026-06-11.csv` | 235,255 | 9,259,271 | 100% space | gelbooru/danbooru only |
| `illustriousV1.0_underscore.csv` | 93,908 | 6,172,043 | 100% underscore | danbooru |

- **The two conventions make the files look unrelated.** Raw, they share only ~26k tags; normalized
  (`strip().replace(' ','_')`) they share 94,666. Any comparison or merge MUST normalize first.
- Normalized, the Anima list **adds 140,580 tags** over NoobAI's and its post counts are roughly a year fresher.
- But NoobAI's list holds **47,136 tags the Anima list lacks, and they are e621 vocabulary** - the highest-count
  ones are `mammal`, `anthro`, `hi_res`, `female`, `male`, `genitals`, `clothing`, `fur`, `duo`. NoobAI XL was
  trained on danbooru **and** e621; the gelbooru-derived Anima list carries none of it.
- `gelbooru_anima_2026-06-11.csv` has 9 rows with leading or trailing whitespace in the tag column - a scrape
  artifact, harmless but worth stripping in any rebuild.

## Done — Anima autocomplete list (2026-08-30)

**Shipped and live.** `AutoCompletionsSource` is now `anima_gelbooru_2026-08-13.csv` with `SpacingMode: None`,
verified through `GetMyUserData`: 136,856 entries load, `@dairi` inserts as `@dairi, ` with alias `dairi`,
`score_7` and `^_^` keep their underscores, `sole female` is present. Full rationale is in
`docs/Anima-Autocomplete.md`; only the parts that doc does not carry are recorded here.

**The previously active `NoobAIXL1.1_underscore.csv` was wrong on four independent counts** — built for NoobAI
XL v1.1 (SDXL family, a different architecture entirely), underscored while the model card asks for spaces,
danbooru+e621 while the card designates Gelbooru, tag cutoff 2024-11-03, and **zero `@`-prefixed artists** out
of ~50,000 artist rows. Every artist completion it offered was syntax Anima was not trained to read.

**Built `anima_gelbooru_2026-08-13.csv`** (136,856 rows) via the new `tools/compile_anima_tags.py`, from
BetaDoggo's `anima-2.9B-preview-V1.csv`. Repaired 1,953 HTML-entity-corrupted tag names, converted underscores
to spaces with `score_1`-`score_9` and ~20 kaomoji exempted, merged 40,857 Danbooru aliases (alias coverage
10,558 -> 67,099 rows), added the 45 control tags the card names, and dropped 3 rows starting with `#` that
SwarmUI silently discards anyway.

### Corrections to what this session originally concluded

An earlier pass in this same session compiled `anima_2026-08-30.csv` and recommended it. **That file has been
deleted and its conclusions were wrong in two ways**, both caught by a follow-up research sweep:
- **Its name asserted a recency it did not have.** The data inside was the 2026-06-11 Gelbooru snapshot, not
  August. Name a compiled list after the source data's date, never the build date.
- **It invented 44 post counts between 86,000,000 and 90,000,000** to pin control tags to the top of the
  frequency sort. Gelbooru's entire corpus is ~14.1M posts, so those were impossible values sitting in a column
  that holds real counts everywhere else. The replacement leaves them at `0`; the default `Active` sort orders
  by tag length anyway, so the weighting was never needed.

### Load-bearing facts

- **A newly added list file is invisible until the autocomplete cache refreshes.** `GetMyUserData` returned
  **0 entries** with the setting correctly pointed at a file that existed on disk. `TriggerRefresh` fixed it.
  Do not diagnose an empty list as a bad file.
- **`anima-1.0.csv` is not Gelbooru-based despite its release note saying so.** Its `1girl` is 7,868,012, which
  is Danbooru's level, not Gelbooru's 9.5M, and it lacks Gelbooru-first vocabulary like `sole_female` (3.9M).
  It is the only list matching official Anima's 2025-09-01 cutoff, so it remains the fallback if post-cutoff
  vocabulary ever proves to be a real problem — but it breaks the card's explicit Gelbooru rule.
- **`SpacingMode` must stay `None`.** It is a blanket `_`->space replace with no exemptions, so `Spaces` would
  rewrite `score_7` to `score 7` and mangle every kaomoji tag. Convention is handled at compile time instead.
- **BetaDoggo's `Model-Tags` release is rolling.** The page reads "Published Feb 9, 2025" (the git tag date)
  while assets are uploaded into it continuously — the Anima 2.9B asset is dated 2026-08-13. Read per-asset
  `created_at`, never the release date.
- **Gelbooru's tag API needs a free account** (`api_key` + `user_id`; 401 without). The keyless web listing is
  hard-capped at `pid=20000` and silently repeats page 1 past that, so it cannot be paginated to a threshold —
  a loop that paginates until the post count crosses 50 never terminates.
- **Gelbooru exposes no tag creation date**, so a Gelbooru-sourced list cannot be backdated to a model's
  knowledge cutoff. That is the structural reason no perfectly-matched Anima list exists anywhere.
- The user runs **both** Anima generations: 36 official Anima 1.x checkpoints and one 2.9B
  (`anima29BP1Turbo11`). The chosen list serves both; the 2.9B checkpoint is why its later cutoff is not waste.

### Open — autocomplete
12. **Old lists are still on disk and still selectable.** `NoobAIXL1.1_underscore.csv` is legitimate for actual
    NoobAI checkpoints (though `ChenkinNoob-XL-V0.5_underscore.csv`, 2026-04-10, is 14 months fresher);
    `gelbooru_anima_2026-06-11.csv` is now fully superseded and can be deleted.
13. **Nothing rebuilds this automatically.** When BetaDoggo publishes a newer Gelbooru-sourced Anima asset,
    re-run `tools/compile_anima_tags.py` against it. The compiler takes source and destination paths and does
    not care which base it is given.
14. **The `@` artist convention is unverified in practice.** It comes from the model card, and the list now
    follows it, but no side-by-side generation was run to confirm `@name` actually beats bare `name` on these
    checkpoints.
