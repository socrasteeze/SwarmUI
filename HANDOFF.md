# HANDOFF

**Updated:** 2026-08-23 · **Branch:** main · **Base:** d7c861f3 (= origin/main) · **Tree:** clean

## State
The fork is now reachable over HTTPS on the tailnet, which gives phones a secure context. All five open
items from the previous handoff stay closed. Nothing unpushed.

## Done this session
- **Tailnet HTTPS.** One `tailscale serve` proxy on the same port SwarmUI already uses. Swarm keeps
  `Network.Host: 0.0.0.0` — see Decisions. Written up in `docs/Tailnet-HTTPS.md`.
- Genpage paste modal box is now `contenteditable` with an `<img>` read-back path, so a phone will offer
  Paste over it — `GenTabModals.cshtml` + `image_editor.js`, `c4398e40`. Browser-verified, 10 behaviours.
- Added `Assets/m/_diag.html` (`ca0a8435`) — the only way to get real inset and launch-context numbers off
  a device no harness can emulate.
- Investigated the installed-app bottom-nav gap and **accepted it** (write-up in the mobile plan doc); a CSS
  height rule shipped for it (`0fa1aaa5`) was reverted same-day (`380144fd`) once device data killed it.
- Fixed MagicPrompt's boot error — Ollama was installed but not running.

## Open
1. Genpage still has no verify harness; the clipboard work was checked by hand. Two of its links are
   unreachable by synthetic events anyway — the browser's own default paste, and a real iOS long-press.
2. No authentication is set. If it is ever enabled, blank `Network.AuthBypassIPs` in the same edit — see Traps.
3. If MagicPrompt errors again after a reboot, its Ollama autostart shortcut is the suspect — not this repo.
4. 23 sweep candidates stay parked, each needing a product decision — TagDex browser pass and batch sweep,
   Prompt Coach, mobile Phase 5, PWA icons. See `docs/TagDex-Plan.md`, `docs/MobilePWA-Optimization-Plan.md`.

## Decisions
- `tailscale serve` over Swarm-side TLS — it renews its own cert; Swarm would need core edits to two
  upstream files plus ~90-day manual renewal.
- **Swarm stays on all interfaces.** An earlier session's claim that `Host` must move to loopback for a
  same-port proxy was wrong — `serve` is handled inside tailscaled and intercepts before the host socket
  layer, so it coexists with the `0.0.0.0` bind. Corrected in `docs/Tailnet-HTTPS.md`.
- The iOS bottom-nav gap is accepted, not fixed — ruled out by measurement, not argument.
- Playwright stays out of the repo manifest — installed locally, artifacts gitignored.

## Traps
- **`RequiredAuthorization` is bypassed behind any local reverse proxy**, `serve` now included. It compares
  the socket peer against `Network.AuthBypassIPs` (loopback by default, `src/Core/WebServer.cs`), and every
  proxied request arrives as loopback.
- **Plain HTTP to the tailnet address on that port now returns 400** — `serve` owns that side and expects
  TLS. LAN and localhost HTTP are unaffected.
- **A running server blocks two things**: a `--ci-test` boot collides with it over `Data/Users.ldb` (pass an
  isolated `--data_dir`), and a rebuild fails because it holds `SwarmUI.exe`. Also shut it down before
  editing `Data/Settings.fds`, which it rewrites on exit. Stop it via the `ShutdownServer` API, never a
  hard kill — LiteDB.
- **Release builds cache extension assets in memory** — asset edits need a restart. `?vary=` is the git
  commit read at **startup**, so a server restarted before a commit serves new bytes under the old URL and
  clients keep a stale copy.
- On Windows `launch-linux.sh` is not the gate; invoke the built DLL directly (see Verify).
- Playwright is not a repo dependency; a fresh machine needs it installed before any harness runs.

## Verify
```powershell
dotnet build src/SwarmUI.csproj --configuration Release --no-incremental
dotnet format SwarmUI.sln --verify-no-changes
dotnet src/bin/Release/net8.0/SwarmUI.dll --ci-test true --launch_mode none --loglevel debug --data_dir <scratch>
Get-ChildItem src/BuiltinExtensions/MobileEnhancements/verify/*.mjs | ForEach-Object { node $_.FullName }
tailscale serve status
```
Last full run 2026-08-23: build 0/0, format clean, boot exit 0, harnesses **218/218**.
