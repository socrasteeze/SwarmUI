# Serving this fork over HTTPS on a Tailscale tailnet

Fork-owned doc. How this instance is reached over HTTPS from phones and tablets on the tailnet, why it is
done this way, and what was tried and rejected first.

Placeholders: `${TS_HOST}` is the node's MagicDNS name (`tailscale status --json` → `Self.DNSName`),
`${PORT}` is SwarmUI's configured web port (`Network.Port` in `Data/Settings.fds`).

## Why HTTPS at all

`navigator.clipboard` is **undefined outside a secure context**. A LAN address over plain HTTP is insecure
by that rule no matter how local it is, so `/simple`'s clipboard button, and every other secure-context-only
web API, had no native path on a phone. `docs/MobilePWA-Optimization-Plan.md` and the `/simple` clipboard
Fork Delta entry in `AGENTS.md` both describe the fallbacks written to work around that. HTTPS removes the
need for those fallbacks rather than replacing them — they stay as the path for any browser that still
refuses.

## What is configured

One `tailscale serve` proxy. Nothing else — no change to SwarmUI's own settings, no cert handling in Swarm.

```bash
tailscale serve --bg --https=${PORT} http://localhost:${PORT}
```

Result: `https://${TS_HOST}:${PORT}/` reaches SwarmUI, with a valid Tailscale-issued certificate, for
tailnet devices only. `--bg` persists the config across reboots.

To remove it completely:

```bash
tailscale serve --https=${PORT} off
```

## Why the same port works, and why Swarm stays on all interfaces

**SwarmUI keeps `Network.Host: 0.0.0.0`.** It does not need to move to loopback, and it should not.

`serve` is handled inside `tailscaled`: it intercepts tailnet traffic to that port before the packets reach
the host socket layer, so it does not contend with SwarmUI's `0.0.0.0:${PORT}` bind. Both coexist on the
same port number. Verified: HTTPS on the tailnet, plain HTTP on the LAN, and plain HTTP on localhost all
return 200 simultaneously.

**This corrects an earlier conclusion.** A previous session recorded that `Host: 0.0.0.0` "claims the port
on every interface and kills the same-port trick", and that Swarm had to be moved to loopback first. That
was wrong. Moving Swarm to loopback does work, but it costs all LAN access for no gain, and it was reverted.
If a note anywhere still says loopback is required, it is stale.

## Rejected alternatives

- **Swarm terminating TLS itself.** `HostURL` is hardcoded to `http://` (`src/Core/WebServer.cs`) and
  `NetworkData` has no cert fields, so it would need core edits to two upstream files plus roughly 90-day
  manual cert renewal. `serve` renews on its own. Fork law makes core edits a last resort.
- **Moving Swarm to loopback.** Applied, verified, then reverted — see above. It breaks LAN access for every
  device not on the tailnet, and buys nothing that the same-port `serve` does not already give.
- **Funnel.** Not used. `serve` is tailnet-only; funnel would publish to the public internet, which is not
  wanted and would matter a great deal given the auth gap below.

## Behavior changes to know about

- **Plain HTTP to the tailnet IP on that port now returns 400.** `serve` owns the tailnet side of the port
  and expects TLS. Tailnet devices must use the `https://${TS_HOST}:${PORT}/` URL. LAN and localhost HTTP
  are unaffected.
- **A phone on the tailnet now gets a secure context**, so `/simple`'s clipboard button takes the native
  `navigator.clipboard` path instead of the paste-sheet fallback. On iOS this still costs one confirmation
  tap — see the caveat below.
- The installed PWA treats `https://${TS_HOST}:${PORT}` as a **different origin** from any `http://` LAN
  address: separate service worker, separate cache, separate install.

## iOS caveat: the extra Paste tap is not ours

On iOS, `navigator.clipboard.read()` raises a **native Safari "Paste" confirmation** that the user must tap,
once per call. It cannot be suppressed, pre-granted, or bypassed by page code, and HTTPS does not remove it.
Two gestures — tap the button, then confirm the paste — is the floor on iOS. Anything beyond two is a bug in
this fork's code, not a browser rule; see the `/simple` clipboard entry in `AGENTS.md`, which documents a
third tap that was a real defect and was fixed.

The zero-confirmation path still exists and is unchanged: long-press directly in the prompt box and choose
Paste. A paste **event** carries its own data with no permission check and no secure-context rule.

## Security gap that this does not close

`serve` adds TLS. It adds **no authentication**. With `Network.RequiredAuthorization` empty, every device on
the tailnet reaches SwarmUI unauthenticated.

If authentication is ever enabled, **blank `Network.AuthBypassIPs` in the same edit, never after.** The
check compares the socket peer against that list, which contains loopback by default
(`src/Core/WebServer.cs`). Behind `serve` every proxied request arrives as loopback, so the authorization
requirement would silently stop applying — see the trap of the same name in `AGENTS.md`.

## Verify

```bash
tailscale serve status
curl -o /dev/null -w "%{http_code} cert=%{ssl_verify_result}\n" https://${TS_HOST}:${PORT}/Text2Image
curl -o /dev/null -w "%{http_code}\n" http://localhost:${PORT}/Text2Image
```

Expected: a serve config listing the proxy, `200 cert=0` over HTTPS, and `200` on localhost.
