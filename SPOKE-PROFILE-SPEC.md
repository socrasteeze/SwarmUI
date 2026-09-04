# Spec: SwarmUI Spoke Profile

**Status:** proposal, not implemented. Everything below was derived from a working
hub/spoke deployment (see `Hub-Spoke-Setup.md`), where each item was hand-applied and
verified on 2026-09-03.

## Problem

SwarmUI assumes every instance is a workstation that owns its models. In a hub/spoke
setup the spoke owns nothing — it reads the hub's model tree over SMB and returns pixels.
Running workstation defaults on a spoke causes three classes of failure. All three were
observed live, not theorised.

**1. The spoke writes to the hub's model files.**
`GetOrGenerateTensorHashSha256` defaults to `resave: true`
(`src/Text2Image/T2IModel.cs:76`) and runs on every checkpoint, LoRA and embedding at
generation time. The spoke keeps its own metadata database, so it has no cached hashes for
models it has not personally scanned. First use of such a model computes a hash and calls
`ResaveModel`, which writes into the safetensors header — and when the header outgrows its
slack, performs a **full multi-GB file rewrite** (`.tmp` copy, two moves, a delete) across
the network onto the hub's disk.

**2. The spoke silently advertises a truncated model list.**
`Performance.ModelListSanityCap` defaults to 5000. `src/WebAPI/ModelsAPI.cs:224` breaks the
listing at that count. The hub filters backends by advertised model names, so any job using
a model past the cut is silently refused. Observed: 5,001 of 19,354 LoRAs advertised.

**3. The hub asks the spoke for data the hub already owns.**
`SwarmSwarmBackend` requested model lists with `dataImages: true`, base64-embedding a
preview per model. Across ~19k LoRAs the payload exceeded .NET's string capacity, so the
spoke threw `ArgumentOutOfRangeException: The length cannot be greater than the capacity`
and returned an **empty body every time**. Measured: `dataImages=false` → 64.9 MB in 3.4s;
`dataImages=true` → 0 bytes.

Because the list never arrived, `Models["LoRA"]` had no key, so the LoRA check at
`src/Text2Image/T2IEngine.cs:140` was skipped entirely. Jobs succeeded by accident rather
than by passing validation.

## Design

Three parts, in descending order of value.

### Part 1 — the write guard (the reason to build this)

A hard block on writes whose resolved path falls under `ModelRoot`, active when spoke mode
is on. Settings can be changed back by accident; a guard cannot.

Implement as a single chokepoint helper, then route model-tree writes through it:

```csharp
/// <summary>Throws if spoke mode is on and the path resolves under a ModelRoot entry.</summary>
public static void GuardModelTreeWrite(string path, string operation)
{
    if (!Program.ServerSettings.Spoke.ReadOnlyModelTree) { return; }
    string full = Path.GetFullPath(path).Replace('\\', '/');
    foreach (string root in Program.ServerSettings.Paths.ModelRoot.Split(';'))
    {
        string fullRoot = Path.GetFullPath(root.Trim()).Replace('\\', '/').TrimEnd('/');
        if (full.StartsWith($"{fullRoot}/", StringComparison.OrdinalIgnoreCase))
        {
            throw new SwarmReadableErrorException(
                $"Spoke mode: refused '{operation}' to the shared model tree at '{path}'. "
                + "Perform model management on the hub.");
        }
    }
}
```

Call sites to guard, all confirmed reachable and all writing under `ModelRoot`:

| Location | Operation | Reachable by |
|---|---|---|
| `T2IModel.ResaveModel` (`src/Text2Image/T2IModel.cs:125`) | header rewrite / full file copy | generation, metadata edit, preview set |
| `T2IModelHandler.MassRemoveMetadata` (`src/Text2Image/T2IModelHandler.cs:174`) | deletes `model_metadata.ldb` in **every** model subfolder | admin action; not gated by `ModelMetadataPerFolder` |
| `ModelsAPI.DeleteModel` (`src/WebAPI/ModelsAPI.cs:811`) | permanent delete | UI action |
| Model download destination | writes new model files | UI download, auto-download of VAE/CLIP/upscalers |
| `T2IModelHandler.Refresh` (`src/Text2Image/T2IModelHandler.cs:265`) | `Directory.CreateDirectory` per folder | every refresh — guard should **allow** this, or skip it when the folder exists |

Note `RecycleDeletedModels` is dead config. It is declared at `src/Core/Settings.cs:352` and
read nowhere; `DeleteModel` checks `RecycleDeletedImages` instead. A spoke-mode delete must
be blocked outright rather than trusted to recycle.

### Part 2 — the settings preset

Add a `Spoke` settings group. When `Spoke.Enabled` is true, apply these at load and show
them as locked in the UI.

| Setting | Spoke value | Default | Why |
|---|---|---|---|
| `Spoke.ReadOnlyModelTree` | true | — | Arms the Part 1 guard |
| `Metadata.ImageMetadataIncludeModelHash` | false | true | Closes every generate-time resave path |
| `Metadata.EditMetadataWriteJSON` | false | false | Keeps the existing model-header behavior; the write guard must block both header and sidecar writes |
| `Metadata.ModelMetadataPerFolder` | false | false | Keeps the metadata DB local, not scattered in the tree |
| `Performance.ModelListSanityCap` | 100000 | 5000 | Stops silent truncation of the advertised list |
| `Network.Host` | 0.0.0.0 | localhost | The hub must reach it |

`ImageMetadataIncludeModelHash: false` costs the model *hash* in image metadata. The model
*name* is still recorded. Correct trade for a compute node.

### Part 3 — `launch-spoke.bat`

A thin wrapper over `launch-windows.bat`. It must preserve the existing exit-code-42
restart loop, or an in-app restart drops out of spoke mode.

```bat
@echo off
setlocal
rem Spoke mode: this instance is a GPU worker for a hub. It owns no models.
rem Launch from an interactive desktop session -- mapped drive letters are per-session,
rem and a service or SSH session cannot see the hub's share.

call "%~dp0launch-fork.bat" --spoke true %*
exit /b %ERRORLEVEL%
```

Read `--spoke` during startup into an immutable runtime flag, so the mode travels with the
launcher rather than living only in a settings file someone can edit. Show `Spoke.Enabled`
as effective read-only status; do not persist the launcher override into normal settings.

**Optional surface reduction:** a `--no-ui` flag. This is not a security boundary: the
destructive API routes remain reachable. Spoke mode still requires authentication and
server-side refusal of model-tree mutations.

## Hub-side companion patch

Not part of the spoke profile, but required for the pair to work. Already applied locally in
this fork at `src/Backends/SwarmSwarmBackend.cs:208`:

```diff
-["dataImages"] = true
+["dataImages"] = false
```

The hub owns matching local models, so asking this spoke to send back base64 previews is
pure waste and overflows on large trees. This is a fork-local optimization for the shared-
model topology. Generic remote-only Swarm backends need preview proxying before using the
same request mode. Preserve and revalidate this delta after every upstream merge.

## Testing checklist

1. Start a spoke against a hub-mounted model tree. Confirm the model counts match the hub's.
2. Generate through the hub, pinned to the spoke, using a model the spoke has never seen.
   Confirm no file under `ModelRoot` changes. Compare directory timestamps before and after —
   a recursive file walk on a large tree will time out.
3. Attempt a model delete from the spoke's UI. Confirm it is refused, not recycled.
4. Confirm the advertised LoRA count equals the hub's, not 5001.
5. Restart the spoke from inside the app. Confirm it comes back still in spoke mode.
6. Confirm generated images land in the **hub's** output folder. The hub sets `DoNotSave`
   on forwarded requests (`src/Backends/SwarmSwarmBackend.cs:522`), so this should already
   hold; the test guards against regression.

## Non-goals

- Fork-local only. The `dataImages` change is scoped to the shared-model deployment;
  generic remote-only backends need a separate inventory and preview transport.
- Does not replace matching extension sets between hub and spoke. The spoke builds the
  ComfyUI workflow from the params it receives, so a param registered only on the hub has
  nothing to bind to. That stays a manual parity requirement.
- Does not address model-name matching. Both machines must resolve identical relative names,
  which is a path-configuration concern covered in `Hub-Spoke-Setup.md`.
