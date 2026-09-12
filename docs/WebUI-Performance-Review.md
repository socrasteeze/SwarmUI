# WebUI and Mobile Performance Review

Date: 2026-09-12. Reviewed checkout: `a19f6c55` on `main`.

## Recommendation

Start with a bounded Genpage startup and interaction pass. The review found concrete repeated work and large eager payloads. A frontend rewrite is not justified by this evidence.

Genpage is the same application on desktop and small screens. `/simple` is a separate client. Improvements to Genpage startup benefit both desktop and its native mobile layout. Keep upstream's mobile layout and the fork's existing extension boundaries.

The review covers desktop rendering, mobile/PWA behavior, and frontend-facing APIs. The strongest findings were checked against source and a local browser probe. At the review baseline, no application code had changed.

## Evidence and limits

The local server advertised the reviewed commit. Served copies of [site.js](../src/wwwroot/js/site.js:701), [settings_editor.js](../src/wwwroot/js/genpage/helpers/settings_editor.js:190), and `/simple`'s [m_app.js](../src/BuiltinExtensions/MobileEnhancements/Assets/m/m_app.js:8) matched the checkout after line-ending normalization.

Browser diagnostics used fresh Chromium contexts on the existing server. Desktop used 1440 x 900 with no CPU slowdown. Mobile Genpage and `/simple` used 390 x 844 with 4x CPU slowdown. The second mobile probe included CPU sampling and allowed the normal read APIs. Automatic `TriggerRefresh` was blocked, as were unapproved API calls and external origins. Service workers were disabled. No generation, restart, configuration edit, or model mutation was requested.

These are diagnostic samples, not percentile benchmarks or physical-device results. CPU sampling adds overhead. Fresh browser contexts do not make the server's filesystem and application caches cold. The two surfaces also expose different amounts of UI.

- Mobile Genpage produced a **3,364 ms** main-thread task in the sampled startup window. Other tasks lasted 2,831 ms and 1,224 ms. `/simple`'s largest task in its sampled window was **104 ms**.
- Genpage contained **118,250 DOM elements** at the mobile sample point, including **20,421 option elements**. `/simple` contained **297 elements**, including **136 options**. Counts reflect those sample points, not a fixed final size.
- Genpage's `GetMyUserData` response contained **7,549,996 decoded bytes** and approximately **2.34 MB transferred**. `/simple` requested autocomplete omission and received **30,293 decoded bytes**, approximately **9 KB transferred**.
- Both clients already requested compact `ListT2IParams`: **2,309,256 decoded bytes**, approximately **299 KB transferred**.
- A desktop trace observed one eager `ListModels` response of **17,049,145 decoded bytes**, approximately **2.71 MB transferred**. Initial browser rendering limits do not bound that API response.
- CPU samples repeatedly landed in `autoSelectWidth`, `autoNumberWidth`, browser content construction, HTML sanitization, and the user-data callback.
- A separate call trace confirmed **two startup calls to `genInputs`**: `genInputs(false, false)` from [main.js:980](../src/wwwroot/js/genpage/main.js:980), followed by `genInputs(true)` from [settings_editor.js:227](../src/wwwroot/js/genpage/helpers/settings_editor.js:227). The second call restores the default `includePresets = true`.

The existing `swarmHasLoaded` flag became true before substantial follow-on work finished. Do not use that flag alone as the performance acceptance signal. Browser resource durations also include client scheduling effects; they are not isolated server execution timings.

A long task exceeds 50 ms. Work on the main thread delays input handling and painting. Use actual interaction measurements to validate the eventual changes. [Browser guidance](https://web.dev/articles/optimize-long-tasks), [INP guidance](https://web.dev/articles/optimize-inp).

## Proposed work, in order

### 1. Remove repeated startup builds and control sizing

**Evidence: measured and source-confirmed. Highest priority.**

The initial lazy-preset optimization is undone by `loadSettingsEditor`. `loadUserSettings` also calls `buildSettingsMenu` twice to apply settings. Separate applying settings from building the hidden settings UI where practical. Preserve defaults, theme application, parameter overrides, and the reset-batch behavior.

Each width helper appends a measurement span, reads its width, writes a control width, and removes the span. Repeating this across many controls forces repeated layout. Collect measurements, attach measurement nodes together, read sizes together, then apply widths together. Cache measurements only with a valid font/text key. Skip hidden controls until needed where geometry permits.

Moving the existing loop wholesale into `requestAnimationFrame` only postpones the same blocking work. It does not solve the repeated layout cycle.

Smallest scope: [site.js](../src/wwwroot/js/site.js:701), [params.js](../src/wwwroot/js/genpage/gentab/params.js:451), [settings_editor.js](../src/wwwroot/js/genpage/helpers/settings_editor.js:190), and the boot ordering in [main.js](../src/wwwroot/js/genpage/main.js:331). These are core touchpoints, so record the fork delta and preserve upstream behavior. Keep preset controls lazy until their first use; do not eliminate rebuilds that settings actually require.

Verify: startup call counts, layout events, prompt usability, and long-task duration. Check preset creation/editing, selected LoRAs, settings changes, custom workflows, theme/font changes, and control geometry at desktop and phone widths.

### 2. Load model browsers when needed

**Evidence: source-confirmed; large payload and DOM cost observed.**

`initialModelListLoad` navigates all six model browsers. Their requests wait for starred-model data, then load even if their tabs are hidden. Model cards build descriptions, controls, and menus. The shared browser also constructs per-card popovers outside its content container.

Start only the visible browser. Initialize other browsers on first activation. Consider building each card's action menu on first use. Preserve the folder tree, selected-model markers, keyboard navigation, favorites, and refresh semantics.

Smallest scope: [models.js](../src/wwwroot/js/genpage/gentab/models.js:1011) and [browsers.js](../src/wwwroot/js/genpage/helpers/browsers.js:428). Medium merge risk. If first-open latency remains high, add bounded server-side model paging as a separate follow-up with sorting, filtering, and permission tests. DOM chunking alone does not limit downloaded metadata.

Verify: request count before any model-tab interaction, DOM count, startup trace, first and repeated tab opens, large-library filtering, and model refresh behavior. Deferral must not merely move a multi-second freeze to the first tap.

### 3. Defer Genpage autocomplete transfer and indexing

**Evidence: measured payload difference and source-confirmed eager indexing.**

Genpage calls `GetMyUserData` without `includeAutocompletions: false`, then synchronously splits and normalizes every returned entry. `/simple` already has a bounded, lazy autocomplete loading path.

Apply that established loading contract to Genpage. Retain aliases, tag counts, syntax completions, TagDex integration, retry behavior, and user/source invalidation. Use bounded work slices if indexing still blocks. Consider a worker only if measurements justify its extra lifecycle and data-transfer complexity.

Smallest scope: [main.js](../src/wwwroot/js/genpage/main.js:331), prompt completion code, and reuse or extraction of the existing autocomplete loader. Medium compatibility risk. Do not fetch a second full user snapshot merely to recover autocomplete.

Verify: decoded and transferred boot bytes, first-focus response, typing latency, completion correctness, failures, reloads, and changing users or completion sources. Preset refreshes should not rebuild an unchanged autocomplete index.

### 4. Reduce repeated search and history rendering work

**Evidence: source-confirmed execution paths; interactive timings still required.**

[browsers.js](../src/wwwroot/js/genpage/helpers/browsers.js:428) calls the full descriptor before testing its searchable text. Input events rerender the cached list. Model descriptors build metadata and action controls; history descriptors parse and format metadata again.

Cache lightweight search text by item identity and data revision. Filter before constructing full card descriptions. Reuse parsed history metadata until its source changes. Keep incremental rendering and bound each main-thread slice. Consider full list virtualization only if these smaller changes leave unacceptable costs.

Smallest scope: [browsers.js](../src/wwwroot/js/genpage/helpers/browsers.js:428), [models.js](../src/wwwroot/js/genpage/gentab/models.js:1011), and [outputhistory.js](../src/wwwroot/js/genpage/gentab/outputhistory.js:270). Low to medium risk. Verify filtering, sorting, refreshed metadata, deletion, navigation, and scroll position. Measure p50/p95 input-to-paint time and descriptor counts on a representative large library.

### 5. Smooth mobile gestures, preview updates, and reconnect polling

**Evidence: static candidates; no generation or physical-device trace collected.**

- Genpage's bottom-panel drag writes height on each touch event. Coalesce to the latest coordinates once per frame while preserving follow-finger behavior. Avoid replacing upstream's panel system.
- Genpage updates progress and preview images per message. Measure message rate first. If needed, coalesce intermediate display work per batch while always delivering final images, errors, and completion state.
- `/simple` animates preview progress through a 300 ms width transition. Evaluate a left-origin `scaleX` progress strip and preserve visible progress under reduced-motion preferences.
- `/simple`'s 3-second fallback status interval has no in-flight guard. Prevent overlapping requests on slow links and retain correct foreground/wake behavior.

Mostly extension-local, except the Genpage drag and preview paths. Low to medium implementation risk; generation state correctness is the main regression concern. Validate background/foreground transitions, interrupted requests, final-image replacement, multiple batches, and rapid gestures.

## Effort envelope

These are engineering estimates, including focused tests and review, not delivery commitments.

- Baseline and work packages 1-3: approximately **3-6 developer days**. This is the recommended first tranche.
- Search/history work: approximately **1-3 additional days**, subject to traces.
- Mobile gesture/progress/polling work: approximately **1-3 additional days**, plus actual device testing.
- Model API paging, a worker, or full virtualization: estimate separately only if the first tranche leaves a measured bottleneck.

Do not combine all packages into one large change. Assign one owner per bounded package. Keep integration, review, and shared validation centralized. Run dependent work sequentially when it shares core files.

## Preserve and defer

Keep the existing compact parameter payload, paged lazy LoRA Select2 adapter, lazy `/simple` autocomplete, cached mobile geometry, frame-coalesced layout scheduling, thumbnail support, compression, and versioned asset caching. The current mobile-performance harness passed **50/50** checks; the Genpage LoRA harness passed **27/27**.

No framework migration, TypeScript conversion, bundler change, native app rewrite, backend execution redesign, or second Genpage mobile shell is part of this scope.

Server model-list caching and history enumeration caching remain conditional follow-ups. Invalidation must include permissions and user scope; global caches are not a safe default. The service worker already returns cached thumbnails immediately before revalidation. Measure actual network traffic before changing freshness behavior. Duplicate viewer preload work and permanent compositor hints remain lower-confidence candidates.

## Acceptance plan

Capture repeated baselines and post-change results with the same dataset and viewport. Include desktop, throttled Chromium, and installed PWA on actual Android/iOS hardware. CPU slowdown is a diagnostic aid, not a substitute for the device's processor or browser. [Chrome guidance](https://developer.chrome.com/blog/devtools-grounded-real-world).

For common typing, picker, tab, and panel actions, use **p95 input-to-next-paint under 200 ms** as an initial lab budget. This is a project acceptance target, not a measured field INP score. Investigate remaining main-thread tasks above 50 ms. Track first usable prompt and first model selection, not only document load or `swarmHasLoaded`.

Cover cold/warm PWA loads, keyboard opening, orientation, rapid drag reversal, model search, history scroll, generation progress, and app resume. Confirm that unrelated controls do not move during interaction. Preserve session, preset, permission, model refresh, cancellation, and final-image correctness.

After implementation, run the relevant browser harnesses plus repository-required build, formatting, NUnit, and isolated boot gates. Live extension-asset verification requires the documented Release-server restart and cache bypass. Schedule that separately from active generation.

## UI Stability Audit - SwarmUI

Scope: startup observations on Genpage and `/simple` only. Viewports: 1440 and 390. Runtime: limited startup probes; full interaction audit NOT RUN.

Verdict: BLOCKED for a full stability verdict pending the interaction/device matrix. This is not a release failure declaration.

| # | Check | Status | Severity | Evidence | Proposed check |
|---|---|---|---|---|---|
| 1 | Startup layout shift | WARN | SHIFT | Mobile Genpage sample accumulated approximately 0.299 layout-shift score; `/simple` sample was 0 | Attribute shift sources under complete loading conditions before fixing |
| 2 | Control sizing | WARN | SHIFT | [site.js:701](../src/wwwroot/js/site.js:701) writes calculated widths repeatedly | Measure neighboring controls through boot, selection, and theme changes |
| 3 | Gesture and keyboard stability | NOT RUN | Not graded | No real device interaction matrix | Run panel, keyboard, orientation, and PWA-resume checks |

## Animate Audit - SwarmUI

Stack: plain JS/CSS with Bootstrap and Select2. Mode: VERIFY. Runtime: static-only motion review.

Verdict: BLOCKED for a full motion verdict pending gesture and progress traces.

| State change | Current behavior | Proposed behavior | Status |
|---|---|---|---|
| Genpage side panels | Transform/opacity transitions with a reduced-motion override | Retain upstream behavior | PASS, static |
| Genpage bottom-panel drag | Height writes per touch event | At most one display update per frame | WARN |
| `/simple` progress | 300 ms width transition | Evaluate scale transform and latest-frame updates | WARN |
| `/simple` sheets | 250 ms transform transition; no local reduced-motion override found | Verify and respect reduced motion | WARN |

| # | Rule | Status | Severity | Evidence | Proposed fix |
|---|---|---|---|---|---|
| 1 | Animated properties | WARN | FEEL | [m.css:1920](../src/BuiltinExtensions/MobileEnhancements/Assets/m/m.css:1920), [m_create.js:148](../src/BuiltinExtensions/MobileEnhancements/Assets/m/m_create.js:148) | Replace progress width interpolation after profiling |
| 2 | Reduced motion | WARN | Accessibility | [m.css:1339](../src/BuiltinExtensions/MobileEnhancements/Assets/m/m.css:1339) | Test computed motion with reduced-motion preference enabled |
| 3 | Frame and interrupt behavior | NOT RUN | Not graded | No live generation/gesture trace | Test rapid reversal, final state, and frame timing |

Tokens: existing local CSS values retained. No new animation system proposed. No previously unanimated state change was selected for added animation; this review concerns responsiveness.
