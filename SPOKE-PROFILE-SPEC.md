# SwarmUI Spoke Profile

**Status:** implemented in this fork. The repository contains the runtime profile,
hub-side negotiation, fail-closed model inventory, mutation guards, launcher, UI state,
and automated tests described below. Production acceptance still requires an OS-enforced
read-only model share and a live two-machine generation test; repository tests cannot
prove either external boundary.

## Mission

A spoke is a GPU worker controlled by one hub. It reads the hub-managed model tree,
executes generations selected by the hub, and returns pixels. It does not manage models,
accept ordinary local generations, update itself, or expose an independent workflow
surface.

The profile closes three failures observed in the original manual deployment:

1. Generate-time hash and metadata paths could rewrite shared safetensors files.
2. The normal 5,000-item model-list cap silently hid models from backend routing.
3. Rich remote model listings embedded thousands of previews and could overflow before
   returning any inventory.

## Activation and immutable state

Start the worker with [launch-spoke.bat](launch-spoke.bat):

```bat
call launch-spoke.bat
```

The wrapper sets `SWARM_SPOKE_LAUNCH=1` and enters the normal fork launcher with
`--spoke true`. `--spoke` is parsed once into `Program.IsSpokeMode`, whose setter is
private. A settings edit cannot disable the profile in the running process. The process
exports `SWARM_RUNTIME_SPOKE=1` only so managed Python nodes can honor the same policy;
that environment variable is not an activation path.

Spoke startup applies these effective, runtime-only controls:

| Control | Effective behavior |
|---|---|
| `Program.IsSpokeMode` | Immutable for the life of the process |
| `Program.LockSettings` | `true` |
| `Metadata.ModelMetadataPerFolder` | `false`; the spoke does not place databases in the shared tree |
| `Metadata.ImageMetadataIncludeModelHash` | `false`; generation does not request a model-header resave |
| Server settings UI | Every field is read-only; synthetic `Spoke.Enabled` reports runtime state |
| `ChangeServerSettings` | Rejected server-side while spoke mode is active |

The effective overrides are not a persisted `Spoke` settings group. Stop the process and
restart without `--spoke` to return to normal workstation behavior.

## Mandatory external security boundary

The application guard is defense in depth. The model share itself must be read-only to
the account used by the spoke:

- Grant read, list, and execute/traverse only.
- Deny create, write, append, modify, rename, move, and delete at both share and filesystem
  permission layers.
- Do not give the spoke a second writable credential or path to the same model storage.
- Keep the spoke's `Data`, temporary, and backend working directories local and writable.

Before production use, prove the boundary from the exact Windows account and interactive
session that launches the spoke. Harmless create, rename, and delete probes inside a
designated test folder must fail. Capture hashes for the generation target and its
sidecars before and after the live generation. Directory timestamps are not proof of
read-only behavior and do not detect in-place header edits.

Mapped drives are session-scoped. Run `launch-spoke.bat` from the interactive session that
owns the mapping, or use a UNC path with the same read-only credential. Operator-specific
paths, hostnames, and addresses belong in the ignored private runbook, not this file.

## Network and controller contract

Spoke startup fails if `Network.RequiredAuthorization` is blank. Configure it while the
server is stopped, then set the hub's Swarm-API backend `AuthorizationHeader` to the exact
same value. The setting is marked secret in settings metadata.

Bind `Network.Host` to the intended LAN or Tailscale interface and restrict the listener
to the hub with the host firewall. Spoke mode rejects ngrok and Cloudflare tunnel startup,
including a persisted `Network.CloudflaredPath`. It also disables listener port drift:
if the configured or command-line web port is occupied, startup fails instead of choosing
another port. This gives the hub a stable endpoint. `--no-ui` is not a security boundary
and is not part of this profile.

Managed Comfy self-start always appends a final `--listen 127.0.0.1` in spoke mode, so a
persisted `--listen 0.0.0.0` cannot expose the raw Comfy API. External Comfy API backends
must use a loopback URL. The operator must also verify that an externally managed Comfy
process is bound to loopback or blocked by the host firewall; Swarm cannot change another
process's listener.

The hub creates a session with `spokeController: true`. On an active spoke, controller
elevation requires the exact configured `Authorization` header even when the source IP is
otherwise eligible for an authorization bypass. The response advertises both
`spoke_mode: true` and `spoke_controller: true`. Controller sessions are memory-only and
are not written to the session database. Swarm backends close them during normal shutdown.
The spoke also removes idle controller sessions after ten minutes, so network loss cannot
leave valid controller capabilities accumulating in memory.

Every API registered as state-changing is rejected unless its source session is an
authorized spoke controller. This covers generation, model selection, interruption,
memory release, restart, shutdown, settings, and extension operations even when a local
address would normally bypass authentication. Normal authenticated browser sessions can
inspect permitted status surfaces only. A hub should configure its Swarm-API backend as
follows:

| Hub backend field | Requirement |
|---|---|
| `Address` | The spoke's fixed HTTP endpoint |
| `AuthorizationHeader` | Exact match for the spoke's `Network.RequiredAuthorization` |
| `RequireSpokeMode` | `true`; fail closed rather than accepting a normal workstation |
| `AllowForwarding` | Not used for a negotiated spoke; nested remote backends are excluded |

## Model-tree and runtime write policy

[SpokeModePolicy.cs](src/Core/SpokeModePolicy.cs) provides two typed refusals. They are
operation guards, not path-prefix heuristics:

- `AssertModelTreeWriteAllowed` blocks managed model-tree changes.
- `AssertRuntimeMutationAllowed` blocks managed dependency and runtime changes.

The API layer serializes a `SpokeModeWriteException` as HTTP 409 with
`error_id: spoke_read_only`. Current guarded model operations include:

- safetensors/header and `.swarm.json` metadata resaves;
- metadata edit and wipe;
- model download, delete, rename, and pickle conversion;
- common-model and workflow-required downloads;
- model-directory creation during refresh or Comfy startup;
- TensorRT output and LoRA extraction;
- known download-on-use Comfy, Florence-2, WD14, SAM2, GIMM-VFI, and CLIPSeg paths.

Hashing may still run in memory, but spoke mode never follows it with `ResaveModel`.
Missing or unreadable required model directories are not created. Their model-subtype
scan is marked failed so the hub cannot route against a partial view. Optional secondary
multi-root paths retain normal Swarm semantics and are skipped when absent.

Current guarded runtime operations include server setting changes, core/backend update-and-
restart, extension install/update/enable/disable/uninstall, .NET installation, Comfy feature
installation, PyTorch updates, dependency repair, managed-node updates, and Comfy auto-
update. `launch-windows.bat` also skips its `always_pull` path when entered through the
spoke wrapper.

The direct Comfy proxy is default-deny in spoke mode. It permits only authenticated
`GET /ComfyBackendDirect/object_info` and `/api/object_info`, which the hub needs to
learn node capabilities. Every WebSocket and every POST route is refused, including
prompt, queue, manager, install, and update aliases. Normal generation also rejects raw
and stored custom Comfy workflows before backend selection. Custom-workflow save and
delete routes are runtime mutations and are refused.

## Safe restart

`RestartServer` is separate from `UpdateAndRestart`. It performs no pull, update, or forced
rebuild and exits with code 42. The Windows launcher re-enters `launch-fork.bat` with the
original arguments, so `--spoke true` survives. `launch-spoke.bat` scopes
`SWARM_FORK_CHECKED=1` to the launch chain, preventing a cold-start or restart from
fetching or changing Git refs. `SWARM_SPOKE_LAUNCH` keeps automatic pull disabled.
Genpage and `/simple` use the plain restart route, but the central controller boundary
still refuses those calls from an ordinary spoke browser session. A controller may invoke
`RestartServer`. Update-and-restart remains refused in spoke mode; `/simple` keeps its
two-phase down/return watcher before reloading on normal instances.

## Compact model inventory protocol v1

Negotiated spokes use `ListModelInventory`, not one rich `ListModels` response per subtype.
The payload contains routing identities only; it never embeds preview images or remote
model metadata.

```json
{
  "version": 1,
  "source_version": "<Swarm version and Git commit>",
  "model_edit_id": 42,
  "allow_remote": false,
  "complete": true,
  "total": 3,
  "returned": 3,
  "truncated": false,
  "parameter_count": 2,
  "parameter_ids": ["height", "width"],
  "subtype_count": 2,
  "subtypes": {
    "LoRA": {
      "complete": true,
      "scan_succeeded": true,
      "total": 2,
      "returned": 2,
      "truncated": false,
      "names": ["alpha.safetensors", "folder/bravo.safetensors"]
    },
    "Stable-Diffusion": {
      "complete": true,
      "scan_succeeded": true,
      "total": 1,
      "returned": 1,
      "truncated": false,
      "names": ["checkpoints/charlie.safetensors"]
    }
  }
}
```

`Performance.ModelInventorySanityCap` defaults to 100,000 names per subtype. Exceeding the
cap is not silent: the subtype and aggregate payloads report their actual `total`, emitted
`returned`, `truncated: true`, and `complete: false`. Any scan error produces an explicitly
incomplete response. The older `Performance.ModelListSanityCap` remains scoped to rich UI
lists and is not used for spoke routing.

The hub validates the entire snapshot before publication:

1. Protocol version is exactly 1.
2. `source_version` exactly matches the hub's `Utilities.VaryID`; hub and spoke therefore
   run the same Swarm version and Git commit.
3. The sorted generation parameter ID set is an exact match.
4. The sorted model-subtype set is an exact match.
5. Every hub-local model name is present in the matching spoke subtype. A spoke may have
   extra names, but they do not substitute for missing hub models.
6. Every scalar has the expected JSON type; counts match payload lengths; names are
   nonempty, unique, and ordinal-sorted; no subtype reports a failed scan or truncation.
7. `allow_remote` matches the request. A negotiated spoke is always requested with
   `allowRemote: false`.
8. The spoke reports at least one running direct generation backend, or one still loading.

Full refreshes are serialized per control backend. Existing routing inventory is cleared
before refresh and a new snapshot is published to the control backend and all child
backends only after every check passes. Any request, parse, scan, parity, coverage, or
backend-availability failure leaves `RemoteInventoryReady=false`, clears routable model
names, and marks the control and affected children unavailable. A child independently
refuses generation while its parent inventory is incomplete.

Remote child instances remain keyed by the spoke's reported backend ID and are reused
across refreshes. Both the generic `AbstractParent` link and the Swarm-specific `Parent`
link are retained, so usage-release timing propagates to the stable parent control
backend. Inventory readiness, source version, edit ID, and count are exposed in full
backend status for diagnosis.

Generic non-spoke Swarm backends keep the rich `ListModels` metadata path but request
`dataImages: false`. Embedded previews can exceed .NET's string capacity on large remote
trees. Relative preview URLs are rewritten to an authenticated hub-local proxy that fetches
and streams one remote preview on demand with the backend's stored session and authorization;
backend credentials never reach the browser. The proxy is raster-only, MIME-sniffed,
byte/pixel bounded, four-request limited, redirect-disabled, path-allowlisted, cancelable,
and capped at three proxy hops. Generic remotes retain their legacy partial-routing behavior
above `ModelListSanityCap` and emit an explicit warning. Strict complete-inventory rejection
applies to negotiated spokes. Compact spoke inventory is deliberately routing-only because
the hub owns the matching local model rows and previews.

## Refresh coupling

`ModelsAPI.ModelEditID` changes when the model view changes. Model refresh, edit, download,
delete, rename, TensorRT creation, and LoRA extraction hold or coordinate with the model
refresh lock, then refresh initialized hub-side remote Swarm inventories. A successful
spoke refresh must acknowledge that it actually ran before the hub requests a new compact
snapshot. Concurrent refreshes cannot interleave partial publication.

If a local hub mutation succeeds but a remote refresh fails, the API reports that the
local mutation completed and remote generation remains blocked until inventory refresh
succeeds. This is fail-closed behavior, not a rollback claim.

## Verification matrix

### Repository gates

Run on the exact commit intended for both machines:

```powershell
dotnet build src/SwarmUI.csproj --configuration Release
dotnet test SwarmUITests/SwarmUITests.csproj --configuration Release
dotnet format SwarmUI.sln --verify-no-changes
git diff --check
```

The spoke suites cover central policy refusal, missing-folder scan failure, read-only
settings metadata, blocked admin mutations, exact controller authorization, transient
sessions, controller-only generation, normalized direct-Comfy routes, protocol type and
ordering attacks, count/truncation/scan/version/parameter/subtype failures, hub-name
coverage, serialized refreshes, `RequireSpokeMode`, direct-backend availability, and
parent/child linkage.

`src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-restart.mjs` exercises the
`/simple` restart request and its down/return watcher. Run it when the restart route or
either client changes; it remains an opt-in Playwright harness, not an NUnit or default CI
dependency.

The CI boot jobs explicitly fetch upstream tags before launching. This fork does not
publish the upstream release tags, while startup version checks require them; fetching the
read-only tag refs prevents a false `Tag list empty` CI failure without changing remotes or
granting upstream write access.

### Isolated process gates

Use throwaway data roots and free fixed ports. Verify both a normal boot and an authenticated
`--spoke true` boot. For the spoke boot, provide a throwaway settings file with a nonempty
`Network.RequiredAuthorization`; blank authorization must fail startup. Also verify:

- an occupied configured web port fails instead of drifting;
- configured ngrok or Cloudflare tunneling fails startup;
- settings list reports `Spoke.Enabled=true` and read-only fields;
- settings, update, extension, model, dependency, and direct-Comfy mutations are refused;
- `RestartServer` returns on the same fixed port and still advertises spoke mode.

### Live hub/spoke acceptance gates

These are external and remain unverified until run on the deployment:

1. Prove the spoke SMB credential cannot create, alter, rename, or delete in the model
   share.
2. Deploy the exact same commit to hub and spoke. Configure the hub backend with
   `RequireSpokeMode=true` and the exact authorization header.
3. Compare exact sorted generation parameter IDs and subtype names. Compare exact sorted
   hub-local model-name sets against the spoke inventory; counts alone are insufficient.
4. Generate through the hub, pinned to the spoke, with a model absent from the spoke's
   metadata cache. Confirm success and confirm the targeted model and sidecar hashes are
   unchanged.
5. Confirm the final image is saved by the hub and not by the spoke.
6. Exercise every exposed model/runtime mutation control and direct-Comfy prompt alias.
   Confirm a typed refusal and no filesystem change.
7. Call `RestartServer` with a hub-controller session. Confirm the same port, authenticated reconnection,
   `spoke_mode=true`, `spoke_controller=true`, and a complete republished inventory.
8. Remove access to one test model directory, refresh, and confirm the hub marks the spoke
   inventory unavailable rather than routing against a partial set. Restore access and
   confirm recovery requires a complete refresh.

## Scope limits

- This code does not create SMB credentials, filesystem ACLs, firewall rules, drive maps,
  or Tailscale policy. Those are operator-owned deployment gates.
- Hub and spoke must load matching extensions so their generation parameter registries and
  Comfy node capabilities match. Parameter parity detects the former; a live generation
  remains the final proof of the latter.
- Model names are relative, ordinal identities. Both machines must map the shared tree so
  every hub-local name resolves identically on the spoke.
- The compact protocol carries no rich metadata or previews. The hub supplies those from
  its local model rows.
- Private deployment notes remain ignored and are not a source of repository authority.
