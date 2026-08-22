# HANDOFF

**Updated:** 2026-08-22 · **Branch:** main · **Base:** local `main`, unpushed · **Tree:** see Open 0

## State
An ultrasweep ran and **halted at recon: zero actionable work.** 23 candidates were collected from the
tracked markdown and every one was parked — needing a human decision, already true of the code, or not a
task at all. The full classification is in Parked below.

What did change: the stalled `origin/main` merge was completed (`5974a983`), its `AGENTS.md` conflict
resolved (duplicate 2026-08-21 sync entries — kept the detailed pushed version, grafted on the workstation
gate results), the tailnet HTTPS handoff adopted from the cloud branch (`8f51ff2f`), and two stale lines in
the mobile/PWA plan corrected.

**The verification gate now actually ran, and passes.** This closes the open item that has been carried
since 2026-08-14. Prior handoffs claimed "no .NET SDK in this container" — that was true of the cloud
containers, and **false on this workstation**: SDK 8.0.417 and 10.0.103 are installed and
`src/SwarmUI.csproj` targets `net8.0`.

## Open
0. **Nothing is pushed.** Four local commits sit ahead of `origin/main`. Also delete the merged cloud
   branch `origin/claude/swarmui-tailnet-https-wryhg2` once its content is confirmed landed.
1. ~~Run the .NET gates.~~ **Done — all three pass. See Verify.**
2. Decide whether Swarm should terminate TLS itself. It cannot today: `HostURL` is hardcoded to `http://`
   (`src/Core/WebServer.cs:42`) and `NetworkData` has no cert fields (`src/Core/Settings.cs`). Cost is a
   cert path pair plus a Kestrel `ListenAnyIP(port, o => o.UseHttps(...))` in `Prep()` — and owning cert
   renewal. Only worth it if the proxy route is rejected, which nobody has done. Two core-file edits, so
   fork law makes it a last resort.
3. If the proxy route is taken: blank `Network.AuthBypassIPs` whenever `RequiredAuthorization` is set, and
   point `Network.ExternalURL` at the https URL. Both live in the running server's `Data/Settings.fds`,
   not in the tracked tree — no commit results.
4. Genpage image-editor clipboard fix, still waiting on the fork owner. Confirmed still true of the code:
   the `navigator.clipboard.read()` promise chain at `src/wwwroot/js/genpage/helpers/image_editor.js:622`
   has no `.catch()`, and its modal fallback is a one-line input
   (`src/Pages/_Generate/GenTabModals.cshtml:294`). Both are upstream core files, so it is a merge-cost
   call. The `/simple` side of the same gap already shipped (`openPasteSheet`, `ffef175e`/`d762b0f0`).
5. Pre-existing `verify-simple-create-panel.mjs` failure: "batch group right edge matches Prefix" (42/43).
   The assertion is `Math.abs(last.right - prefixBox.right) <= 1` at that harness's line 294, so resolving
   it means choosing between a layout fix in `m.css`/`m_create.js` and loosening the tolerance — that
   choice *is* the open question. Not runnable here: Playwright does not resolve (deliberately not a repo
   dependency).

## Parked (from the sweep — each needs a decision you have not made)
- **Mobile/PWA:** in-viewer `navigator.share({files})` button (deferred with the §2c overlay chrome that
  tap-to-toggle replaced); `ImageCompareHelper` touch parity (§2a pre-authorized the deferral); sidebar
  swipe animation polish (§3.3, explicitly gated on "revisit with a browser in hand"); Phase 5 items 1
  and 3; `sw.js` thumbnail runtime cache (self-gated at "only if <=40 extra lines").
- **TagDex:** the browser pass is the real outstanding gate — nobody has clicked a card, and thumbnail
  generation has never run. The batch thumbnail sweep and the `/simple` browse sheet are both unbuilt and
  unspecified (button placement, cancel semantics, sheet layout all undecided), with no verify harness.
- **Prompt Coach** (`docs/SimplePromptCoach-Plan.md`): self-classified backburner, nothing started.
- **Not tasks:** 25 upstream doc `(TODO)` author-notes and the AutoScalingBackend wishlist — upstream-owned
  files this fork can never contribute back; the `isSmallWindow` dedupe and multi-word typeahead wart are
  both filed under explicit rejections; PWA icon replacement is blocked on a source logo that does not exist.

## Traps
- **`RequiredAuthorization` is bypassed behind any local reverse proxy.** The check compares the socket
  peer against `Network.AuthBypassIPs`, which lists loopback by default — `src/Core/WebServer.cs:180-192`.
  Every proxied client arrives as loopback, so the header requirement silently stops applying.
- The account-login localhost bypass switches off only when an `X-Forwarded-For` header is present
  (`src/Utils/WebUtil.cs`). Confirm from a second device that a login is still demanded.
- Setting `Network.Host` to `0.0.0.0` or `*` claims the port on every interface and kills the same-port
  tailnet trick. It must stay on loopback.
- **A ci-test boot collides with a running SwarmUI** over `Data/Users.ldb` (LiteDB holds an exclusive
  lock) and dies with an unhandled `IOException`. Pass an isolated `--data_dir`; do not kill the server.
- **On Windows, `launch-linux.sh` is not the gate.** Invoke the built DLL directly — see Verify.
- **Release builds cache extension assets in memory.** Any edit to a `/simple`, MobileEnhancements or
  TagDex asset is invisible until restart. See "Editing extension assets" in `AGENTS.md`.
- Playwright is **not** a repo dependency; the verify harnesses are opt-in and need it installed separately.

## Decisions
- Tailscale `serve` terminates TLS; Swarm stays plain HTTP bound to loopback. `serve` binds only the
  tailnet interface, so the same port number stays free there and the port does not have to change.
- Proxy-side cert over a Swarm-side one — `serve` renews itself; a Swarm-side cert is manual renewal
  every ~90 days for a feature one machine uses.

## Verify
All three ran on this workstation on 2026-08-22 against the current tree. **All pass.**
```powershell
dotnet build src/SwarmUI.csproj --configuration Release --no-incremental
dotnet format SwarmUI.sln --verify-no-changes
dotnet format style SwarmUI.sln --verify-no-changes
dotnet src/bin/Release/net8.0/SwarmUI.dll --ci-test true --launch_mode none --loglevel debug --data_dir <scratch>
```
Build: 0 warnings, 0 errors. Both format gates: exit 0. Isolated ci-test boot: exit 0, reached "is now
running", clean shutdown, zero real errors — the only log hits are two `0 Error(s)` build summaries and
four `NU1900` notices from nuget.org being unreachable for vulnerability data. Neither pre-existing
extension error (VideoStages rename, SeedVR2 duplicate key) reappeared; both were fixed 2026-08-20.

Not run: the Playwright harnesses (`verify-simple-*.mjs`) — not installed here.
