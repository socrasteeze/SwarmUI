# HANDOFF

**Updated:** 2026-08-23 · **Branch:** main · **Base:** c4b8f5ef (= origin/main) · **Tree:** docs edits unpushed

## State
The fork is reachable over HTTPS on the tailnet (own TLS port) while every plain-HTTP path still works.
Model metadata now writes to sidecars instead of safetensors headers. Nothing pushed this session.

## Done this session
- **Tailnet HTTPS**, one `tailscale serve` proxy — see Decisions, written up in `docs/Tailnet-HTTPS.md`.
- **`Metadata.EditMetadataWriteJSON` set true** via `ChangeServerSettings`, which ends in `ReapplySettings()`
  and restarts the server — a dropped connection right after that call is the restart, not a fault.
- Genpage paste modal box is now `contenteditable` with an `<img>` read-back path, so a phone will offer
  Paste over it — `GenTabModals.cshtml` + `image_editor.js`, `c4398e40`. Browser-verified, 10 behaviours.
- Investigated the installed-app bottom-nav gap and **accepted it**; its CSS fix (`0fa1aaa5`) was reverted
  same-day (`380144fd`) once device data killed it. Write-up in the mobile plan doc.

## Open
1. Genpage still has no verify harness; the clipboard work was checked by hand. Two of its links are
   unreachable by synthetic events anyway — the browser's own default paste, and a real iOS long-press.
2. No authentication is set. If it is ever enabled, blank `Network.AuthBypassIPs` in the same edit — see Traps.
3. Metadata pull is per-model only (card → Edit Metadata → CivitAI URL → Load → Save); no bulk scan exists
   here. Nothing pulled yet — do a few and confirm the sidecars land before working through the library.
4. 23 sweep candidates stay parked, each needing a product decision — TagDex browser pass and batch sweep,
   Prompt Coach, mobile Phase 5, PWA icons. See `docs/TagDex-Plan.md`, `docs/MobilePWA-Optimization-Plan.md`.

## Decisions
- `tailscale serve` over Swarm-side TLS — it renews its own cert; Swarm would need core edits to two
  upstream files plus ~90-day manual renewal.
- **Proxy on its own TLS port; Swarm stays on `0.0.0.0`.** `serve` intercepts inside tailscaled, below the
  host socket layer, so it never contends with Swarm's bind and loopback is not required (an earlier session
  claimed otherwise; wrong). It owns the tailnet side of whatever port it holds and expects TLS there — hence
  not Swarm's port, where it 400'd the plain-HTTP tailnet URL. Ports are PWA origins; reinstall after a move.
- **Model metadata writes `.swarm.json` sidecars, not safetensors headers.** A header rewrite is what
  flattened LoRA architecture and titles last time, and it is not reversible; a sidecar is just deletable.
  `Paths.ClearStrayModelData` must stay false, or a save deletes the StabilityMatrix `.cm-info.json` files
  that `SidecarMetadataExtension` needs to repair from. `Paths.EditMetadataAcrossAllDups` stays false too.

## Traps
- **`RequiredAuthorization` is bypassed behind any local reverse proxy**, `serve` included — it compares the
  socket peer against `Network.AuthBypassIPs` (loopback by default), and proxied requests arrive as loopback.
- **HTTPS needs the MagicDNS name, not the tailnet IP** — the cert is issued for the hostname, so the raw
  tailnet IP fails its cert check. Plain HTTP on Swarm's own port is unaffected on every interface.
- **A running server blocks three things**: a `--ci-test` boot (collides over `Data/Users.ldb` — pass an
  isolated `--data_dir`), a rebuild, and editing `Data/Settings.fds` (rewritten on exit — use the API or UI).
  Stop it via `ShutdownServer`, never a hard kill.
- **Release builds cache extension assets in memory** — asset edits need a restart. `?vary=` is the git commit
  read at **startup**, so a server restarted before a commit serves new bytes under the old URL.
- On Windows `launch-linux.sh` is not the gate; invoke the built DLL directly (see Verify). Playwright is
  not a repo dependency either; a fresh machine needs it installed before any harness runs.

## Verify
```powershell
dotnet build src/SwarmUI.csproj --configuration Release --no-incremental
dotnet format SwarmUI.sln --verify-no-changes
dotnet src/bin/Release/net8.0/SwarmUI.dll --ci-test true --launch_mode none --loglevel debug --data_dir <scratch>
Get-ChildItem src/BuiltinExtensions/MobileEnhancements/verify/*.mjs | ForEach-Object { node $_.FullName }
tailscale serve status
```
Last full run 2026-08-23: build 0/0, format clean, boot exit 0, harnesses **218/218**.
