# HANDOFF

**Updated:** 2026-09-12 | **Branch:** `main` | **Base:** `ee7869a4` (`origin/main` at review) | **Tree:** documentation pending commit

## State

WebUI/mobile performance review is complete. Commit this handoff and the review before starting the first implementation tranche.
The user authorized implementation after that commit and explicitly waived the handoff line cap. No push or live restart is authorized by this request.

## Done this session

- Created [WebUI-Performance-Review.md](docs/WebUI-Performance-Review.md) with measured findings, ordered work packages, estimated effort, and acceptance checks.
- Confirmed a duplicate startup build: [main.js:980](src/wwwroot/js/genpage/main.js:980) calls `genInputs(false, false)`; [settings_editor.js:227](src/wwwroot/js/genpage/helpers/settings_editor.js:227) then calls `genInputs(true)` and restores the preset copy.
- Profiled real startup paths in isolated Chromium contexts. The live server advertised `a19f6c55`; three checked assets matched the checkout.
- Measured a 3,364 ms mobile Genpage long task under 4x CPU slowdown. The separate `/simple` sample peaked at 104 ms. These are diagnostic samples, not phone benchmarks.
- Observed 118,250 Genpage DOM elements, 20,421 options, a 7.55 MB decoded user-data response, and a desktop model-list response of 17 MB.
- Existing mobile-performance harness: 50/50 passed. Genpage LoRA harness: 27/27 passed. No application code changed during review.
- Fetched `origin` before the documentation commit. `main` was two commits ahead and zero behind: `7140f5e9` and `a19f6c55`. Both have the required author and committer identity.
- Confirmed a working .NET SDK is available now. Earlier claims that no SDK was available do not describe this environment.

## Open

Work in this order. The review contains detailed scope and verification criteria.

1. Commit this handoff and [the review](docs/WebUI-Performance-Review.md) after documentation scrub and link/whitespace checks. Use the editor's atomic commit proposal tool. Verify the resulting commit before implementation.
2. Begin the first tranche: preserve lazy preset construction through settings initialization; batch control sizing; defer unnecessary hidden UI construction. Preserve defaults, settings application, and custom-workflow rebuild behavior.
3. Load model browsers on first activation while preserving refresh, favorites, current selection, folder navigation, and first-open responsiveness.
4. Defer Genpage autocomplete transfer and indexing using the established bounded loader contract. Preserve aliases, source/user invalidation, syntax completion, and TagDex integration.
5. Compare repeated startup and interaction measurements with the same library and viewport. A successful load flag is insufficient: follow-on work continued after `swarmHasLoaded` became true.
6. Run relevant browser regressions and repository build, formatting, NUnit, and isolated boot gates. Inspect the final diff and update the Fork Delta for core edits.
7. Keep search/history optimization as the next measured package. Cache lightweight search text before building full card descriptions; do not implement full virtualization without evidence.
8. Keep mobile drag, preview/progress updates, and fallback polling separate. Collect interaction traces before changing generation-display behavior.
9. Actual installed-PWA cold/warm loads, keyboard behavior, orientation, gesture reversal, and app resume on Android/iOS remain open. Emulation does not close these checks.

Prior unrelated open items remain separate from performance work. Their live status was not rechecked during this review:

- Prompt Enhance publication and the external prompt-guide repository's publication. The old local-branch description is stale because Prompt Enhance is on current `main`; verify remote parity before later delivery.
- MiniMax H3 prompt doctrine remains deferred pending real generations. Do not infer quality from static review.
- Interrogate modal: verify the WD14-only method list, options, a returned-tag round trip, and Character Sheet's Analyze Pose action.
- Confirm the intended Qwen Image Edit model architecture assignment in the Models tab.
- Route one generation through the configured spoke and verify completion.
- Prior physical-device acceptance, spoke backup-file cleanup, a preview-decode warning, and the companion service restart remain unverified. Do not perform unrelated cleanup or restart during this tranche.

## Decisions

- Optimize the existing architecture. Keep upstream's native mobile Genpage layout and the separate `/simple` client.
- First tranche: startup build/sizing, hidden model-browser loading, and lazy Genpage autocomplete. Search/history and gesture/progress work follow measurements.
- Preserve compact `ListT2IParams`, paged lazy LoRA Select2 results, lazy `/simple` autocomplete, cached mobile geometry, frame-coalesced layout, thumbnails, compression, and versioned asset caching.
- One lower-tier implementation owner per bounded package. Centralize integration and validation. Avoid review panels, duplicated scans, and concurrent edits to the same files.
- Keep reports short and retain durable findings in the review. A runtime trace is stronger evidence than a source pattern alone.
- A single animation-frame callback around the existing layout loop is not batching. Separate measurement and write phases to remove repeated forced layout.
- A model browser's DOM cap does not cap its API response. If on-demand loading leaves first-open latency high, scope API paging separately.
- Permission-aware model caches, workers, and full virtualization are conditional follow-ups, not first-tranche prerequisites.
- The line-cap exception applies to this handoff. Preserve useful decisions and traps without copying the entire review.
- Preserve Prompt Enhance contracts: profiles are versioned assets; provenance uses a hidden parameter; cache lookup intentionally precedes endpoint-health rejection. No redesign is in scope.

## Traps

- Read root [AGENTS.md](AGENTS.md). It is the fork's authority. Keep upstream commits byte-identical and never push or open a pull request upstream.
- Every commit must retain the configured author and committer identity. Do not add attribution trailers. Run the clean workflow before delivery.
- Before this refresh, the working tree contained only the untracked review. Preserve changes that appear from other sessions.
- Lower-tier sessions share editor metadata. They must not rename this session or change its phase. The main session owns metadata updates.
- Runtime directories and downloaded backends are not implementation targets. Do not edit user settings, models, output, backend dependencies, or production data.
- Release builds cache extension assets in memory. Browser cache bypass alone cannot refresh them. Schedule a server restart separately, then bypass browser cache.
- Never build into `src/bin/live_release` while the live server holds the executable. Use the default Release output.
- Boot tests need a throwaway data directory and free port. Otherwise they can load live settings and collide with the running server.
- Diagnostic probes disabled service workers and blocked automatic `TriggerRefresh`, non-allowlisted APIs, and external origins. They are not unrestricted production benchmarks.
- Temporary probes are not tracked or portable. Recreate a bounded probe or maintain a source-backed harness; do not depend on a particular temporary file.
- Fresh browser contexts do not clear server caches. CPU slowdown is uncalibrated diagnostic stress, not a physical phone model.
- A call-stack wrapper confirmed the settings-triggered second `genInputs` call. The existing initial preset deferral does not cover that path.
- Width batching must preserve font-sensitive widths, `nogrow`, selection values, minimum sizes, and stable geometry. Hidden controls must size correctly on first display.
- First-open model and autocomplete loading must not move the startup freeze to the first action. Preserve retry and invalidation behavior.
- Keep intermediate preview coalescing separate from final-image, error, and completion delivery. Never drop terminal generation messages.
- Prior integration trap: do not mirror an LLM backend as an image backend when `CanLoadModels` is true. This is outside the current scope.
- Prior integration trap: fixed prompt popovers belong under `document.body` to avoid transformed or scrolling ancestors becoming their containing block.
- Do not write runtime `.fds` files with a BOM. Their backslash and empty-string escaping is intentional. Runtime edits require a separate stopped-service workflow.
- Hub/spoke commit compatibility remains a deployment gate. Do not deploy one side implicitly during frontend verification.

## Verify

Documentation commit checks:

```powershell
git status --short
git diff --check
git diff -- HANDOFF.md
git log origin/main..HEAD --format="%h %an <%ae> | %cn <%ce> %s"
```

Existing targeted checks, both passed during review:

```powershell
node src/BuiltinExtensions/MobileEnhancements/verify/verify-mobile-perf.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-genpage-loras.mjs
```

Implementation gates. Not run for the documentation-only review:

```powershell
dotnet build SwarmUI.sln --configuration Release
dotnet test SwarmUITests/SwarmUITests.csproj --configuration Release
dotnet format SwarmUI.sln --verify-no-changes
dotnet format style --verify-no-changes
dotnet build Desktop/Desktop.csproj --configuration Release
```

Isolated boot example. Choose a free port and a new throwaway directory. An untracked extension caused a prior failure; classify any current failure from fresh logs.

```powershell
dotnet src/bin/Release/net8.0/SwarmUI.dll --ci_test true --launch_mode none --loglevel debug --data_dir "$env:TEMP\swarm-perf-ci\data" --port 7899
```

Read-only live status commands:

```powershell
node tools/swarm_api.mjs GetCurrentStatus
node tools/swarm_api.mjs ListBackends
```
