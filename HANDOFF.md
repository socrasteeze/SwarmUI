# HANDOFF

**Updated:** 2026-08-22 · **Branch:** main · **Base:** 0c8891fc (= origin/main) · **Tree:** clean

## State
All five open items from the previous handoff are closed. The genpage clipboard fix shipped in two halves
and is browser-verified; the tailnet HTTPS plan is parked by owner decision. Nothing unpushed.

## Done this session
- Completed a stalled `origin/main` merge, resolved its `AGENTS.md` conflict (the 2026-08-21 sync entry was
  written twice, with contradictory gate claims) — `5974a983`
- Ran the .NET gates for the first time since 2026-08-14: build 0/0, both format gates clean, isolated
  ci-test boot exit 0. The "no SDK in this container" premise carried by prior handoffs is false here.
- Clipboard `read()` rejection now routes to the paste modal; a successful modal paste closes it and
  confirms — `src/wwwroot/js/genpage/helpers/image_editor.js`, `68953f2f`
- Paste box is now `contenteditable` with an `<img>` read-back path —
  `src/Pages/_Generate/GenTabModals.cshtml`, `c4398e40`. Both files have Fork Delta + watchlist entries.
- Fixed `verify-simple-create-panel.mjs` measuring a hidden Prefix row — it was a harness bug, not the
  long-suspected layout misalignment; no production code changed — `5f95bc73`
- Installed Playwright locally, gitignored the artifacts; full suite now runs 218/218

## Open
1. Genpage has no verify harness. The clipboard work was checked by driving the live server by hand; a
   `verify/*.mjs` equivalent would make it repeatable — `src/BuiltinExtensions/MobileEnhancements/verify/`
2. Two links in that fix are unverified and unreachable by synthetic events: the browser's own default paste
   inserting the `<img>`, and a real thumb long-press on iOS (the reason the box is `contenteditable`).
3. If auth is ever enabled, blank `Network.AuthBypassIPs` in the same edit — see Traps.
4. 23 sweep candidates stay parked, each needing a product decision — TagDex browser pass and batch sweep,
   Prompt Coach, mobile Phase 5, PWA icons. See `docs/TagDex-Plan.md`, `docs/MobilePWA-Optimization-Plan.md`.

## Decisions
- Tailscale `serve` over Swarm-side TLS — `serve` renews its own cert, while Swarm would need core edits to
  `WebServer.cs` and `Settings.cs` plus ~90-day manual renewal.
- **Plan parked anyway.** A loopback bind was applied and verified, then reverted at the owner's request
  rather than introduce a tailnet-visible service. Server config is back to its original state; `serve` was
  never configured.
- Playwright stays out of the repo manifest — installed locally, artifacts gitignored.
- Genpage paste-modal styles sit inline in the modal markup, not a core stylesheet, keeping the fork's
  divergence for this feature to two files.

## Traps
- **`RequiredAuthorization` is bypassed behind any local reverse proxy.** The check compares the socket peer
  against `Network.AuthBypassIPs`, which lists loopback by default — `src/Core/WebServer.cs:180-192`. Every
  proxied request arrives as loopback, so the requirement silently stops applying.
- A `--ci-test` boot collides with a running server over `Data/Users.ldb` (LiteDB holds an exclusive lock)
  and dies on an unhandled `IOException`. Pass an isolated `--data_dir`; do not kill the server.
- Shut the server down before editing `Data/Settings.fds` — it rewrites that file on exit.
- On Windows `launch-linux.sh` is not the gate; invoke the built DLL directly (see Verify).
- Release builds cache extension assets in memory — asset edits are invisible until restart. See AGENTS.md.
- Playwright is not a repo dependency; a fresh machine needs it installed before any harness runs.

## Verify
```powershell
dotnet build src/SwarmUI.csproj --configuration Release --no-incremental
dotnet format SwarmUI.sln --verify-no-changes
dotnet format style SwarmUI.sln --verify-no-changes
dotnet src/bin/Release/net8.0/SwarmUI.dll --ci-test true --launch_mode none --loglevel debug --data_dir <scratch>
Get-ChildItem src/BuiltinExtensions/MobileEnhancements/verify/*.mjs | ForEach-Object { node $_.FullName }
```
All green on 2026-08-22: build 0 warnings/0 errors, both format gates clean, boot exit 0, harnesses 218/218.
