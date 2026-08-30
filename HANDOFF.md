# HANDOFF

**Updated:** 2026-08-28 · **Branch:** main · **Base:** 8ed7c3da (= origin/main at sweep start) · **Committed locally, NOT pushed**

> Line cap intentionally bypassed. This is the full record of the mobile-PWA performance sweep: what shipped,
> why each change is shaped the way it is, the six defects that verification caught before they landed, and the
> complete parked backlog. Written so an agent can pick this up cold.

## State

A mobile-PWA performance pass is committed on `main` in five commits, none pushed. Pushing requires the
`/clean` skill per fork law.

Gates green on the merged tree: `dotnet build SwarmUI.sln --configuration Release` = 0 warnings / 0 errors;
`dotnet format --verify-no-changes` and `dotnet format style --verify-no-changes` clean; `node --check` clean
on all six touched JS files. Group A additionally passed a live-boot HTTP header matrix (Release DLL, scratch
`--data_dir`, port 7902). **Nothing in this sweep has been exercised in a real browser, and nothing has been
tested on a phone.** That is the largest outstanding risk — see Open.

## What was wrong (the audit)

The genpage ships ~48 JS + ~10 CSS files, ~2.0 MB uncompressed, unbundled and unminified. Every URL is
already fingerprinted with `?vary=<version>.GIT-<hash>`. The audit found that fingerprinting was buying
almost nothing, and that the PWA path specifically was the worst-served one:

- Compression was **off** on the only path the PWA can use. `AddResponseCompression()` was called bare, and
  .NET defaults `EnableForHttps` to false. `mobile_core.js` refuses to register the service worker outside a
  secure context, so an installed PWA is always HTTPS — and was always pulling the full ~2 MB uncompressed.
- Nothing set `Cache-Control`. Static files got only `ETag`/`Last-Modified`, so browsers issued ~55
  conditional requests per warm load; `/ExtensionFile/` sent no caching headers **at all**, returning a full
  200 body for all 16 extension assets on every single load.
- The service worker treated JS/CSS as network-first, so the installed app re-fetched all ~58 files per load
  anyway, and `/view/` thumbnails were in the pass-through list — never cached.
- PWA icons totalled 449 KB (a 512×512 at 230 KB), upscaled from `favicon.ico`.
- The current-session batch strip requested **full-resolution** images for ~10rem-wide thumbnails, while the
  history browser next to it correctly used 256px previews.
- A 1 Hz server-status poll was armed on every page load whether or not the Server tab was ever opened.

## Landed this sweep

### Commit A — `src/Core/WebServer.cs`
- **Compression over HTTPS.** `AddResponseCompression()` takes the options form: `EnableForHttps = true`,
  plus `image/svg+xml` and `application/manifest+json` on the MIME list. (`text/javascript` was also added but
  is already a default — harmless.) Middleware order untouched.
- **Static-file caching.** `UseStaticFiles` gained `OnPrepareResponse`: `?vary=` present →
  `public, max-age=31536000, immutable`; otherwise `public, max-age=3600`.
- **Extension-asset caching.** `ViewExtensionScript` sets the same pair (`immutable` / `max-age=86400`) in
  both success branches via a small private helper. 404 branch stays header-free.
- Verified live: `/js/site.js?vary=x` returns `Content-Encoding: br` **and** the immutable header; the bare
  URL returns `max-age=3600`; `/ExtensionFile/...` behaves the same way at 86400; a bogus extension path
  still 404s with no cache header. `EnableForHttps` itself is code-verified only — a local HTTP boot cannot
  exercise it, and Kestrel here configures no HTTPS endpoint (TLS terminates at `tailscale serve`).

### Commit B — MobileEnhancements service worker + icons
- **Cache-first for fingerprinted URLs.** Any request carrying `?vary=` is served cache-first from the
  versioned static cache. Safe because a new commit changes both the URL and the cache name.
- **Thumbnail runtime cache** (plan doc Phase 4 item 4). `swarm-thumb-v1`, deliberately unversioned so
  thumbnails survive a version bump, 50-entry cap, stale-while-revalidate, intercepting
  `/view/*?preview=true` ahead of the pass-through list, added to the `activate` keep-list.
- **Icons regenerated:** 449 KB → **102 KB** (icon-512 230 KB → 40 KB; apple-touch 45 KB → 13 KB). The
  apple-touch `<link>` href now carries `?vary=` so it rides the immutable path from Commit A.

### Commit C — mobile viewer + first-run toast (extension-only, zero core edits)
- **Adjacent-image preload** (plan doc §2b, spec'd long ago, never built). Resolves ±1 neighbours the same
  way `shiftToNextImagePreview` does, warms them via detached `Image()` objects held on the instance, skips
  placeholders/`data:`/video/audio, guarded on `document.hidden` and coarse pointer.
- **In-viewer Share** via `navigator.share`: `fetch` → `File` → `canShare`/`share({files})`, falling back to
  `share({url})`. `AbortError` swallowed (that is the user cancelling); other failures go to `showError`.
- **First-run toast** pointing at the User tab's Mobile/Desktop dropdown. Standalone + small-window +
  genpage-only + one-shot localStorage flag, set the instant it decides to show. Never changes a setting.
- All three are gated so the DOM elements are **never instantiated** on desktop, not merely hidden.

### Commit D — core genpage JS (user-approved new fork divergence)
- **Batch strip uses 256px previews.** New `getThumbnailSrc()` helper; `appendImage`'s plain-image branch and
  `setImageFor`'s in-place preview→final swap both use it, plus `loading = 'lazy'`. **`dataset.src` stays
  full-resolution everywhere**, which is what every click / full-view / star / reuse / delete path reads.
- **Server-status loop armed lazily** on first `shown.bs.tab` of the Server tab (plus immediately if that tab
  is already visible), instead of unconditionally at session-ready. Never disarms, so steady state is
  unchanged.

### Commit E — docs
`AGENTS.md` Fork Delta gained entries for the WebServer.cs hunks, the two new core-JS touchpoints, and the
MobileEnhancements perf pass. `docs/MobilePWA-Optimization-Plan.md` marks §2b, §2c-share, Phase 4 item 4 and
Phase 5 item 3 as shipped, and annotates the stale `layout.js:465` citations.

## Defects verification caught

Every one of these passed the author agent's own gates and would have shipped. Recorded because each is a
trap the next person can repeat, not merely a bug that got fixed.

1. **Batch-strip navigation was silently dead** (`currentimagehandler.js`). The matcher compares the main
   image's `.src` against strip elements. The `.src` IDL getter always returns a **resolved absolute** URL;
   `dataset.src` holds the **raw relative** string. The delivered fallback clause compared one against the
   other, so it could never match — and the original clause had stopped matching the moment thumbs gained
   `?preview=true`. Result: `index == -1` on every finished image, killing arrow-key navigation, full-view
   next/prev, and delete-then-shift. It survives a casual smoke test because live `data:` previews get no
   `?preview=true`, and the non-default `AppendUserNameToOutputPath=false` config produces `Output/…` srcs
   the helper skips. **Fix:** compare raw to raw (`curImgElem.dataset.src` vs `block.dataset.src`), keeping
   the resolved-URL clause first.
2. **Unguarded `cache.put` on the thumbnail miss path** (`sw.js`). The hit path had a `.catch`; the miss path
   did not. A `QuotaExceededError` therefore rejected `respondWith`, which the browser surfaces as a network
   error — turning a *successfully fetched* thumbnail into a broken image. It also made every uncached
   thumbnail wait on a disk write plus a burst of sequential deletes before displaying. Related: the
   background revalidate was not tied to `event.waitUntil`, so iOS could kill the worker before the cache was
   ever written.
3. **One cache, two entry ceilings** (`sw.js`). The new cache-first branch pointed `cacheFirst` at
   `CACHE_STATIC` while it still trimmed to `MAX_ASSET_ENTRIES` (120); `networkFirst` trims the same cache to
   80. The page emits ~55 fingerprinted assets, so this thrash cycle was in live range, not theoretical.
4. **Maskable icon glyph pushed outside the safe zone.** The regeneration was not a pure recompression — it
   enlarged the glyph ~11%, putting 3.14% of glyph pixels past the **circular** 80% safe radius (vs 0.18%
   before), where an Android launcher mask would shave the wing corners. Requantizing the original art
   instead restored the proven framing *and* came out 14 KB smaller.
5. **Share button's `touchend` called `preventDefault()`**, which kills the synthetic click — and that click
   is the only thing that ever resets core's `noClose` flag. Every share would have silently swallowed the
   user's next tap-outside-to-close. Replaced with a self-clearing flag set on `pointerdown`.
6. **Preload silently no-opped for every batch image**, having copied the pre-change matcher line and hit the
   same absolute-vs-relative mismatch as defect 1.

## Open

1. **Restart the server, don't just refresh.** `WebServer.ExtensionAssets` holds each extension asset in a
   `LazyOrReusable` that reads the file once per process lifetime, so extension JS/CSS edits are invisible
   until a restart. Then hard-refresh (Ctrl+Shift+R) — `?vary=` is the commit read at startup.
2. **The desktop-browser mobile pass has started; the phone/PWA pass has not.** `/simple`'s compact controls
   and TagDex sheet were exercised against the restarted Release server at a 430px viewport. Highest-value
   remaining checks, in order: batch-strip thumbnails still navigate with arrow keys and swipe (defect 1's
   blast radius); the Share button on a real iOS/Android device; the thumbnail cache surviving an offline
   reload; the first-run toast firing exactly once and never on `/simple`; the icons in an actual installed-
   app launcher.
3. **TagDex browser pass partially complete 2026-08-29.** The Characters tab first-opened against Danbooru,
   reflowed without horizontal overflow, and inserted a card trigger into the prompt. The per-card action
   menu exposed Insert, Generate, use-current, delete, and source-link actions. Side-effecting Generate /
   use-current / delete requests, the batch sweep + Cancel, LLLite models, and touchscreen image-compare
   gestures remain unexecuted.
4. **Re-run the prompts that reliably went black.** If they recur with the DiT in bf16, the next suspect is
   `comfy-aimdo` (DynamicVRAM, async weight offloading) — not audited.
5. **Scope gap in the thumbnail change.** With `Paths.AppendUserNameToOutputPath = false`, srcs are `Output/…`
   and `getThumbnailSrc` skips them, so the optimization silently does nothing in that config. The server
   would honour previews there; extend the helper if that config ever matters here.
6. **Parked backlog** (corrected — the previous handoff listed several already-shipped items): the prompt
   coach (`docs/SimplePromptCoach-Plan.md`, wholly unstarted), Phase 5 item 1
   (Simple tab as mobile home), §3.3 sidebar swipe animation (**premise stale** — the `layout.js:465` TODO it
   was written against no longer exists), §2c full overlay chrome, server-reachable-but-app-down detection.
   Haptics, wake-lock, manifest shortcuts and the SW thumbnail cache are all **shipped** and should stop
   being listed as parked.
7. **Implemented 2026-08-29; desktop-browser pass complete.** `/simple` now has one combined final-resolution
   picker, paired Architecture/Preset picklists, Random-to-explicit seed editing, exact 0.05 LoRA weight
   controls, and the TagDex Characters browse sheet. Deleting the current genpage image now falls back to
   the newest surviving current-session image, then blank. The opt-in Playwright suite is 237/237 green;
   the restarted Release server confirmed the controls, source selection, first 50 character cards, prompt
   insertion, and LoRA increment/removal paths at a 430px viewport. Physical-device coverage remains open.
8. No auth is configured on this install.

## Findings recorded, no action taken

- **TagDex vs upstream's `ApplyDownloadAPIKey` is not a bug.** `AGENTS.md` carries a watch item that upstream
  now returns early when `session?.User is null`, dropping the `civitai.com` → `civitai.red` rewrite, and
  TagDex's download call passes no session. Investigated: every TagDex dataset URL is a public
  `huggingface.co/datasets/…`, so that rewrite never applied and the skipped HF auth header is not needed.
  The watch item still stands for other callers.
- **The 50 ms spinner interval was left alone deliberately.** The audit proposed replacing it with a CSS
  animation. Upstream moved *off* CSS animation for measured GPU cost — see the comment in
  `ui_improvements.js` directly above it. Changing it would contradict upstream's data with none of our own.
- **Mobile scripts loading on desktop was left alone.** Five MobileEnhancements scripts (29.5 KB of touch
  handling among them) inject into every genpage load. Gating is not feasible without core rearchitecture:
  extension script tags are baked into a static string at startup. Mitigated anyway — they are `defer`red and
  now immutable-cached.

## Traps

- **`.src` returns an absolute URL; `dataset.src` holds a relative one.** Never compare across the two. This
  is defect 1 and defect 6, both from the same mistake in the same sweep.
- **`immutable` sharpens an existing caveat.** An extension asset edited without a new commit keeps its
  `?vary=` token. Previously a plain F5 revalidated off `Last-Modified` and picked the edit up; now it will
  not for a year. Hard-refresh still works, and the documented workflow was already restart-then-hard-refresh
  — worse in degree, not in kind. `#if DEBUG` re-reads per request but the browser no longer re-asks.
- **The service worker's `image/*` Content-Type guard is load-bearing.** `/View` serves `.mp4` with range
  processing, and `?preview=true` is appended to every history file including video. That guard is the only
  thing stopping a cached 200 being handed to a Range request and breaking video seeking. Do not loosen it.
- **A maskable icon's safe zone is a circle, not a box.** Clearing the 80% box is not sufficient.
- **`shown.bs.tab` never fires for a Generate-tab-bar tab** — those nav links are wrapped in `MovableGenTab`,
  which strips `data-bs-toggle` and handles clicks itself. `#toptablist` and `#servertabbutton` *are* plain
  Bootstrap tabs, which is why the Commit D change works there. Also depends on Bootstrap 5 dispatching that
  event natively; Bootstrap 4's jQuery-triggered version would not reach `addEventListener`.
- **Revealing a lazyloaded thumbnail takes three writes, not one** (`src`, remove `.lazyload`, delete
  `dataset.src`) — `makeVisible` re-asserts `src` from `dataset.src` on scroll otherwise.
- **A pinch always begins as a single touch.** Any touch layer taking state on finger 1 must release it when
  finger 2 arrives.
- Carried forward: `\s` in `Data/Settings.fds` paths is FDS escaping, not corruption. A running server locks
  the exe and owns the settings file — stop it with the `ShutdownServer` API, not a kill. A `JObject` API
  parameter receives the whole request payload, not the field matching its name.

## Verify

```powershell
dotnet build SwarmUI.sln --configuration Release
dotnet format --verify-no-changes
dotnet format style --verify-no-changes
node --check src/BuiltinExtensions/MobileEnhancements/Assets/sw.js
node --check src/BuiltinExtensions/MobileEnhancements/Assets/mobile_core.js
node --check src/BuiltinExtensions/MobileEnhancements/Assets/mobile_fullview_touch.js
node --check src/wwwroot/js/genpage/gentab/currentimagehandler.js
node --check src/wwwroot/js/genpage/helpers/generatehandler.js
node --check src/wwwroot/js/genpage/server/servertab.js
# Header matrix (live boot; GET not HEAD - MapGet routes may not answer HEAD):
#   dotnet build src/SwarmUI.csproj -c Release -o src/bin/live_release
#   src/bin/live_release/SwarmUI.exe --data_dir <scratch> --port 7902 --launch_mode none
#   curl -sD - -o /dev/null -H "Accept-Encoding: gzip, br" "http://localhost:7902/js/site.js?vary=x"
# No automated tests. The launcher needs -o src/bin/live_release, not the default output dir.
```
