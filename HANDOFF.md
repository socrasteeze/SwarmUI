# HANDOFF

**Updated:** 2026-08-21 · **Branch:** main · **Base:** bcb3b73d (pushed) · **Tree:** clean

## State
`/simple`'s 📋 clipboard button works over plain LAN HTTP again — pushed. On top of that, an upstream sync
(2 commits, merge `9b5fadb6`) is committed locally and **not pushed**: its build gates could not run here.

## Done this session
- Clipboard button falls back to a paste sheet instead of dead-ending — `src/BuiltinExtensions/MobileEnhancements/Assets/m/m_create.js` (`pasteFromClipboard`, `openPasteSheet`, `attachFromText`, `attachFromTransfer`)
- Paste box is focused inside the opening tap, not from a 300ms timer (that cost a third gesture) — same file, end of `openPasteSheet`
- Sheet styling — `src/BuiltinExtensions/MobileEnhancements/Assets/m/m.css` (`.m-paste-hint`, `.m-paste-box`)
- New harness, 26 checks, passing — `src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-clipboard-paste.mjs`
- Fork Delta entry, including the genpage gap left unfixed — `AGENTS.md`

## Open
0. **Run the build gates on the workstation for the unpushed upstream merge, then push.** No .NET SDK exists in the container it was made in, so `dotnet build --configuration Release`, `dotnet format --verify-no-changes` and the ci-test boot have not run against it. The merge itself is clean (0 conflicts, touchpoints verified line-for-line against upstream) — see the 2026-08-21 entry in the AGENTS.md Upstream Sync Log.
1. Device-verify on iOS: tap 📋, long-press the box, Paste. Confirm it takes **two** gestures, not three. Restart the server first (see Traps).
2. Decide the genpage image-editor clipboard fix, which is waiting on the fork owner: `pasteSelectionFromClipboard` has no rejection handler and its fallback box is a one-line text input — `src/wwwroot/js/genpage/helpers/image_editor.js:622`, `src/Pages/_Generate/GenTabModals.cshtml:294`. Both are upstream core files, so it is a merge-cost call, not a technical one.
3. Pre-existing failure in `verify-simple-create-panel.mjs`, unrelated to this work: "batch group right edge matches Prefix" (42/43). Confirmed present on the pre-change tree too. Nobody has looked at whether it is a real misalignment or a harness tolerance.

## Decisions
- Paste sheet over a `readText()` retry — `readText()` fails for the same reasons `read()` just did, and costs a second permission prompt to find out.
- `contenteditable` over a textarea for the paste box — iOS offers Paste for a copied image only over a region that can hold one, which is why the old "paste into the prompt box" advice never worked on a phone.
- Synchronous `focus({preventScroll: true})` over a post-transition timer — a caret and the on-screen keyboard need the user's tap to still be the live gesture.
- Left `image_editor.js` alone — fork law puts core-file edits last, and the fork owner is not blocked by it.

## Traps
- **Release builds cache extension assets in memory.** Any edit to a `/simple`, MobileEnhancements or TagDex asset is invisible until the server restarts — no hard-refresh helps. Restart, then load with cache bypassed. See "Editing extension assets" in `AGENTS.md`.
- Playwright is **not** a repo dependency. The harnesses need it installed separately; they are opt-in, not part of the CI gate.
- Any new file under `Assets/m/` must be registered in `MobileEnhancementsExtension.cs` or the server 404s it. Nothing in this delivery added one — `verify/` is never served.
- `verify-simple-clipboard-paste.mjs` dies partway through against a pre-change tree rather than reporting every failure. That is expected: there is no `.m-paste-box` to query.

## Verify
```
dotnet build src/SwarmUI.csproj --configuration Release
dotnet format SwarmUI.sln --verify-no-changes
./launch-linux.sh --ci-test true --launch_mode none --loglevel debug
node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-clipboard-paste.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-create-panel.mjs
```
Neither `dotnet` command was run this session — no C# changed. Both harnesses were run: 26/26 and 42/43.
