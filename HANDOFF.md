# HANDOFF

**Updated:** 2026-08-23 · **Branch:** main · **Base:** a4c63d8a (= origin/main) · **Tree:** clean

## State
A home-screen install now follows the UI it was started from: Genpage installs to `/Text2Image`, `/simple`
still installs to `/simple`. Confirmed on-device. The return link that overlapped the tabs is now docked.

## Done this session
- **Per-UI web manifest** — `MobileEnhancementsExtension.cs`. Razor pages link `/manifest.json?ui=classic`;
  `ServeManifest` rewrites that variant's `start_url`, `id` and shortcut to `/Text2Image`, and responses are
  now `Cache-Control: no-cache`. Cause: a browser takes `start_url` from the manifest, not from the page
  being installed, so every Add to Home Screen landed on `/simple`. Fork Delta updated.
- **"Mobile UI" return link docked into `#toptablist`** — `mobile_core.js`. The fixed top-right pill covered
  whichever tab sat under it, permanently once Genpage became an install of its own. Fixed pill kept as the
  fallback for pages with no tab strip.

## Open
1. **Verify the docked "Mobile UI" link on-device** — force-quit the Classic app so it re-fetches assets,
   then confirm the link rides at the end of the tab strip and covers no tab. The install itself is confirmed.
2. Genpage still has no verify harness; the clipboard work was hand-checked, and two of its paths (default
   paste, real iOS long-press) are unreachable by synthetic events anyway.
3. No authentication is set. If it is ever enabled, blank `Network.AuthBypassIPs` in the same edit.
4. Metadata pull is per-model only (card → Edit Metadata → CivitAI URL → Load → Save); no bulk scan exists
   here. Nothing pulled yet — do a few and confirm the sidecars land before working through the library.
5. 23 sweep candidates parked pending product decisions — `docs/TagDex-Plan.md`, `docs/MobilePWA-Optimization-Plan.md`.

## Decisions
- **Two manifest variants, and `id` moves with `start_url`.** `id` is how Chromium tells installed apps
  apart — both on `"/"` means the second install updates the first. Classic uses `/Text2Image`, not `/`.
- `tailscale serve` over Swarm-side TLS — it self-renews; Swarm would need core edits plus manual renewal.
- **Proxy on its own TLS port; Swarm stays on `0.0.0.0`.** `serve` intercepts inside tailscaled, below the
  socket layer, and owns the tailnet side of its port expecting TLS — hence not Swarm's, where it 400'd
  plain HTTP. Ports are PWA origins; reinstall after a move.
- **Model metadata writes `.swarm.json` sidecars, not safetensors headers.** A header rewrite flattened LoRA
  architecture and titles last time and is not reversible. Keep `Paths.ClearStrayModelData` and
  `EditMetadataAcrossAllDups` false — the first deletes what the sidecar extension repairs from.

## Traps
- **`dotnet build --configuration Release` does not update the running server.** It writes `src/bin/Release`;
  the launcher runs `src/bin/live_release`, rebuilt only when `src/bin/must_rebuild` exists or the exe is gone.
- **`RequiredAuthorization` is bypassed behind any local reverse proxy**, `serve` included — it compares the
  socket peer against `Network.AuthBypassIPs` (loopback by default), and proxied requests arrive as loopback.
- **HTTPS needs the MagicDNS name, not the tailnet IP** — the cert is issued for the hostname, so the raw
  tailnet IP fails its cert check. Plain HTTP on Swarm's own port is unaffected on every interface.
- **A running server blocks three things**: a `--ci-test` boot (collides over `Data/Users.ldb` — pass an
  isolated `--data_dir`), a rebuild, and editing `Data/Settings.fds`. Stop it via `ShutdownServer`, not a kill.
- **Release builds cache extension assets in memory** — asset edits need a restart. `?vary=` is the git
  commit read at **startup**, so a restart before a commit serves new bytes under the old URL.
- On Windows the gate is the built DLL, not `launch-linux.sh`. Playwright is not a repo dependency.

## Verify
```powershell
dotnet build src/SwarmUI.csproj --configuration Release --no-incremental
dotnet format SwarmUI.sln --verify-no-changes
dotnet src/bin/Release/net8.0/SwarmUI.dll --ci-test true --launch_mode none --loglevel debug --data_dir <scratch>
Get-ChildItem src/BuiltinExtensions/MobileEnhancements/verify/*.mjs | ForEach-Object { node $_.FullName }
tailscale serve status
```
2026-08-23: build 0/0, format clean, boot exit 0. Playwright harnesses **not re-run** — this change is C# only.
