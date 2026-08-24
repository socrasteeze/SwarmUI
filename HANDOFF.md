# HANDOFF

**Updated:** 2026-08-23 · **Branch:** main · **Base:** a4c63d8a (= origin/main) · **Tree:** clean

## State
A home-screen install now follows the UI it was started from: Genpage installs to `/Text2Image`, `/simple`
still installs to `/simple`. Rebuilt and restarted; both manifest variants verified live, not on-device.

## Done this session
- **Per-UI web manifest** — `MobileEnhancementsExtension.cs`. `BuildHeadTags(bool classic)` links
  `/manifest.json?ui=classic` from Razor pages; `ServeManifest` rewrites that variant's `start_url`, `id`
  and `Generate` shortcut to `/Text2Image`; responses are now `Cache-Control: no-cache`. Cause: a browser
  takes `start_url` from the manifest, not from the page being installed, and one manifest was linked from
  every page — so every Add to Home Screen landed on `/simple`. Fork Delta entry updated.

## Open
1. **Verify the Genpage install on-device** — delete the home-screen icon, re-add from the Genpage URL,
   confirm it opens `/Text2Image`. Install-time capture means an existing icon never migrates itself.
2. Genpage still has no verify harness; the clipboard work was hand-checked, and two of its paths (default
   paste, real iOS long-press) are unreachable by synthetic events anyway.
3. No authentication is set. If it is ever enabled, blank `Network.AuthBypassIPs` in the same edit.
4. Metadata pull is per-model only (card → Edit Metadata → CivitAI URL → Load → Save); no bulk scan exists
   here. Nothing pulled yet — do a few and confirm the sidecars land before working through the library.
5. 23 sweep candidates stay parked pending product decisions — TagDex, Prompt Coach, mobile Phase 5, PWA
   icons; see `docs/TagDex-Plan.md` and `docs/MobilePWA-Optimization-Plan.md`.

## Decisions
- **Two manifest variants, and `id` moves with `start_url`.** `id` is how Chromium tells installed apps
  apart — both on `"/"` means the second install updates the first. Classic uses `/Text2Image`, not `/`.
- `tailscale serve` over Swarm-side TLS — it self-renews; Swarm would need core edits plus manual renewal.
- **Proxy on its own TLS port; Swarm stays on `0.0.0.0`.** `serve` intercepts inside tailscaled, below the
  host socket layer, so it never contends with Swarm's bind. It owns the tailnet side of the port it holds
  and expects TLS — hence not Swarm's port, where it 400'd plain HTTP. Ports are PWA origins; reinstall.
- **Model metadata writes `.swarm.json` sidecars, not safetensors headers.** A header rewrite flattened LoRA
  architecture and titles last time and is not reversible; a sidecar is deletable. Keep
  `Paths.ClearStrayModelData` and `EditMetadataAcrossAllDups` false — the first deletes what it repairs from.

## Traps
- **`dotnet build --configuration Release` does not update the running server.** It writes `src/bin/Release`;
  the launcher runs `src/bin/live_release`, rebuilt only when `src/bin/must_rebuild` exists or the exe is gone.
- **`RequiredAuthorization` is bypassed behind any local reverse proxy**, `serve` included — it compares the
  socket peer against `Network.AuthBypassIPs` (loopback by default), and proxied requests arrive as loopback.
- **HTTPS needs the MagicDNS name, not the tailnet IP** — the cert is issued for the hostname, so the raw
  tailnet IP fails its cert check. Plain HTTP on Swarm's own port is unaffected on every interface.
- **A running server blocks three things**: a `--ci-test` boot (collides over `Data/Users.ldb` — pass an
  isolated `--data_dir`), a rebuild, and editing `Data/Settings.fds` (rewritten on exit — use the API or UI).
  Stop it via `ShutdownServer`, never a hard kill.
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
