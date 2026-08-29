# HANDOFF

**Updated:** 2026-08-28 · **Branch:** main · **Base:** d7b14c60 (= origin/main)

> This handoff intentionally bypasses the usual line cap: it is the full specification-and-rationale record
> for the Characters-panel move to the Generate tab (plus two sibling features that landed in the same
> sweep), written so an agent can pick this up cold and understand both the logic and the exact
> implementation without re-deriving it.

## State

Three features are implemented, verified, and committed on `main` (not pushed):

1. **Generate bottom-bar extension-tab hook + Characters panel moved onto the Generate tab** (the main ask).
2. **TagDex batch thumbnail sweep** ("Generate All Visible" / Cancel on the Characters panel).
3. **Image-compare touch parity** in MobileEnhancements (unrelated sibling task from the same sweep).

Gates green on all three: `dotnet build SwarmUI.sln --configuration Release` = 0 warnings / 0 errors;
`dotnet format --verify-no-changes` and `dotnet format style --verify-no-changes` = clean;
`node --check` clean on both touched JS files. The Characters move was live-boot tested (Release DLL,
scratch `--data_dir`, port 7899, fetched `/Text2Image` and inspected the served HTML). **Nothing has been
clicked in a real browser yet** — see Open.

## Feature 1 — Characters panel on the Generate tab

### The problem being solved

TagDex's Characters panel previously lived as a **top-level page tab** (sibling of Generate/Comfy/etc.),
auto-discovered from `Tabs/Text2Image/Characters.html`. The goal: put it **inside the Generate tab's
bottom bar** (sibling of Image History / Models / Wildcards / Tools) so it can be used *while* operating
the normal Generate UI — pick a character, tweak the prompt, generate, without leaving the page.

### Why a new discovery hook rather than hardcoding the tab

The fork's standing policy (AGENTS.md) is merge-friendly, append-only changes to core. The core already has
exactly one extension-tab discovery mechanism: `WebServer.GatherExtensionPageAdditions()` scans each
extension's `Tabs/Text2Image/*.html`, registers a `view_extension_tab_{id}` permission per file, and emits
nav-item + tab-pane HTML into `T2ITabHeader`/`T2ITabBody` placeholders rendered by the page templates. The
implementation **mirrors that block one-for-one for a new `Tabs/GenerateBottom/` directory**, rather than
hardcoding a Characters entry into `GenerateTab.cshtml`. Consequences:

- Any extension (ours or upstream's) can now drop an HTML file in `Tabs/GenerateBottom/` and get a
  bottom-bar tab with permission gating for free — the hook is generic, not TagDex-specific.
- The core diff stays small, append-only, and plausibly upstreamable.
- Permission behavior is identical to the existing hook (`view_extension_tab_characters`, USER default,
  extension-tabs group), so existing user/role configs keep working unchanged.

### Exact implementation

- `src/Core/WebServer.cs:85-92` — two new static fields, `T2IBottomTabHeader` and `T2IBottomTabBody`
  (`HtmlString`, default empty), directly below the existing `T2ITabHeader`/`T2ITabBody`.
- `src/Core/WebServer.cs` `GatherExtensionPageAdditions()` — the local `StringBuilder` declaration gains
  `bottomTabHeader, bottomTabFooter`; a new `if (Directory.Exists($"{e.FilePath}Tabs/GenerateBottom/"))`
  block (`:367-383`) mirrors the `Tabs/Text2Image` block above it exactly: enumerate `*.html`, derive
  `id = T2IParamTypes.CleanTypeName(filename)`, register `view_extension_tab_{id}` if absent, append a
  `<li class="nav-item">` nav link (`id="maintab_{id}"`, `data-bs-toggle="tab"`, `href="#{id}"`,
  `data-requiredpermission`) and a pane div. **The one deliberate difference:** the pane class is
  `tab-pane genpage-bottom-tab` (matching the hardcoded bottom-bar panes like `#Image-History-Tab`)
  instead of the top-level hook's `tab-pane tab-pane-vw` — the bottom bar's sizing/scroll behavior comes
  from `genpage-bottom-tab`.
- `src/Pages/_Generate/GenerateTab.cshtml:188` — `@WebServer.T2IBottomTabHeader` appended inside
  `<ul id="bottombartabcollection">` after the Tools nav item; `:260` — `@WebServer.T2IBottomTabBody`
  appended inside `<div class="tab-content" id="t2i_bottom_bar_content">` after the Tools pane.
- `src/BuiltinExtensions/TagDex/Tabs/Text2Image/Characters.html` → **git rename** →
  `src/BuiltinExtensions/TagDex/Tabs/GenerateBottom/Characters.html`. The extension no longer has a
  `Tabs/Text2Image/` directory, so no top-level Characters tab is emitted anymore.
- `src/BuiltinExtensions/TagDex/Assets/tagdex_tab.js:1-5` — header comment updated to describe the new
  wiring. The JS needed **no functional change** for the move: its lazy-init hooks on the
  `maintab_characters` nav link (`tagdex_tab.js:59`), and the discovery hook emits the same
  `maintab_{id}` id in the bottom bar, so first-open init, browser layout, and per-card handlers all
  carry over. Verified in the served page: single `href="#characters"` inside `#bottombartabcollection`
  with `data-requiredpermission="view_extension_tab_characters"`; pane is
  `<div class="tab-pane genpage-bottom-tab" id="characters">`.

### How it behaves from the Generate UI

The Characters panel is now a bottom-bar tab like Image History: always reachable while the prompt/params
sidebar and image area stay live. Card clicks that inject tags into the prompt act on the same page's
prompt box directly. The panel inherits the bottom bar's (shorter, wider) geometry — card grid reflow in
that narrower panel is untested in a real browser (Open #2).

## Feature 2 — TagDex batch thumbnail sweep

"Generate All Visible" sweeps every currently-rendered card still showing the placeholder and generates a
reference image for each, sequentially, with live progress and a Cancel.

- **Controls** — `Tabs/GenerateBottom/Characters.html`: `#tagdex_batch_row` (gated
  `data-requiredpermission="tagdex_manage"`) holding `#tagdex_batch_generate`, `#tagdex_batch_cancel`
  (hidden until running), `#tagdex_batch_status`. Styling: `.tagdex-batch-status` in `tagdex.css:70`.
- **Wiring** — `tagdex_tab.js:375-376`; state fields `batchRunning`/`batchCancelled` plus the existing
  `generatingThumb` flag, shared so a single-card generate and a sweep can never overlap.
- **`collectPlaceholderCards()` (`:686`)** — walks `.model-block` cards; reads
  `img.getAttribute('src') || img.dataset.src` because unrevealed lazyloaded imgs have *only*
  `dataset.src` (and `img.src` on a src-less `<img>` reports the page URL, never empty).
- **`runBatchStep()` (`:736`)** — deliberately sequential recursion, never `Promise.all`: the next
  `TagDexGenerateThumbnail` websocket request is issued only from the previous one's success/error
  callback, so exactly one is in flight. Rationale: `TagDexThumbs.cs:21` guards generation with a
  single-slot `SemaphoreSlim`, so fan-out would only stack requests server-side while burning a websocket
  each — and sequencing is what makes Cancel meaningful (only the in-flight card finishes; nothing else
  was sent). Progress line shows per-card queued/percent/index states; errors are reported and the sweep
  continues to the next card.
- **`cancelBatchGenerate()`/`finishBatch()` (`:766/:776`)** — cancel sets the flag checked before each
  step (no server cancel route exists; none needed with one request in flight); finish resets buttons and
  reports "Done — generated N of N" / "Cancelled after i of N".
- **Verifier-found fix (`:848-849`)** — `repaintCardThumb` now also does
  `classList.remove('lazyload'); delete target.dataset.src` when painting a generated thumb. Without
  this, `makeVisible` (`src/wwwroot/js/genpage/helpers/browsers.js:33-52`) re-assigns
  `src = dataset.src` for anything still carrying `.lazyload` when it scrolls into view — silently
  reverting off-screen cards the sweep just painted, and leaving them looking un-generated to the next
  sweep. New upstream-coupling row recorded in `docs/TagDex-Plan.md`'s fork-delta table.

## Feature 3 — Image-compare touch parity (MobileEnhancements)

`MobileImageCompareTouch` class appended at
`src/BuiltinExtensions/MobileEnhancements/Assets/mobile_fullview_touch.js:471` (instantiated `:703`),
wiring `touchstart/touchmove/touchend/touchcancel` onto `imageCompareHelper.stage`
(`#image_compare_stage`). **Zero core edits** — `currentimagehandler.js` untouched; the class drives only
the core helper's existing public API (`getViewportFromTarget`, `getOverlayDividerFromTarget`,
`updateOverlaySplitFromClientPosition`, `stopPanning`, `getViewportLayout`, `clampPan`,
`setHeightPercent`, `getMaxHeight`, `updateImageRendering`, `applyView`, `moveImg`), so touch and mouse
share one viewport state and cannot diverge. Gestures: one-finger pan, anchored pinch zoom (`zoomAt`
`:667` replicates `onWheel`'s math with an explicit factor in place of `Math.pow(zoomRate, -deltaY/100)`
— same min/max-height clamp, same anchor-preserving pan correction, same `clampPan`+`applyView`), and
one-finger slide-divider drag. All gated on `(pointer: coarse)`; `touch-action: none` on the stage at
`mobile.css:94`; desktop mouse/wheel unchanged. Verifier-found fix: a pinch always begins as one finger,
which had opened a pan on the core helper; the second finger switched mode without releasing it, leaving
`isDragging` stuck true and the cursor stuck on `grabbing` after every pinch. Fixed with
`holdingPanState` + `releasePanState()` (`:503`), invoked on every gesture exit path (pinch transition,
both bail paths, inactive guard, touchend, touchcancel). Doc line flipped TODO → shipped at
`docs/MobilePWA-Optimization-Plan.md:12`.

## Open

1. **Hard-refresh (Ctrl+Shift+R) before testing.** Asset URLs carry `?vary=<commit read at server startup>`.
2. **Hands-on browser pass, never done:** the Characters bottom-bar tab (first-open init, card grid reflow
   in the shorter/wider panel geometry, prompt injection while the Generate UI is live), the sweep
   controls end-to-end, per-card generate / use-current-image / delete, LLLite models, and the
   touchscreen compare gestures on a real device.
3. **Re-run the prompts that reliably went black.** If they recur with the DiT in bf16, the next suspect
   is `comfy-aimdo` (DynamicVRAM, async weight offloading) — not audited.
4. Parked backlog unchanged, in `docs/TagDex-Plan.md` and `docs/MobilePWA-Optimization-Plan.md`:
   simple-tab browse sheet, prompt coach, service-worker thumbnail cache, connection banner upgrades,
   haptics, wake-lock, manifest shortcuts. No auth is configured on this install.

## Decisions

- **Mirror the Text2Image extension-tab hook for a new `Tabs/GenerateBottom/` scan** instead of hardcoding
  the Characters tab into `GenerateTab.cshtml` or editing the bottom bar's fixed markup. Same permission
  scheme, same nav markup, append-only, generic for any extension, upstreamable. Recorded in the
  fork-delta table in `docs/TagDex-Plan.md`.
- **Pane class `genpage-bottom-tab`, not `tab-pane-vw`** — the bottom bar's own panes define the geometry;
  reusing the top-level hook's class would have broken sizing inside the bar.
- **Batch sweep is strictly sequential** — see Feature 2 rationale (single-slot server gate, meaningful
  cancel, one websocket).
- **Touch handling stays wholly inside the MobileEnhancements extension**, replicating core math rather
  than patching core — desktop behavior provably unchanged.

## Traps

- **Revealing a lazyloaded thumbnail takes three writes, not one.** `makeVisible`
  (`browsers.js:33-52`) re-assigns `src = dataset.src` for anything still carrying `.lazyload`, so setting
  `img.src` alone silently reverts off-screen cards on scroll. Fixed at `tagdex_tab.js:848-849`; any new
  card-painting code must do the same three writes (`src`, remove `.lazyload`, delete `dataset.src`).
- **A pinch always begins as a single touch.** Any touch layer that takes state on finger 1 must release
  it when finger 2 arrives — see `holdingPanState`/`releasePanState()` in `mobile_fullview_touch.js`.
- **The `maintab_{id}` nav-link id is a contract.** TagDex's lazy init (`tagdex_tab.js:59`) and the tab
  discovery hook both depend on it; renaming the emitted id breaks first-open init silently.
- Carried forward: `\s` in `Data/Settings.fds` paths is FDS escaping, not corruption. A running server
  locks the exe and owns the settings file — stop it with the `ShutdownServer` API, not a kill. A
  `JObject` API parameter receives the whole request payload, not the field matching its name
  (`APICallReflectBuilder.cs:46`).

## Verify

```powershell
dotnet build SwarmUI.sln --configuration Release
dotnet format --verify-no-changes
dotnet format style --verify-no-changes
node --check src/BuiltinExtensions/TagDex/Assets/tagdex_tab.js
node --check src/BuiltinExtensions/MobileEnhancements/Assets/mobile_fullview_touch.js
# No automated tests; validate live. The launcher needs -o src/bin/live_release, not the default output dir.
```
