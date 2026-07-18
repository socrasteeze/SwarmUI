# Mobile/PWA Optimization Plan (Fork)

Implementation handoff document for making SwarmUI feel robust, fluid, and intuitive on mobile and as an installed PWA, on this fork (socrasteeze/SwarmUI). Written so a coding agent (or human) can implement it phase-by-phase without re-doing the research.

Read `CLAUDE.md` and `AGENTS.md` first. All work follows the fork's merge-friendly policy: **zero edits to existing core files** — every change below is a new file.

## Implementation status (living)

Phases 1–4 are **implemented** in `src/BuiltinExtensions/MobileEnhancements/` with zero core-file edits, as designed. What shipped vs. what was intentionally deferred/changed:

- **Phase 1 (PWA scaffold + service worker)** — done. `MobileEnhancementsExtension.cs` maps root `/manifest.json` + `/sw.js` and injects head tags in `OnPreLaunch`; `sw.js` (network-first HTML/JS/CSS, cache-first static, offline fallback), `mobile_core.js` (viewport fix, SW registration, standalone/coarse-pointer flags, keyboard handling), `mobile.css`, and icons generated from `favicon.ico`.
- **Phase 2 (image viewer)** — done. `mobile_fullview_touch.js`: pinch/pan/double-tap zoom, horizontal swipe navigation driving the core `shiftToNextImagePreview`, swipe-down dismiss, tap toggles metadata. **Deferred within Phase 2**: the full custom action-overlay chrome and in-viewer Share button (§2c) — instead, tap-on-image toggles the existing metadata/undertext (which already holds the per-image action buttons), and tap-outside closes. Share via `navigator.share` remains a clean follow-up. `ImageCompareHelper` touch parity also still TODO.
- **Phase 3 (layout & ergonomics)** — mostly done: 44px touch targets, horizontally-scrollable tab strips, pull-to-refresh suppression, momentum scroll, visualViewport keyboard-avoidance, PWA safe-area padding. **Deferred**: the sidebar open/close swipe **animation** (§3.3) — it is too tightly coupled to `layout.js`'s eval-based inline sizing to ship without live device testing; revisit with a browser in hand.
- **Phase 4 (network resilience)** — done, with one deliberate design change: instead of **wrapping** the core `genericRequest`/`makeWSRequest` (fragile, and unverifiable without a running server), the connection banner is driven by the browser `online`/`offline` events (robust, decoupled, covers the primary mobile network-drop case). Haptics (batch MutationObserver) and screen wake-lock during generation shipped as planned. Server-reachable-but-app-down detection is a possible future add via light request wrapping.
- **Phase 5** — not started (optional enhancements).
- **Civitai share-to-download** — done. `manifest.json` declares a `share_target` (GET, params `url`/`text`/`title`); `MobileEnhancementsExtension.cs` maps a root `/ShareTarget` route (same pattern as `/manifest.json`) that pulls a Civitai URL out of the shared fields and redirects to `/Text2Image#downloadmodel=<encoded url>`; `mobile_share.js` (new `ScriptFiles` entry) reads that hash flag on session-ready, opens the Utilities > Model Downloader tab, and prefills + `triggerChangeFor`s the URL field so Civitai metadata auto-loads. Fail safe: a non-Civitai (or absent) link lands on the downloader empty. This couples to the downloader's DOM IDs — see the watchlist.

**Verification owed (blocking real use):** the authoring environment's egress policy blocked the .NET SDK download, so `dotnet build`, `dotnet format --verify-no-changes`, and the ci-test boot could **not** be run. Verification so far is static analysis + `node --check` on all JS + JSON validation + cross-file asset-URL consistency. Before relying on this, run the full gate below on a real machine and do the mobile browser checks (Lighthouse PWA audit, DevTools device emulation, and a real phone for the touch viewer).

## Why

Current state (as of the audit on upstream-equivalent master, 2026-07):

- **No PWA support at all**: no web manifest, no service worker, no `theme-color`/`apple-mobile-web-app-*` meta tags, only a 128×128 `favicon.ico`.
- **Pinch zoom is blocked globally** by `maximum-scale=1.0` in the viewport meta (`src/Pages/Shared/_Layout.cshtml:5`).
- **The fullscreen image viewer is mouse-only** (`ImageFullViewHelper` in `src/wwwroot/js/genpage/gentab/currentimagehandler.js`): wheel zoom + mouse pan, zero touch handlers.
- **Responsive layout is JS-driven, partial**: `body.small-window`/`large-window` classes from `js/genpage/gentab/layout.js` (auto = `innerWidth < 768`, or the User-tab Mobile/Desktop dropdown); only 2 `@media` queries in all CSS; sidebar swipe gestures exist but with a known TODO ("Mobile bar shuts need a smooth animation", `layout.js:465`).
- **No network resilience**: no offline handling, no reconnect backoff, no connection status UI — painful on flaky mobile connections.

## Verified design facts (do not re-derive; re-verify only after large upstream merges)

1. **`src/Extensions/` is gitignored** (`.gitignore:22`) and excluded from compile (`SwarmUI.csproj`). Fork-tracked extension code must live in **`src/BuiltinExtensions/<Name>/`** — a plain folder with `.cs` files (no `.csproj`), auto-discovered by `ExtensionsManager.PrepExtensions()` (`src/Core/ExtensionsManager.cs`, enumerates `./src/BuiltinExtensions`), compiled into the main assembly. Structural template: `src/BuiltinExtensions/GridGenerator/`.
2. **Lifecycle order** in `src/Core/Program.cs`: `Web.Prep()` (line ~348) → `Extensions.RunOnAllExtensions(e => e.OnPreLaunch())` (line ~351) → `Web.Launch()` (line ~355). Therefore an extension's `OnPreLaunch()` can:
   - **Map root-scoped routes**: `WebServer.WebApp` is `public static WebApplication` (`WebServer.cs:25`) → `WebServer.WebApp.MapGet("/sw.js", ...)`. A root-scoped service worker needs no core edit and no `Service-Worker-Allowed` header.
   - **Inject `<head>` HTML on every page**: `WebServer.PageHeaderExtra` is `public static HtmlString` (`WebServer.cs:77`), populated during `Prep()` (`WebServer.cs:362`), rendered at `_Layout.cshtml:25`. Append via `WebServer.PageHeaderExtra = new(WebServer.PageHeaderExtra.Value + "...");`.
3. **Extension asset plumbing** (`src/Core/Extension.cs`): `ScriptFiles` (JS injected on the genpage after all core scripts, before `finalscript.js` — extension JS can rely on core globals), `StyleSheetFiles` (CSS in `<head>` on all pages), `OtherAssets` (static files served at `/ExtensionFile/<ExtName>/<path>`).
4. **JS hook arrays** extension scripts can push to: `sessionReadyCallbacks` (`js/genpage/main.js:13`), `featureSetChangedCallbacks` (`main.js:35`), `postParamBuildSteps` (`js/genpage/gentab/params.js:2`), `hideParamCallbacks` (`params.js:1228`).
5. **`ImageFullViewHelper`** (`currentimagehandler.js`, ~lines 3-377): global instance `imageFullView`; primitives `detachImg()`, `moveImg(dx,dy)`, `getImg()`; zoom math in `onWheel` (~lines 176-203); `noClose` flag suppresses the modal-close click handler. `ImageCompareHelper` (~line 1413) follows the same mouse-only pattern.
6. **Viewport meta** can be fixed by runtime JS mutation of the meta tag (browsers honor dynamic viewport changes) — no `_Layout.cshtml` edit needed.
7. **Networking**: `site.js` globals `genericRequest` (JSON POST) and `makeWSRequest` (WebSocket per long op) are plain global functions — wrappable by reassignment.
8. Line numbers above are anchors, not gospel — re-locate by symbol name if upstream shifts code.

## End-state fork delta

```
CLAUDE.md                                      (done)
docs/MobilePWA-Optimization-Plan.md            (this file)
src/BuiltinExtensions/MobileEnhancements/**    (new directory — all phases below)
```

No existing file is modified; behavioral couplings are tracked in the watchlist at the bottom.

---

## Phase 1 — Extension scaffold + PWA installability + service worker

New directory:

```
src/BuiltinExtensions/MobileEnhancements/
├── MobileEnhancementsExtension.cs
├── README.md                      (what this is, how to replace icons, coupling notes)
└── Assets/
    ├── manifest.json
    ├── sw.js
    ├── offline.html
    ├── icons/  icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon-180.png
    ├── mobile_core.js
    └── mobile.css
```

**`MobileEnhancementsExtension.cs`** — namespace `SwarmUI.Builtin_MobileEnhancementsExtension`, `class MobileEnhancementsExtension : Extension` (model on `GridGeneratorExtension.cs`; `///` docs on all members, no `var`):

- `OnInit()`: register `ScriptFiles` (`Assets/mobile_core.js`), `StyleSheetFiles` (`Assets/mobile.css`), `OtherAssets` (icons, `offline.html`).
- `OnPreLaunch()`:
  - `WebServer.WebApp.MapGet("/manifest.json", ...)` → serve `{FilePath}Assets/manifest.json` as `application/manifest+json`.
  - `WebServer.WebApp.MapGet("/sw.js", ...)` → read `Assets/sw.js`, prepend `const SWARM_VARY = '<Utilities.VaryID>';` (so cache names roll on each server version), serve as `text/javascript` with `Cache-Control: no-cache`.
  - Append to `WebServer.PageHeaderExtra`: `<link rel="manifest" href="/manifest.json">`, `<meta name="theme-color" content="...">` (read the actual background color from `src/wwwroot/css/themes/modern_dark.css` during implementation), `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style` (black-translucent), `mobile-web-app-capable`, `<link rel="apple-touch-icon" href="/ExtensionFile/MobileEnhancements/Assets/icons/apple-touch-icon-180.png">`.

**`manifest.json`**: name/short_name "SwarmUI", `start_url: "/Text2Image"`, `scope: "/"`, `display: "standalone"`, colors matching modern_dark, icons array including a `purpose: "maskable"` 512.

**Icons**: generate from `src/wwwroot/favicon.ico` (extract the largest frame with ImageMagick, upscale to 192/512; maskable = glyph padded to ~80% safe zone on the theme background). Note in the extension README that a higher-res source image is a drop-in replacement later.

**`sw.js`** (~120 lines, no libraries, GET-only):

- Cache names suffixed with `SWARM_VARY`; `activate` deletes old-suffix caches.
- Never intercept: `/API/`, `/View/`, `/ViewSpecial/`, `/Output/`, `/Audio/` (pass through).
- Navigations: network-first; on failure serve precached `offline.html`.
- JS/CSS/HTML (including `?vary=` URLs): **network-first with cache fallback** — never serve cache when the network succeeds, so stale-JS bugs are impossible; the cache only helps when fully offline.
- `imgs/`, `fonts/`, extension icons: cache-first.
- No push, no background sync.

**`mobile_core.js`** — class-based singleton `mobileEnhancements` (per convention):

- On load, mutate the viewport meta to `width=device-width, initial-scale=1.0, viewport-fit=cover` (drops `maximum-scale=1.0` → restores Android pinch zoom; `viewport-fit=cover` enables iOS `env(safe-area-inset-*)`). Companion CSS: under `body.small-window`, inputs/textareas/selects in the param + prompt areas get `font-size: 16px` (prevents the iOS focus auto-zoom that `maximum-scale` was masking).
- Register the SW (`'serviceWorker' in navigator` guard).
- Add `body.pwa-standalone` class when `matchMedia('(display-mode: standalone)')` matches or `navigator.standalone` is set.

**`mobile.css` (phase-1 minimum)**: safe-area (`env(safe-area-inset-*)`) padding for the top tab bar / bottom bar under `body.pwa-standalone`; `100dvh` overrides scoped to `body.small-window` for the main containers (exact selectors from `genpage.css` during implementation; class selectors only).

## Phase 2 — Mobile image viewer overhaul (touch gestures + seamless swipe navigation)

Goal: the fullscreen image experience on mobile should feel like a native photo gallery — pinch/pan/double-tap zoom, horizontal swipe to move seamlessly between images, swipe-down to dismiss, and a clean tap-to-toggle action overlay.

New file `Assets/mobile_fullview_touch.js` (added to `ScriptFiles`; loads after `currentimagehandler.js`, so `imageFullView` exists). Approach: **augment the existing `ImageFullViewHelper` modal** (not a parallel viewer) with a mobile gesture + chrome layer, active only when `body.small-window` or `(pointer: coarse)`. Use additive `touchstart/touchmove/touchend/touchcancel` listeners (`{passive: false}`; touch events rather than pointer events, to avoid interfering with the existing mouse handlers — matches the `image_editor.js` precedent) on the fullview modal content.

### 2a — Core touch gestures

- **One-finger pan**: `imageFullView.detachImg()` + `moveImg(dx, dy)`; if cumulative movement > threshold, set `imageFullView.noClose = true` so a drag doesn't close the modal; a genuine tap still closes (preserves current UX until 2c replaces tap behavior on mobile).
- **Two-finger pinch**: implement `zoomAt(clientX, clientY, factor)` replicating the `onWheel` math (height-percent zoom, clamp to `Math.sqrt(w*h)*2`, `imageRendering='pixelated'` past threshold, midpoint-anchored `moveImg` correction); drive it from the ratio of successive inter-touch distances, plus pan by midpoint drift.
- **Double-tap**: toggle fit ↔ ~2.5× zoom at the tap point.
- `preventDefault()` only while the modal is open; respect the same `video-controls`/`audio-controls` parent guards as `onMouseDown`.
- Apply the same helpers to `ImageCompareHelper`'s stage; if its internals diverge too much, ship viewer-only first and compare-view as a follow-up commit.

### 2b — Seamless swipe navigation between images

- **At fit zoom (not zoomed in), horizontal swipe advances to the previous/next image** in the current context (batch results or history grid), with a fluid slide: during the swipe, translate the current image with the finger (CSS `transform`, no layout thrash); on release past a distance/velocity threshold, animate the outgoing image off-screen and the incoming one in (~200 ms ease-out); otherwise spring back.
- Image-list source: the same sequence the existing arrow-key navigation uses — find the keyboard prev/next handler in `currentimagehandler.js` during implementation and drive that exact code path (fall back to reading sibling image elements of the batch/history DOM only if no reusable function exists). Never build a separate gallery state that can drift from core.
- Preload the adjacent (±1) full images when the viewer opens or navigates, so swipes land instantly on slow connections.
- When zoomed in, horizontal pan takes priority; swipe-navigation triggers only from fit zoom (edge-fling-while-zoomed is optional later polish).
- Rubber-band resistance at the first/last image so the boundary is felt.

### 2c — Mobile viewer chrome & dismiss gestures

- **Swipe-down to dismiss**: vertical drag translates the image and fades the backdrop; past threshold, close the modal (respecting `noClose` semantics); otherwise spring back.
- **Tap toggles a minimal action overlay** instead of instantly closing (mobile only; desktop click-to-close unchanged): top bar with close button + image index ("3 / 8"); bottom bar exposing the existing per-image actions by triggering the same handlers core uses (star, reuse parameters, delete, download — plus Share via `navigator.share({files})`, feature-guarded). Overlay auto-hides after a few seconds or on next tap; all buttons ≥ 44px.
- Light haptic tick (`navigator.vibrate?.(10)`, feature-guarded; shared toggle with Phase 4) on image change and dismiss.
- Chrome CSS lives in `mobile.css`, scoped under `body.small-window`; zero changes to desktop viewer visuals.

## Phase 3 — Layout & ergonomics (grow `mobile.css` + `mobile_core.js`)

All scoped under `body.small-window` and/or `@media (pointer: coarse)` — composes with every theme, desktop untouched. Prioritized:

1. **Touch targets ≥ 44px**: top nav-tabs, bottom-bar sub-tab links, sidebar toggles, param group headers, batch-item buttons. Pure CSS.
2. **Tab overflow on narrow screens**: horizontal scroll for the top tab bar + bottom sub-tab list (`overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch;`, hidden scrollbar, `scroll-snap-type: x proximity`). Pure CSS.
3. **Sidebar swipe animation polish** (fixes the `layout.js:465` TODO without editing layout.js): `mobile_core.js` adds a document-level `touchend` listener that briefly (~250 ms) adds an `.anim-bars` class to `body` so `reapplyPositions()`'s style writes animate via CSS transitions, then removes it — desktop splitter drags never animate. Fall back to opacity/transform-only open/close animation if the positioning styles don't transition cleanly. Keep small and reversible.
4. **Prompt/Generate ergonomics with the keyboard open**: add `interactive-widget=resizes-content` to the (JS-mutated) viewport meta for Android; a `visualViewport` resize listener offsets the floating `alt_prompt_region` while the prompt textarea is focused (iOS); enlarge the Generate button hit area on mobile.
5. **Pull-to-refresh suppression**: `body.small-window { overscroll-behavior-y: none; }` (prevents accidental reload mid-generation while swiping the bottom bar open).
6. **`dvh`/safe-area completion**: override remaining `100vh`-based sizing from `genpage.css` in `mobile.css` (never edit genpage.css).
7. **History/batch browsing**: comfortable-tap thumbnail sizing on mobile; ensure thumbnails use `?preview=true` + `loading="lazy"` — if core JS doesn't, post-process image elements via a `sessionReadyCallbacks` hook (MutationObserver on the history container), not by editing `browsers.js`.

## Phase 4 — Network resilience & polish

New file `Assets/mobile_network.js` (+ small CSS):

1. **Connection status + reconnect**: listen to `online`/`offline`; wrap the globals `genericRequest`/`makeWSRequest` by reassignment (capture the original in a `let`) to count consecutive failures; show a persistent "Connection lost — retrying" banner (reuse existing toast/status-bar infrastructure); exponential-backoff reconnect probing; clear on first success. Do not alter core retry semantics.
2. **Haptics-lite**: `navigator.vibrate?.(10)` on generation complete and sidebar swipe, behind a localStorage toggle (default on for coarse pointers; iOS safely no-ops). Hook completion via a MutationObserver on the batch container (avoids touching core).
3. **Screen wake-lock during generation** (toggleable): `navigator.wakeLock.request('screen')` while a generation WS is active; release on completion/visibility change. Phones sleeping mid-generation is a real mobile pain point.
4. **(Optional, only if ≲40 extra sw.js lines)**: runtime-cache the last ~50 `/View/*?preview=true` thumbnails (cache-first + revalidate, LRU-capped) so the history grid skeleton renders offline.

## Phase 5 — Optional enhancements (each independent; pick freely)

1. **Simple tab as mobile home** (opt-in localStorage toggle): when `pwa-standalone` + `small-window`, auto-switch to the Simple tab on launch via `sessionReadyCallbacks` — it's already the touch-friendliest generation surface.
2. **Manifest `shortcuts`** for Generate/Simple.
3. **First-run standalone toast** suggesting the User-tab Mobile/Desktop dropdown setting (never silently change user settings).
4. **Considered and rejected**: deduplicating the duplicate `isSmallWindow` logic (`browsers.js` vs `layout.js`) — a core-file refactor with zero user-visible gain; merge-hostile.

---

## Sequencing & verification gate

One commit (or PR) per phase: 1 → 2 → 3 → 4 (→ 5). Phases 2–4 are independent of each other once Phase 1's scaffold lands.

**Gate for every phase:**

1. `dotnet build SwarmUI.sln --configuration Release` passes.
2. `dotnet format SwarmUI.sln --verify-no-changes` clean (CI-enforced).
3. `./launch-linux.sh --ci-test true --launch_mode none --loglevel debug` boots clean; log shows the MobileEnhancements extension discovered.
4. Phase 1+ manual: `curl -sI localhost:7801/sw.js` → 200 `text/javascript`; `/manifest.json` → 200; page head shows the injected tags. Chrome DevTools → Application → Manifest: installable, no errors; Lighthouse PWA audit passes; DevTools offline toggle → offline.html; back online → fresh JS (no staleness).
5. Phase 2+: real device or DevTools touch emulation — pinch anchors under fingers, drag doesn't accidentally dismiss, swipe left/right at fit zoom moves between images fluidly (with preload — no blank flash), rubber-band at the ends, swipe-down dismisses, tap toggles the action overlay, desktop mouse behavior unchanged.
6. Desktop no-regression pass (large-window UI visually unchanged) every phase.
7. After any future upstream merge: re-run this gate + re-check the coupling watchlist.

## Coupling watchlist (re-check after every upstream merge)

These fork files depend on unedited core internals. Upstream refactors won't cause git conflicts — they cause silent breakage, so check these by hand:

| Fork file | Coupled to (unedited core) | Re-check |
|---|---|---|
| `mobile_fullview_touch.js` | `ImageFullViewHelper` method names/zoom math + arrow-key prev/next navigation path in `currentimagehandler.js` | method signatures, `noClose` flag, nav handler |
| `mobile_core.js` (anim hook, viewport mutation) | `layout.js` `reapplyPositions()` + bar classes; `_Layout.cshtml` viewport meta | swipe/gesture region; meta tag shape |
| `mobile_network.js` | `site.js` `genericRequest`/`makeWSRequest` signatures | wrappers still apply |
| `mobile_share.js` | Model Downloader DOM: element IDs `utilitiestabbutton`, `modeldownloadertabbutton`, `model_downloader_url` (`Text2Image.cshtml` / `UtilitiesTab.cshtml`); `modelDownloader` global + its `oninput`/`urlInput` wiring; `triggerChangeFor`/`sessionReadyCallbacks` globals | tab-button + URL-field IDs unchanged; input event still fetches Civitai metadata |
| `MobileEnhancementsExtension.cs` | `WebServer.WebApp`, `PageHeaderExtra`, `Extension` asset lists; `/ShareTarget` route reachability | `Prep()` → `OnPreLaunch()` ordering in `Program.cs` |
