# TagDex

A character/artist/tag reference picker for booru-trained anime checkpoints (Anima, IllustriousXL, NoobAI). Those
models are trained on the Danbooru/e621 tag vocabulary, so summoning a character means knowing its exact trigger —
`hatsune_miku, vocaloid` — which SwarmUI previously had no way to surface. TagDex adds inline prompt typeahead plus
a faceted browse tab, backed by the same tag datasets AnimaDex is built from, each entry carrying a thumbnail where
one is available.

It is the largest fork extension by file count: five source files for data loading and search, three more for the
API surface, thumbnails, and AnimaDex sync, plus the genpage tab and the `/simple` port.

## Datasets

Five datasets, each a `TagDexSource` in `TagDexData.cs`. All of them download and load into
`Data/TagDex/<id>.csv` (or `<id>.js` for `anima_styles`), which is `Program.DataDir/TagDex`:

| ID | Kind | Source | Downloadable |
| --- | --- | --- | --- |
| `danbooru_character` | Character | [`Laxhar/noob-wiki`](https://huggingface.co/datasets/Laxhar/noob-wiki) on HuggingFace | Yes |
| `danbooru_artist` | Artist | `Laxhar/noob-wiki` | Yes |
| `e621_character` | Character | `Laxhar/noob-wiki` | Yes |
| `e621_artist` | Artist | `Laxhar/noob-wiki` | Yes |
| `anima_styles` | Artist | Supplied locally, no download source | No |

`noob-wiki` is the same dataset [AnimaDex](https://github.com/zetaneko/AnimaDex) itself is built from — it is an
unauthenticated download, where AnimaDex's own full catalogue needs an account and an export token. A dataset row
must clear its configured minimum post count (`TagDexPrefs.DisplayMinCount` for what's shown,
`TagDexData.ResidentMinCount` for what's kept in memory at all) to be retained; a fixed artist deny-list
(`TagDexData.ArtistDenyList`) also drops booru meta-tags like `conditional_dnp` that would otherwise dominate any
count-sorted artist list.

`anima_styles` is different in kind, not just in name: it is a curated artist set (42,509 entries) supplied by
copying a gallery export's `app/data.js` verbatim to `Data/TagDex/anima_styles.js`, and it ships a 512x768 style
reference image for every single entry, plus uniqueness and average-quality scores no other dataset carries. There
is no in-app downloader for it — see Gotchas below.

## Where you use it

- **The genpage Characters tab.** Auto-wired from `Tabs/GenerateBottom/Characters.html` into the Generate tab's
  bottom bar (`TagDexTabClass` in `Assets/tagdex_tab.js`, built on the core `GenPageBrowserClass`). Pick a dataset,
  search, filter by hair/eye color, gender, or copyright, browse by copyright folder, and favorite entries. Manage
  buttons here (gated by `tagdex_manage`) download, reload, and unload datasets, import thumbnails, and generate or
  set a reference image per card.
- **The `/simple` Characters sheet.** A separate implementation (`MTagDexClass` in `Assets/m_tagdex.js`) registered
  as its own bottom-nav tab and mirrored as a picker sheet next to the Create panel's model/LoRA pickers, since
  `/simple` shares no code with the genpage.

## Prompt autocomplete splice

Character and artist suggestions ride the *existing* autocomplete popover rather than being merged into the stock
`autoCompletionsList` global — that global is rebuilt from scratch on every `loadUserData()` call (several call
sites across `main.js`, `settings_editor.js`, `params.js`, `presets.js`, and `generatecontrols.js`) and set to
`null` outright when the user has no autocompletion source configured, so anything merged into it would be wiped
constantly. Instead, `TagDexPromptHookClass.install()` (`Assets/tagdex_prompt.js`, genpage) and
`MTagDexClass.install()` (`Assets/m_tagdex.js`, `/simple`) each wrap their surface's
`getPossibleList` prototype method — `PromptTabCompleteClass.prototype.getPossibleList` on the genpage,
`MAutoComplete.prototype.getPossibleList` on `/simple` — calling the original first and then handing its result to
the shared `tagDexCore.augment(...)` to interleave TagDex hits in. Because the wrap is on the prototype, the
already-constructed singleton instance picks it up regardless of load order.

Both surfaces also register an explicit `<character:name>` prompt prefix (with `char` as an alias) through
`registerPrefix`/`registerAltPrefix`, and both defer loading the typeahead index until the first time a prompt box
is focused, so a user who never touches the feature pays no request and no memory for it.

## Thumbnails

Reference images live under `Data/TagDex/thumbs/<source>/`, stored as WebP at a configured height (default
matches AnimaDex's own thumbnail geometry so both catalogues are visually comparable) and quality
(`TagDexLocal.Thumbs()`). A thumbnail can come from three places:

- **Import** — `TagDexImportThumbnails` matches files dropped into `Data/TagDex/imported/` against each entry's
  trigger or name (loosely: underscores, spaces, and filename-illegal characters are all treated as equivalent),
  copying matches into the dataset's thumb folder. This is how an AnimaDex export's on-disk image set gets adopted.
- **Generation** — `TagDexGenerateThumbnail` runs a real generation with the caller's own model and settings,
  prompted with the entry's trigger plus its core tags plus a fixed framing suffix, and a seed derived from a
  SHA-256 hash of the tag name (not `string.GetHashCode`, which is per-process randomized and would give a
  different image every restart). Generations here are marked `DoNotSave` so they never land in the user's image
  history — the extension writes the file itself. Only one generation runs at a time, server-wide, through a
  single-slot semaphore, so a "generate all visible" sweep cannot occupy every backend.
- **Set from an existing image** — `TagDexSetThumbnail` takes an image-data-string directly, for a render the user
  already touched up (inpainted, upscaled) rather than one worth regenerating from scratch.

Both generation and set-from-image also archive the untouched original as lossless PNG under
`Data/TagDex/originals/<source>/` (when `TagDexLocal.ThumbConfig.KeepOriginals` is on) before the WebP is written,
and both push the full-resolution image on to AnimaDex if that sync is configured (see below) — the push happens
before any downscaling, since AnimaDex derives its own thumbnail from what it receives.

`anima_styles` entries resolve differently: their thumbnail path is pre-set at parse time (`TagDexEntry.ThumbPath`,
sharded 1,000-per-folder to match the gallery export's own layout) rather than looked up by sanitized name, which
is why the thumbnail route (`/TagDexThumb/{source}/{**file}`) is a catch-all — those paths contain a slash.

## Favorites and the AnimaDex sync

Favorites are per-user, stored as `source:name` keys in one generic-data blob (`tagdex/favorites`), and are
independent of any external service — TagDex works standalone. When an AnimaDex instance is configured
(`TagDexLocal.AnimaDex()`, server-side only, never exposed through the prefs API), favoriting or unfavoriting an
entry through `TagDexToggleFavorite` also relays that state to AnimaDex, and generating or setting a thumbnail
pushes the image there too. The relay carries a `syncBack` flag specifically to prevent an echo: an image or
favorite state that arrived *from* AnimaDex is written locally with `syncBack=false` so it is never pushed straight
back to the peer it came from. `TagDexReconcileFavorites` does a one-time union of local and remote favorites for
a dataset, repairing anything a dropped fire-and-forget push may have lost — only `danbooru_character` and
`danbooru_artist` have an AnimaDex counterpart to reconcile against.

## Permissions

Defined in `TagDexExtension.cs`:

| ID | Default | Covers |
| --- | --- | --- |
| `tagdex_use` | USER | Searching and reading the datasets — a read-only local lookup. |
| `tagdex_manage` | POWERUSERS | Downloading datasets (up to ~113 MB of bandwidth), reloading them, unloading them, importing thumbnails, generating or setting a reference thumbnail, and reconciling AnimaDex favorites. |

`TagDexDeleteThumbnail` is registered under `tagdex_manage` as well. Every other route below is gated by
`tagdex_use`.

## API routes

All registered in `TagDexAPI.cs`, `TagDexFavorites.cs`, and `TagDexThumbs.cs` via `API.RegisterAPICall`:

| Route | Purpose |
| --- | --- |
| `TagDexListSources` | Lists every known dataset with its presence, load state, row counts, and staleness. |
| `TagDexSearchEntries` | Faceted, paged search over one dataset. |
| `TagDexGetFacets` | Returns the facet vocabularies and the copyright rollup for one dataset. |
| `TagDexGetPrefs` | Reads the caller's TagDex preferences. |
| `TagDexSetPrefs` | Saves the caller's TagDex preferences. |
| `TagDexToggleFavorite` | Toggles (or sets) one favorite for the caller, optionally relaying it to AnimaDex. |
| `TagDexListFavorites` | Lists the caller's favorited slugs for one dataset. |
| `TagDexDownloadSource` | Downloads one dataset CSV from HuggingFace, with websocket progress updates. |
| `TagDexReloadSource` | Re-parses one dataset from disk. |
| `TagDexUnloadSource` | Drops one dataset from memory. |
| `TagDexImportThumbnails` | Imports thumbnails dropped into the import folder into a dataset's thumb store. |
| `TagDexGenerateThumbnail` | Generates a reference thumbnail with the caller's own model, streaming progress. |
| `TagDexSetThumbnail` | Sets a reference thumbnail from an image the caller already has. |
| `TagDexDeleteThumbnail` | Deletes a generated thumbnail. |
| `TagDexReconcileFavorites` | Unions the caller's local favorites with the configured AnimaDex instance. |

Two more routes are plain `WebServer.WebApp.MapGet` handlers, not API calls: `/TagDexIndex/{source}/{version}`
serves the lean typeahead index as an immutably-cached, tab-separated blob, and `/TagDexThumb/{source}/{**file}`
serves one thumbnail image out of the data folder.

## Browsing on `/simple`

The Characters tab and the Create-panel Characters sheet share their controls, so the two never drift apart. The
dataset picker and search sit on one row; the favourites filter, a sort dropdown and a layout toggle sit on the
next, wrapping to another line on a narrow phone.

Sort offers the same modes as the genpage tab, with the same server values: Best Match (`relevance`), Most Posts
(`count`), Most Solo Posts (`solo_count`), Most Distinctive Style (`uniqueness`), Highest Quality Score
(`avg_score`), Name A-Z (`name`) and Series A-Z (`copyright`). The two score modes are hidden unless the active
dataset carries scores, and Series is hidden for artist datasets, since artist rows have no copyright to sort on.
Selecting a hidden mode's dataset falls back to Best Match rather than sorting by a field of nulls.

The layout toggle cycles list, two columns and three columns. Both the sort mode and the layout persist in
browser storage under `m_client_tagdex_sort` and `m_client_tagdex_view`.

## Gotchas

- **`anima_styles` cannot receive pushes.** Its entries resolve their thumbnail by a pre-set path
  (`TagDexEntry.ThumbPath`), and `ServeThumbnail` never runs the sanitized-name lookup for that case — a write is
  accepted and reported as success, but it is never served. `TagDexDownloadSource` also refuses this source
  outright, since it has no `Url`.
- **Never call `TagDexDeleteThumbnail` to clear a generated image.** It deletes `.jpg`, `.webp`, *and* `.png` for
  the entry's stem — which also destroys an imported original underneath, since the archive and the served thumb
  share the same stem-matching scheme.
- **Never rebuild a thumbnail URL client-side from a slug.** Thumbnail resolution depends on which of several
  extensions is actually present on disk (and, for `anima_styles`, on a sharded path with no naming convention at
  all) — call `TagDexSearchEntries` and use the server-supplied `thumb` field on each result rather than guessing
  a path.
- **Editing `tagdex_*.js` or `m_tagdex.js` does nothing on a Release server until it restarts.** Release caches
  every extension asset in memory permanently (`WebServer.ViewExtensionScript`); a hard refresh alone will keep
  serving the old copy. Restart the server, then hard-refresh — and commit the edit first, since the cache-busting
  `?vary=` query string is derived from the git commit and does not move for uncommitted changes either.

## Fork notes

Zero core-file edits. Routes register through `API.RegisterAPICall`, the two raw HTTP routes through
`WebServer.WebApp.MapGet` in `OnPreLaunch()`, and the genpage tab through the `Tabs/GenerateBottom/*.html`
auto-discovery mechanism.
