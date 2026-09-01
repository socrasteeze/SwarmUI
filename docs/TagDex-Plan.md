# TagDex — Character/Artist Tag Picker (Fork)

Implementation handoff for the booru character/artist picker on this fork (socrasteeze/SwarmUI). Written so a coding agent (or human) can extend it phase-by-phase without redoing the research.

Read `AGENTS.md` first. Everything here follows the merge-friendly policy: **zero edits to existing upstream files**. The only files touched outside the new extension are two fork-owned MobileEnhancements assets.

## Implementation status (living)

Phases 1–7 are **implemented**.

- **Phase 1 (data + typeahead)** — done. Column-name-driven CSV loader for all three shipped schemas, lazy per-dataset load with single-flight gating, in-memory search with bitmask facets, and a `getPossibleList` prototype wrap that merges character suggestions into the existing prompt popover.
- **Phase 2 (browse tab)** — done. `Tabs/GenerateBottom/Characters.html` auto-wires a Characters tab into the Generate bottom bar; `GenPageBrowserClass` in Cards format with a copyright folder tree, five facet dropdowns, server-driven search, and per-character core-tag chips. Originally lived under `Tabs/Text2Image/` (its own top-level strip tab); moved into the Generate bottom bar by mirroring the same discovery hook (`WebServer.cs` gains a second `Tabs/GenerateBottom/*.html` scan feeding `T2IBottomTabHeader`/`T2IBottomTabBody`, rendered by `GenerateTab.cshtml` alongside its hardcoded bottom-bar nav items and panes) — same permission ID (`view_extension_tab_characters`), narrower panel.
- **Phase 3 (all four datasets)** — done. Danbooru and e621, characters and artists, all registered and downloadable. The loader tolerates the missing `core_tags`/`copyright`/`solo_count` columns and the UI hides what the data cannot support. Booru meta tags are denylisted out of the artist lists.
- **Phase 4 (`/simple`)** — done. `m_tagdex.js` wraps `MAutoComplete`, shares the same `tagDexCore` singleton, and adds a Characters browse sheet with dataset selection, search, paged results, and tap-to-insert triggers.
- **Phase 5 (thumbnails)** — done. Serving, storage, safe filenames, AnimaDex-folder import, and on-demand **generation** with the user's own model via `T2IEngine.CreateImageTask`. The `anima_styles` dataset ships a real image for every row already; character cards start on the placeholder and fill in as you generate. Four things in `TagDexThumbs.cs` that are load-bearing: `DoNotSave` is set so references never enter the user's image history (we write the file ourselves); the resize uses `ToThumbWebp` for a configured-height WebP instead of upstream's fixed 256px JPEG preview helper; the seed is a SHA-256 hash of the tag name, **not** `string.GetHashCode` (which is per-process randomized in .NET and would give a different image after every restart); and everything serializes behind a single-slot `SemaphoreSlim` so a batch sweep cannot occupy every backend at once. A reference can also be **set** from an image the user already has (`TagDexSetThumbnail`, image-data-string in, shares `WriteThumb` with the generate path) or **deleted** (`TagDexDeleteThumbnail`); both have card buttons.
- **Phase 6 (`anima_styles`)** — done. A fifth dataset, supplied locally rather than downloaded. See below.
- **Phase 7 (favorites)** — done 2026-08-31. Per-user durable favorites, card stars, Favorites-only search, genpage and `/simple` filters, danbooru-only outbound relay, and manage-tier union reconcile are implemented. The separate AnimaDex service now stores global favorites, exposes dev-key-gated list/set endpoints, renders 44px tile stars on phones, and relays idempotent state back to TagDex.

## The `anima_styles` dataset

A local export of the fork owner's own artist-style gallery, ingested as a first-class TagDex source. It is the only dataset with `Url == null` (`TagDexSource.IsDownloadable` is false), so the UI shows it as "supplied locally" instead of offering a dead Download button.

| | |
|---|---|
| Entries | **42,509**, each with a 512×768 WebP style reference — 1:1 coverage |
| Floor | `post_count >= 45` (the raw `danbooru_artist.csv` has 419,789 rows, median count 6) |
| Extra metrics | `uniqueness_score` (0–100 style distinctiveness), `avg_score`, `avg_favs` |
| Cross-links to `danbooru_artist` | 97.4% |
| Load cost | 42,509 rows in ~590 ms, ~6 MB retained |

Four things about it that are not obvious:

1. **Metadata is JavaScript, not CSV.** `Data/TagDex/anima_styles.js` is the gallery's own `app/data.js` copied verbatim — `const galleryData = [ ... ];`. `TagDexAnimaStyles.Parse` slices between the first `[` and last `]` and parses that as JSON. This is why `TagDexSource` carries a `Format` discriminator.
2. **Names arrive already prompt-escaped** — `hammer \(sunset beach\)`, 10,031 of them. That string becomes the `Trigger` untouched, because it is exactly what belongs in a prompt. The search key is the unescaped underscored slug (`hammer_(sunset_beach)`), matching every other dataset's name column, via `TagDexAnimaStyles.ToSlug`.
3. **Images are keyed by numeric booru tag ID and sharded 1,000 per folder** (`thumbs/anima_styles/1/87540.webp`). No name-sanitizing scheme reproduces that, so `TagDexEntry.ThumbPath` carries a pre-resolved relative path for datasets that ship their own images; everything else still resolves by sanitized name. Two consequences: `TagDexData.ThumbsFor` lists **recursively** with forward-slashed relative paths, and the thumbnail route is `/TagDexThumb/{source}/{**file}` — a catch-all, because the path contains a slash.
4. **The sort modes are dataset-conditional.** `uniqueness` and `avg_score` only exist here, so the sources API reports a `scored` flag and the tab hides those options (and falls back to relevance) on datasets that lack them. Offering a sort that silently orders by zero would be worse than not offering it.

### What the source tar did and did not contain

The export was `web-export.tar.gz`, 1.68 GB, two top-level trees:

- `web/anima-styles/` — the payload above. 1.6 GB of the 1.68 GB.
- `web/AnimaDex/` — the AnimaDex **source checkout only**. Its `config.toml` points `data_dir` at `../animadex-data`, a sibling of the repo that was not included, so there is no SQLite DB and **no character thumbnails**. Its `samples/` folder does hold the full noob-wiki CSVs; `danbooru_character.csv` there is MD5-identical (`1347fe05e43bd3070a60aa8c85b7a81c`) to the HuggingFace download, so nothing was gained or lost by using either.

Getting character thumbnails would need a separate export of `animadex-data/characters/thumbs/` — which `TagDexImportThumbnails` already handles, since it matches AnimaDex's `{trigger}.webp` naming.

**Done 2026-08-29.** That export was recovered from the live AnimaDex Docker container (`docker cp animadex:/animadex-data`) rather than the tar — the container had no volume mounts, so all 918 MB of it, the SQLite DB included, existed only in the writable layer. Imported: **34,291 of 36,490** character thumbnails and **15,867 of 15,868** artist thumbnails. The 2,199 remaining characters are not in `danbooru_character.csv` at all — AnimaDex's catalogue is newer than noob-wiki's last publish (both local CSVs hash-match upstream HEAD, so there is nothing to pull). `anima_styles` was installed in the same pass, bringing the totals to **92,669 references on disk** across three datasets.

**Verified on real data**, not just statically: the parser was run against the live 244,932-row `danbooru_character.csv`, all API routes were exercised over HTTP, and every asset route plus the injected tab was confirmed on a running server. Build, `dotnet format --verify-no-changes`, and a headless boot all pass. The browser action pass was completed 2026-08-31; only the physical-device portions of the combined mobile verification remain.

## Why

Anima, IllustriousXL and NoobAI are trained on the Danbooru/e621 tag vocabulary. Summoning a character requires its exact trigger (`hatsune miku, vocaloid`), and lesser-known characters need their core descriptive tags too. SwarmUI had no way to discover or recall either — you memorized them or kept a booru tab open.

## Data

Source: the HuggingFace dataset [`Laxhar/noob-wiki`](https://huggingface.co/datasets/Laxhar/noob-wiki). This is the same dataset [AnimaDex](https://github.com/zetaneko/AnimaDex) is built from — its README names it, and its `samples/characters.csv` rows are byte-identical. We use noob-wiki directly because it is an unauthenticated download, whereas AnimaDex's full catalogue needs an animadex.net account plus a per-user export token with a 48-hour full-pull limit.

Measured by streaming each file:

| Dataset | Rows | count ≥ 50 | count ≥ 100 | CSV size |
|---|---|---|---|---|
| `danbooru_character` | 244,932 | 24,499 | 15,034 | 38.7 MB |
| `danbooru_artist` | 419,789 | 33,058 | 17,002 | 32.6 MB |
| `e621_character` | 288,496 | 13,034 | 5,800 | 28.9 MB |
| `e621_artist` | 205,488 | 17,320 | 9,718 | 13.1 MB |
| **Total** | **1,158,705** | **87,911** | **47,554** | **113.3 MB** |

`count` is the booru post count — the only available proxy for whether a model actually learned a tag. `solo_count` is a better signal for single-subject prompts and is offered as a sort mode.

### Three schemas, one loader

| File | Header |
|---|---|
| `danbooru_character.csv` | `character,copyright,trigger,core_tags,count,solo_count,url` |
| `e621_character.csv` | `character,copyright,trigger,count,solo_count,url` — no `core_tags` |
| `danbooru_artist.csv`, `e621_artist.csv` | `artist,trigger,count,url` |

Parsing is by header name, and absent columns resolve to -1. Trait facets and tag chips therefore exist only for danbooru characters.

## Verified design facts (do not re-derive; re-verify after large upstream merges)

1. **`Utilities.SplitStandardCsv` is unsafe for this data and is deliberately not used.** `src/Utils/Utilities.cs:1407` handles a backslash by advancing the index without appending anything, so it eats the backslash *and* the next character. It also only enters quoted mode after a comma immediately followed by a quote, so a quoted **first** field is unrecognized. Both defects are live in `danbooru_character.csv`: 2 rows carry backslashes (`ursula_(no\name)`), 60 rows start with a quote. `TagDexCsv.cs` is a private RFC-4180 reader instead. **Do not "fix" the core helper** — `AutoCompleteListHelper.GetData` depends on its current behavior, and it would be a core edit for no gain to us.
2. **1,433 rows have a colon in the tag name** (every `re:zero...` entry, and `2b_(nier:automata)`). A colon is illegal in a Windows filename and parses as an NTFS alternate data stream. `TagDexNames.SafeFileName` sanitizes and appends an 8-hex hash **only when sanitization changed the string**, so `re:zero` and `re_zero` cannot collide onto one thumbnail.
3. **73 copyright values contain a forward slash** (`.hack//`, `22/7`, `fate/grand_order`). `GenPageBrowserClass.refillTree` splits folder names on `/` to build its hierarchy, so these would synthesize phantom parent folders. The server emits a U+2215 DIVISION SLASH token and the client keeps a reverse map, so correctness never depends on the glyph.
4. **Ranking must not put raw prefix above word-boundary.** Booru names put the distinguishing word last (`hatsune_miku`, `kirisame_marisa`). Ranking prefix matches above boundary matches surfaced `mikuma_(kancolle)` (1,245 posts) ahead of `hatsune_miku` (103,500) for the query `miku`, and buried `hakurei_reimu` below three obscure entries for `reimu`. Both are treated as equally strong, and post count decides. Mid-word and copyright-only hits stay weak.
5. **Do not merge entries into the `autoCompletionsList` global.** `loadUserData()` rebuilds it from scratch and has **nine** call sites (`main.js` session-ready, `settings_editor.js:232`, `params.js:1105`, four in `presets.js`, `generatecontrols.js:147`). Injected entries would be wiped whenever the user saved a preset or edited a setting. It is also set to `null` outright when no autocompletion source is configured, which is the common case. Wrapping `PromptTabCompleteClass.prototype.getPossibleList` sidesteps all of it — prototype lookup is dynamic, so the already-constructed singleton picks the wrapper up regardless of load order.
6. **The `'tag' in val` key is load-bearing, not cosmetic.** In `prompttools.js` onInput (~366-369) its presence switches the splice anchor from the last `<` to the start of the current word. Without it `index` stays `lastBrace`, which is `-1` when the prompt has no `<` — and `prompt.substring(0, -1)` collapses to `''`, wiping everything before the caret. Conversely the `<character:>` prefix completer must **not** set `tag`, or accepting a suggestion leaves a dangling `<character:`.
7. **`clean` and `clean_html` are mutually exclusive, and which one to use is surface-dependent.** The genpage lets `clean` overwrite `clean_html` (`prompttools.js:363-365`); `/simple`'s `buildChip` reads `val.clean || val.name` and ignores `clean_html` entirely (`m_autocomplete.js:394`). Hence the `plainOnly` flag threaded through `tagDexCore.entryAt`.
8. **Extension tabs auto-wire with zero core edits** — `WebServer.cs:345-359` discovers `Tabs/Text2Image/*.html` for the Text2Image top-level tab strip, registers a `view_extension_tab_{id}` permission, and injects nav item plus pane; a second, sibling block does the identical scan against `Tabs/GenerateBottom/*.html` for the Generate tab's bottom bar, feeding `T2IBottomTabHeader`/`T2IBottomTabBody` instead of `T2ITabHeader`/`T2ITabBody`. `Characters.html` lives in the latter → pane id `characters`, permission `view_extension_tab_characters`.
9. **`ScriptFiles` entries are fetchable by URL**, not only injected — `WebServer.cs:330` adds them to `ExtensionSharedFiles`. That is how `/simple` loads `tagdex_core.js`, since `/simple` builds its own script list and offers no injection hook.
10. **Tag colors are free.** `site.css:807-816` already matches danbooru convention: type 4 = green = character, type 1 = pink = artist, type 3 = purple = copyright.
11. **Lifecycle** (`Program.cs`): `OnPreInit` :309 → `OnInit` :324 → `Web.Prep` :348 → `OnPreLaunch` :351 → `Web.Launch` :355. API calls register in `OnInit`; `MapGet` only works in `OnPreLaunch`. The dataset warm runs on a delayed background task and **must** swallow `OperationCanceledException` — otherwise every CI boot and fast restart logs a spurious internal-task error.
12. Line numbers are anchors, not gospel — re-locate by symbol if upstream shifts code.

## Architecture

Server holds everything; the client gets a threshold-filtered slice for zero-latency typeahead.

- **In memory**: `TagDexEntry` is a 48-byte struct in a flat array, pre-sorted by count descending so the common query needs no sort and paging is a slice. Facets are bitmasks (entries genuinely carry more than one hair color and more than one hair length, so single-valued facets would silently drop data). Copyright strings are pooled through a local dictionary — never `string.Intern`, which would pin them for process life and defeat unloading. The `url` column is not stored; it is derivable and would cost ~23 MB per character list.
- **Measured**: `danbooru_character` at the default resident floor of 20 loads **44,874 of 244,932 rows in ~330 ms, retaining ~19 MB**. Search is 0–16 ms.
- **Client index**: a tab-separated blob served from `/TagDexIndex/{source}/{version}` with `Cache-Control: immutable`, so a repeat visit costs no network. At the default floor of 100 that is 15,034 rows / ~3.1 MB raw. Held as one flat string plus `Int32Array` offsets — a keystroke is one native `indexOf` sweep, not 15k `String.includes` calls, and no per-entry objects are resident.

## File map

```
src/BuiltinExtensions/TagDex/
  TagDexExtension.cs   lifecycle, permissions, asset + route registration, index blob builder
  TagDexCsv.cs         RFC-4180 reader (see fact 1)
  TagDexEntry.cs       entry struct, facet vocabularies, safe filenames, folder tokens
  TagDexData.cs        dataset registry, lazy load, parse, thumbnail listing cache
  TagDexSearch.cs      query struct, scan, ranking
  TagDexAPI.cs         route handlers + per-user prefs
  TagDexFavorites.cs   per-user favorite store + toggle/list/reconcile API routes
  TagDexAnimaDex.cs    outbound image/favorite relay + favorite reconciliation
  TagDexLocal.cs       server-only local config, including AnimaDex credentials
  Assets/tagdex_core.js    shared index, matcher, entry builder (genpage + /simple)
  Assets/tagdex_prompt.js  genpage getPossibleList wrap + <character:> prefix
  Assets/tagdex_tab.js     browse tab
  Assets/tagdex.css
  Assets/m_tagdex.js       /simple MAutoComplete wrap
  Assets/m_tagdex.css      /simple dataset and character-sheet styling
  Tabs/GenerateBottom/Characters.html
```

Data lives in `Data/TagDex/` (CSVs), `Data/TagDex/thumbs/{source}/` (images), `Data/TagDex/imported/` (drop zone).

Permissions: `tagdex_use` (USER) to search, read, and change the caller's own favorites; `tagdex_manage` (POWERUSERS) to download, reload, import, and reconcile against AnimaDex. The reconcile route stays manage-tier because it performs outbound writes; no sessionless route was added.

## Remaining work

1. **Browser pass — complete 2026-08-31.** Against the restarted Release server, the genpage path exercised Regenerate Reference, Use Current Image, and Delete Reference with a byte-for-byte backup/restore of the original card. The batch path queued one isolated placeholder, cancelled after the in-flight request, repainted it, and restored the original. The 430×932 card layout has no horizontal overflow. The LLLite inventory was checked: 12 matching models, 10 classified Anima ControlNet and two older unclassified models; no generation was launched. Physical touchscreen compare gestures remain in the combined device pass with the broader `/simple` and PWA checks.
2. **Batch thumbnail sweep** — done and browser-verified 2026-08-31. A "Generate All Visible" button + Cancel affordance next to the facet row (`Tabs/GenerateBottom/Characters.html`, `tagdex_tab.js`) scans `#tagdex_browser_container .model-block` for cards still showing `TagDexTabClass.PlaceholderImage` and calls `TagDexGenerateThumbnail` once per card, strictly sequentially via recursion (`runBatchStep`) rather than fanning out — required, not just polite, since `TagDexThumbs.cs`'s single-slot `SemaphoreSlim` serializes generation server-side regardless. Cancel sets a flag checked before each step; the in-flight request finishes and repaints its card, and no later card is queued.
3. **`/simple` browse sheet — done, favorites added 2026-08-31.** A guarded call in `m_create.js` mounts Characters beside the model and LoRA pickers. The sheet uses `TagDexListSources` and `TagDexSearchEntries`, prefers the user's active downloaded dataset, loads 50 rows at a time up to 250, and inserts the tapped trigger at the remembered prompt caret. Stars are sibling actions rather than nested buttons, with 44px targets and a Favorites-only filter. `verify-simple-create-panel.mjs` covers the shipped assets and passes 68/68.
4. **Multi-word typing — fixed 2026-08-29.** Both autocomplete hosts still search and replace one space-delimited word, but TagDex now trims an exact already-typed trigger prefix from its inserted value. `hatsune mi` therefore retains `hatsune ` and inserts only `miku, vocaloid`; the existing `miku` → `hatsune miku, vocaloid` path remains unchanged. This is deliberately implemented inside `tagdex_core.js` rather than by wrapping `onInput` or changing `findLastWordIndex`, so the user's stock tag completion keeps its existing splice rules. `verify-simple-create-panel.mjs` proves both paths through the shipped `/simple` autocomplete, and the restarted Release server accepted the multi-word path correctly on both `/simple` and Genpage.
5. **Thumbnail import UI trigger — done (landed in `8f60772a`, live-verified 2026-08-31).** An "Import Thumbnails" button per installed dataset in the manage drawer (`tagdex_tab.js` `addManageButtons`) calls `TagDexImportThumbnails` and reports `Imported N, M unmatched` inline, refreshing the browser when the imported dataset is active. The live empty-folder path reports its outcome instead of looking inert. **The AnimaDex data drop is done as of 2026-08-29** — see "What the source tar did and did not contain" above for counts and provenance.

   One trap that cost a full round trip: `launch-windows.bat:62` only builds when `src/bin/live_release/SwarmUI.exe` is **missing**, so stopping the server and relaunching it silently reruns the old binary. An import re-run against edited matching code returned byte-identical results and looked like a logic bug. Build with `dotnet build src/SwarmUI.csproj --configuration Release -o src/bin/live_release` — the same invocation line 66 uses — whenever a source edit has to go live. Note also that a `///` doc comment is not a usable liveness marker; it never reaches the DLL.
6. **Dead-code sweep — done 2026-08-29.** Removed `TagDexGetEntry` (route + handler, no callers), `TagDexQuery.PrefixOnly` (the typeahead's prefix mode lives client-side in `tagdex_core.js` and never hit the server), and `TagDexVocab.Expand`. `TagDexIndexBlob.Cache` is now evicted per source on `Unload`/`Reload`/re-download via `TagDexIndexBlob.Evict`, so stale-fingerprint blobs no longer accumulate. The Characters tab sort dropdown now exposes "Series A-Z" (`sortBy=copyright`, character datasets only) and a Reverse checkbox (`sortReverse`), both of which the server already supported.
7. **AnimaDex favorite peer — done and deployed 2026-08-31.** The peer stores global favorites in SQLite, exposes dev-key-gated `POST /api/dev/favorite` and `GET /api/dev/favorites?mode=`, and relays explicit state to `TagDexToggleFavorite` with `syncBack=false`. A clean isolated Swarm instance proved AnimaDex-to-TagDex reconcile and TagDex-to-AnimaDex relay against the live peer. `anima_styles` remains local-only because it has no writable AnimaDex counterpart.

## Coupling watchlist — re-check after every upstream merge

| Anchor | Risk if it changes |
|---|---|
| `prompttools.js` `getPossibleList` (~205) | The wrap target. Fails loud — `install()` probes for the method and bails with a console note. |
| `prompttools.js` `onInput` entry contract (~356-408) | `raw`/`name`/`clean_html`/`tag`/`count_display`, and `'tag' in val` as the splice-anchor switch. Could fail **silently**. Highest-priority check. |
| The `<prefix:` gate we duplicate (`prompttools.js` ~274-281) | Four replicated lines. Wrong behavior inside `<lora:` contexts if syntax detection changes. Fails soft. |
| `browsers.js` `GenPageBrowserClass` ctor (:75), `describe` contract (~413-432) | Unconditional `desc.buttons.filter` and `file.data.src`. Breakage is loud. This file is already fork-modified. |
| `browsers.js` `refillTree` `/` splitting (~285-332) | The copyright-slug hazard (fact 3). |
| `browsers.js` `update()` folder-only cache (~246) | Every search/facet change must use `lightRefresh()`, never `update()`, or results go stale within a folder. |
| `browsers.js` `refresh()` (~198-210) and first-build listener registration (~790-814) | After a download of the *active* dataset, `tagdex_tab.js` calls `refresh()` — `lightRefresh()` would leave a stale folder tree for anyone not at root. The `if (!this.hasGenerated)` block is also why the browser is never reconstructed: its document listeners are never removed. |
| `browsers.js` `browserUtil.makeVisible` lazy-reveal contract (`helpers/browsers.js` ~33-52) | The batch sweep's `collectPlaceholderCards` reads `img.getAttribute('src') \|\| img.dataset.src` because an unrevealed card has only the latter, and `repaintCardThumb` mirrors the reveal (`classList.remove('lazyload')` + `delete dataset.src`) so a later reveal pass cannot overwrite a freshly generated thumb back to the placeholder. If the `lazyload` class or `dataset.src` handoff changes, generated references silently revert on scroll and the next sweep regenerates them. |
| `permissions.js` `hasPermission` fail-open before load (:53-56), `gather()` at `setTimeout(0)` (:7-9) | The dataset UI gates on `tagdex_manage`. Genpage is safe (session-ready callback); `/simple` must check at sheet-open, never at row build. |
| `m_ui.js` `registerMoreItem` / `m_app.js` `buildMore` | Fork-owned both sides. If the More tab stops appending `mUI.moreItems`, the `/simple` dataset sheet silently disappears. |
| `WebServer.cs:345-359` tab discovery (`Tabs/Text2Image/*.html`) and its `Tabs/GenerateBottom/*.html` sibling block just below it | Tab silently disappears. |
| `WebServer.cs:330` `ScriptFiles` → `ExtensionSharedFiles` | `/simple` stops loading `tagdex_core.js`. |
| `m_autocomplete.js` `getPossibleList` (~233), `buildChip` (~386) | Fork-owned, so only our own changes can break it. |
| `Utilities.DownloadFile` (`Utilities.cs:707`) | Download progress signature. |
| `T2IEngine.CreateImageTask` (`T2IEngine.cs:187`) | Only matters once thumbnail generation exists. GridGenerator calls the same method, so upstream must fix its own caller first. |

## Verification gate

```bash
dotnet build src/SwarmUI.csproj --configuration Release
```

```bash
dotnet format SwarmUI.sln --verify-no-changes
```

Then a headless boot, then by hand:

- Fresh install, no data — tab renders the empty state, typeahead is silently inert, download buttons are the only affordance.
- Download a dataset; confirm progress and that cancelling mid-download leaves no `.tmp`.
- Type `miku` in the prompt box — green suggestions, `hatsune_miku` first. Accept one; confirm it splices at the word boundary and not at a stray `<`. Repeat with `hatsune mi`; acceptance must produce one `hatsune miku, vocaloid`, not a duplicated name prefix.
- Confirm the stock tag autocomplete still works once a real list is configured in `Data/Autocompletions`, and that both sets interleave.
- Browse tab: facet navigation, search, chips appending single tags.
- Enable an artist dataset; confirm `banned_artist` / `conditional_dnp` / `avoid_posting` are suppressed.
- On-device iOS pass for `/simple`.

## Two-way sync with AnimaDex (2026-08-30)

TagDex and AnimaDex now push images to each other, so a reference generated
on either side appears on both.

**Outbound (TagDex -> AnimaDex).** `TagDexAnimaDex.PushAsync` POSTs to
AnimaDex's `POST /api/dev/ingest` with `{mode, slug, source, image}`.
Wired into both write paths through `WriteThumbAndSync`: the generate route
(`TagDexGenerateThumbnail`) and the set-from-existing route
(`TagDexSetThumbnail`). Fire-and-forget via `Utilities.RunCheckedTask` — a
sync failure never fails the thumbnail that already succeeded.

**Inbound (AnimaDex -> TagDex)** is unchanged: AnimaDex calls
`TagDexSetThumbnail`, which it has always been able to do.

Five things that are load-bearing:

1. **The push sends the pre-downscale image.** `WriteThumb` stores a 445px
   WebP; AnimaDex keeps a full-size PNG and derives its own 297x445 WebP.
   Pushing the thumbnail would cap AnimaDex's quality forever. `WriteThumb`
   does not mutate its argument (`ToMetadataJpg` returns a new file), so the
   original is still in hand at the call site.
2. **`syncBack=false` breaks the cycle.** AnimaDex sets it when calling
   `TagDexSetThumbnail`; without it the image AnimaDex just pushed would be
   pushed straight back to `/api/dev/ingest`, rewriting the source file and
   bumping `image_version` a second time. Verified: a regenerate bumps the
   version exactly once.
3. **Config is a file, not prefs.** See the AGENTS.md row — prefs are
   USER-tier writable and echoed to every browser, so a push target there is
   an exfiltration primitive. `Data/TagDex/local.json` is read
   server-side only and never serialized into a response. It re-reads on
   mtime change, so edits apply without a restart.
4. **Only the danbooru datasets map.** `ModeFor` returns `characters` /
   `artists` for `danbooru_character` / `danbooru_artist` and null for
   everything else. AnimaDex is built from the danbooru CSVs, so e621 and
   `anima_styles` entries have no row there — pushing them would be a
   guaranteed 404 per image.
5. **A 404 from AnimaDex is normal, not an error.** TagDex's datasets are far
   larger; roughly 6% of even the danbooru characters have no AnimaDex row,
   and AnimaDex has no route that creates one. Logged at Debug, not Warning.

Verified end to end 2026-08-30: clicking Generate on a `flandre_scarlet`
card wrote a 16,598-byte TagDex JPEG and pushed an 805,948-byte PNG to
AnimaDex, which built its own 34,690-byte WebP from it.

### Favorites sync (SwarmUI complete 2026-08-31; AnimaDex pending)

Favorites are per-user generic data: one deterministic JSON array under
`tagdex/favorites`, with `source:name` keys. The slug is the identity; no
filename normalization enters this path.

- `TagDexToggleFavorite` toggles for browser clients, or accepts an explicit
  `favorited` value for idempotent peer retries. `syncBack=false` breaks the
  relay loop.
- `TagDexListFavorites` returns one source's slugs. `TagDexSearchEntries`
  filters before paging when `favoritesOnly=true` and marks every returned
  favorite for card rendering.
- Genpage and `/simple` both expose card stars and Favorites filters. The
  `/simple` star is a sibling of the insert action, never a nested button.
  Both phone layouts use 44px targets. On genpage the star occupies its own
  slot beside the browser menu; the first live layout put it underneath the
  menu hitbox, which intercepted every tap.
- `PushFavoriteAsync` posts `{mode, slug, favorited}` using the same dev-key
  header as image sync. `ReconcileFavoritesAsync` unions both sides and
  writes only missing values. Unknown peer slugs are not inserted into the
  local store. Deletes reconcile through live relays, not union.
- Only `danbooru_character` and `danbooru_artist` map. e621 and
  `anima_styles` remain local-only. Toggle/list stay `tagdex_use`; outbound
  reconcile is `tagdex_manage`. No unauthenticated or sessionless route was
  added.

Live verification used a persistent isolated server and the real
244,932-row character CSV: toggle, list, filter, explicit-state idempotency,
new-session persistence, removal, and unknown-slug rejection all passed.
Genpage at 430×932 and `/simple` at 390×844 passed add/filter/remove without
horizontal overflow or TagDex page errors; the 68-check `/simple` harness is
also green.

The configured AnimaDex server now serves both favorite endpoints. Live API
tests covered dev-key rejection, invalid state, unknown slugs, idempotent set,
list, and exact restoration of the probe state. Cross-app validation then set
one AnimaDex favorite, pulled it into an isolated TagDex user through union
reconcile, cleared it from TagDex, and observed the outbound relay clear the
live AnimaDex row. Both sides finished in their original state.

### Thumbnail format: WebP, plus an optional lossless archive (2026-08-30)

Reference thumbnails are **lossy WebP at 445px tall**, not the 256px JPEG
`ImageFile.ToMetadataJpg` produces.

That helper is upstream's *model preview* path: it forces a 256px short side
and hard-codes `ISImgToJpgBytes` / `MediaType.ImageJpg`. Reusing it avoided a
second ImageSharp path, which was a reasonable call — but the cost was never
measured, and on this content it loses on both axes. Measured across five
cards holding both formats, the JPEGs totalled 90 KB against 82 KB of
equivalent WebP: **9% larger while holding fewer pixels** (256px short side
vs 297x445). Anime line art is close to the worst case for JPEG, since flat
colour and hard edges are exactly what DCT ringing damages.

445px is not arbitrary: it matches AnimaDex's `gallery.thumb_height`, so a
896x1344 render reduces to exactly 297x445 on both sides and the two
catalogues hold identically sized images.

**The sibling delete is load-bearing.** `ThumbnailFor` probes `.jpg` before
`.webp`, so any previously written `.jpg` would keep being served and the
format change would look like it did nothing. `WriteThumb` therefore deletes
same-stem `.jpg` and `.png` in the thumbs directory after a successful write.
Only that directory — the originals archive is a separate tree.

**`keep_originals` archives the untouched full-resolution PNG** to
`Data/TagDex/originals/{source}/{name}.png`. The thumbnail is lossy and small
by design; this is the copy to go back to for a different size, a different
format, or the real pixels the model produced. Roughly 0.5–1.5 MB per image,
so it is opt-in. When the source image is already PNG the raw bytes are
stored verbatim rather than re-encoded, so the archive is the generator's
exact output.

**`ToIS` must never be disposed.** It is a cache held on the `ImageFile`
itself (`ImageFile._CacheISImg`), so a `using` on it would leave the same
file unusable for the originals write and the AnimaDex push that follow in
the same call. Only clones are disposed.

Config moved from `Data/TagDex/animadex.json` to `Data/TagDex/local.json`,
which now carries both an `animadex` section and a `thumbnails` section
(`height`, `quality`, `keep_originals`). Same rationale as before: read
server-side only, never serialized into an API response.

Existing `.jpg` thumbnails are left alone and are still served; each is
replaced the next time that entry is generated or set.
