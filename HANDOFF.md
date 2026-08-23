# HANDOFF

**Updated:** 2026-08-22 · **Branch:** main · **Base:** `origin/main` at `80e16c3d` (pushed) · **Tree:** clean

## State
An ultrasweep ran and **halted at recon: zero actionable work.** 23 candidates were collected from the
tracked markdown and every one was parked — needing a human decision, already true of the code, or not a
task at all. The full classification is in Parked below.

What did change: the stalled `origin/main` merge was completed (`5974a983`), its `AGENTS.md` conflict
resolved (duplicate 2026-08-21 sync entries — kept the detailed pushed version, grafted on the workstation
gate results), the tailnet HTTPS handoff adopted from the cloud branch (`8f51ff2f`), and stale lines in the
mobile/PWA plan corrected. All of that is pushed.

Then three of the five open items were closed on the owner's go-ahead: the tailnet TLS decision was
confirmed (proxy route, no Swarm-side cert), and the **genpage image-editor clipboard rejection** was
fixed — a core-file edit, so it carries a Fork Delta entry and a coupling-watchlist row. A three-lens
adversarial review of that fix found five issues including one blocking; all five were applied. Notably it
killed a `shown.bs.modal` re-focus this session first wrote: `WebUtil.ModalHeader` emits a non-`fade`
modal, so Bootstrap's callback is synchronous and the existing `box.focus()` already wins. The constructor
is back to byte-identical upstream.

**The verification gate now actually ran, and passes.** This closes the open item that has been carried
since 2026-08-14. Prior handoffs claimed "no .NET SDK in this container" — that was true of the cloud
containers, and **false on this workstation**: SDK 8.0.417 and 10.0.103 are installed and
`src/SwarmUI.csproj` targets `net8.0`.

## Open
0. ~~Push, and delete the merged cloud branch.~~ **Done — `origin/main` is at the pushed merge, and
   `claude/swarmui-tailnet-https-wryhg2` is deleted.** The genpage clipboard work after it is committed
   locally; push state is noted in the header.
1. ~~Run the .NET gates.~~ **Done — all three pass. See Verify.**
2. ~~Decide whether Swarm should terminate TLS itself.~~ **Decided 2026-08-22: no — take the Tailscale `serve` proxy route (see Decisions).**
   Kept only as a cost record, should the proxy route ever be abandoned: Swarm cannot do this today —
   `HostURL` is hardcoded to `http://` (`src/Core/WebServer.cs:42`) and `NetworkData` has no cert fields
   (`src/Core/Settings.cs`). The cost would be a cert path pair plus a Kestrel
   `ListenAnyIP(port, o => o.UseHttps(...))` in `Prep()`, two core-file edits, and owning cert renewal.
3. **Owner action, not code.** The proxy route is now the decided path, so before exposing it: blank `Network.AuthBypassIPs` whenever `RequiredAuthorization` is set, and
   point `Network.ExternalURL` at the https URL. Both live in the running server's `Data/Settings.fds`,
   not in the tracked tree — no commit results.
4. ~~Genpage image-editor clipboard fix.~~ **Rejection half done (2026-08-22).** `navigator.clipboard.read()`
   rejection now routes to the paste modal, and a successful paste into that modal closes it and confirms
   (it previously dropped the layer behind the backdrop silently). Core-file edit, recorded in the Fork
   Delta and the coupling watchlist. **The mobile half then followed:** the modal box is now a
   `contenteditable` div instead of `<input type="text" maxlength="0">`, so a phone will offer Paste over
   it, and a pasted `<img>` with no file behind it is read back out. That makes
   `src/Pages/_Generate/GenTabModals.cshtml` a second diverged core file, with its own Fork Delta entry.
   **Still not browser-verified** — no harness covers genpage, and checking it on the running server needs
   a restart because `.cshtml` is compiled. That restart is the outstanding step here.
5. ~~Pre-existing `verify-simple-create-panel.mjs` failure (42/43).~~ **Resolved 2026-08-22 — harness gap,
   not a misalignment. No production code changed.** The Prefix row is hidden unless the session advertises
   `filenameprefix`, and the harness never boots, so the check compared a real edge against a zero rect and
   could never have passed. The batch group was correctly aligned all along (`gap 0px`). Detail in
   `AGENTS.md`. Playwright is now installed locally, so the whole suite runs: **218/218 across all 7
   harnesses.**

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
- **Confirmed 2026-08-22.** Swarm-side TLS is rejected, not merely deferred: it would mean core edits to
  `WebServer.cs` and `Settings.cs` for a single machine's convenience. Open items 2 and 3 close on this.
  The remaining work is server settings the owner applies to the running instance — nothing in the tree.

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

Playwright 1.62.1 + chromium-1234 are now installed locally (gitignored — still deliberately *not* a repo
dependency, so `npm install playwright && npx playwright install chromium` is needed on a fresh machine).
All 7 harnesses pass, the first full-suite run: `verify-mobile-layout` 11/11, `verify-mobile-perf` 45/45,
`verify-simple-clipboard-paste` 26/26, `verify-simple-create-panel` 44/44, `verify-simple-error-banner`
22/22, `verify-simple-image-editor` 50/50, `verify-simple-restart` 20/20 — **218/218**.
```bash
for f in src/BuiltinExtensions/MobileEnhancements/verify/*.mjs; do node "$f"; done
```
Still not device-verified: no harness covers genpage, and nobody has used an actual thumb on iOS.
