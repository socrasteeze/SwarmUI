# HANDOFF

**Updated:** 2026-08-22 · **Branch:** claude/swarmui-tailnet-https-wryhg2 · **Base:** d527a5e (= origin/main) · **Tree:** clean

## State
No code changed this session. It answered one question: how to reach this instance over HTTPS on the
tailnet without changing the port. The answer is config plus Tailscale `serve` — no patch is needed
unless we decide Swarm should terminate TLS itself (Open 2). The 2026-08-21 upstream merge that the
last handoff listed as unpushed is now on `origin/main`.

## Open
1. Run the .NET gates on the workstation against the current tree. No SDK exists in this container, and
   there is no record that `dotnet build` / `dotnet format` / the ci-test boot ever ran against the
   upstream merge before it was pushed.
2. Decide whether Swarm should terminate TLS itself. It cannot today: `HostURL` is hardcoded to `http://`
   (`src/Core/WebServer.cs:42`) and `NetworkData` has no cert fields (`src/Core/Settings.cs:240`). Cost is
   a cert path pair plus a Kestrel `ListenAnyIP(port, o => o.UseHttps(...))` in `Prep()`
   (`src/Core/WebServer.cs:131`) — and owning cert renewal. Only worth it if the proxy route is rejected.
3. If the proxy route is taken: blank `Network.AuthBypassIPs` whenever `RequiredAuthorization` is set, and
   point `Network.ExternalURL` at the https URL. Both are Server Settings, not code.
4. Genpage image-editor clipboard fix, still waiting on the fork owner — `pasteSelectionFromClipboard` has
   no rejection handler and its fallback is a one-line input:
   `src/wwwroot/js/genpage/helpers/image_editor.js:622`, `src/Pages/_Generate/GenTabModals.cshtml:294`.
   Both are upstream core files, so it is a merge-cost call, not a technical one.
5. Pre-existing failure in `verify-simple-create-panel.mjs`: "batch group right edge matches Prefix"
   (42/43). Present before the clipboard work too. Nobody has checked whether it is a real misalignment
   or a harness tolerance.

## Decisions
- Tailscale `serve` terminates TLS, Swarm stays plain HTTP bound to loopback — `serve` binds only the
  tailnet interface, so the same port number is still free there and the port does not have to change.
- Proxy-side cert over a Swarm-side one — `serve` renews on its own; a Swarm-side cert would be a manual
  renewal every ~90 days for a feature one machine uses.
- No code written for this — the question was answerable with existing settings, and fork law keeps
  core-file edits last.

## Traps
- **`RequiredAuthorization` is bypassed behind any local reverse proxy.** The check compares the socket
  peer against `Network.AuthBypassIPs`, which lists loopback by default — `src/Core/WebServer.cs:180-192`.
  Every proxied client arrives as loopback, so the header requirement silently stops applying.
- The account-login localhost bypass switches off only when an `X-Forwarded-For` header is present
  (`src/Utils/WebUtil.cs:317`). Confirm from a second device that a login is still demanded.
- Setting `Network.Host` to `0.0.0.0` or `*` claims the port on every interface and kills the same-port
  trick. It must stay on loopback for that to work.
- **Release builds cache extension assets in memory.** Any edit to a `/simple`, MobileEnhancements or
  TagDex asset is invisible until the server restarts — no hard-refresh helps. See "Editing extension
  assets" in `AGENTS.md`.
- Playwright is **not** a repo dependency. The verify harnesses need it installed separately; they are
  opt-in, not part of the CI gate.
- No .NET SDK in this container. Anything in Verify that starts with `dotnet` cannot run here.

## Verify
```powershell
dotnet build src/SwarmUI.csproj --configuration Release
dotnet format SwarmUI.sln --verify-no-changes
./launch-linux.sh --ci-test true --launch_mode none --loglevel debug
node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-clipboard-paste.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-create-panel.mjs
```
Nothing was run this session — no code changed.
