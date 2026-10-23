# Anima ControlNet in Simple Layout

**Status:** implemented on `feat/simple-anima-controlnet`, 2026-10-23. Source and synthetic checks pass. Live image quality and physical-device acceptance remain open. This replaces the earlier proposal.

## Use

1. Open `/simple` and select an Anima generation preset or checkpoint.
2. Open **ControlNet**, which occupies the Start / End Frame area for Anima.
3. Select **Pose**, **Lines**, **Sketch**, or **Depth**, or select a saved control preset.
4. Attach a **Control Image** from a file, clipboard, or the image browser. The Images viewer also has a **Control Image** action.
5. Select **Light**, **Normal**, or **Strong**. **Custom** indicates saved values outside those combinations.
6. Generate when the panel reports no missing requirement.

A type labelled **(Prepared)** needs an existing skeleton, line drawing, sketch, or depth map. It selects **Prepared Image** automatically. Clear that option only when the backend has the required annotator and cached weights.

**From Preset** reads first-slot ControlNet settings from the generation preset. **Off** suppresses them. Control Image remains a separate attachment. H3 restores its Start / End Frame controls and their original attachments. Other architectures keep their existing frame presentation.

## Independent presets

The generation preset remains active while a control preset applies only these settings:

- `controlnetmodel`
- `controlnetpreprocessor`
- `controlnetstrength`
- `controlnetstart`
- `controlnetend`

Use **Save Preset** in the panel or **More > Presets > New Control Preset**. A control preset title starts with `ControlNet/`, for example `ControlNet/Anima/Pose`. The namespace identifies the preset in the existing server store. No new database or preset schema is required.

A control preset cannot replace the prompt, checkpoint, LoRAs, sampling settings, or output root. The Simple generation and grid preset lists exclude this namespace. Existing generation presets can retain their ControlNet fields. Classic UI continues to see ordinary Swarm presets and does not enforce Simple's control-only overlay rules.

Uploaded image bytes remain in memory. Server-relative Control Image paths can survive reload. Neither captured preset settings nor control-only presets include attached images. Reuse Params clears the previous control attachment and restores parameter values for review.

## Preset editor

The editor groups existing fields into Model, Prompts, LoRAs, Sampling, Resolution, Upscale, ControlNet, and Advanced. Unknown fields remain editable and survive save. Anima controls have compatible model choices, explicit preprocessing choices, strength, and Start/End fields. Control-only presets also have an Architecture choice. Video fields stay hidden for a control-only preset and for Anima presets without stored video values.

**Capture Settings** opens a preview of old and proposed values. Choose **Manual Settings** for explicit Create settings or **With Preset** to include the current generation preset. Select the fields to apply. Capture updates only the unsaved editor. Unchecked fields remain unchanged. Image inputs, batch size, backend pin, and session identifiers are excluded. Aspect ratios remain symbolic instead of becoming generated pixel dimensions.

Saved control presets keep their independent selection through rename. Deleting a selected control preset switches its control selection to Off. Generation preset selection remains separate.

## Compatibility and dependencies

- The effective checkpoint after generation-preset application decides compatibility. The architecture browsing filter cannot override it.
- `anima`, `anima-2.9b`, and `anima-3.8b` remain separate. Unknown or incompatible model classes are excluded.
- The first version uses one dedicated Pose, Lines, Sketch, or Depth patch. It excludes inpainting, any-test, and other control families. Extra inherited control slots require removal or Classic UI.
- Discovery checks each running Comfy backend independently. A backend must register the checkpoint, patch, `ModelPatchLoader`, and the core `AnimaLLLiteApply` input contract.
- A control job pins to the backend that passed discovery. The session needs ControlNet and exact-backend parameter permissions.
- Standard Lineart and the basic Scribble processors need no checkpoint. Automatic DWPose and Depth Anything V2 require the exact bundled cache files that the generated graph uses. DWPose uses Swarm's explicit TorchScript detector override.
- Remote annotator caches cannot be inspected. Such backends can use registered checkpoint-free preprocessors or prepared control maps. Swarm API spokes without a directly inspectable Comfy contract are unavailable to this panel.
- Discovery never starts generation, loads a model, installs a node, or downloads weights. It filters model names through the session's model restrictions.
- Grid runs can reuse a shared guide. A grid preset that changes its architecture, backend availability, or control settings is rejected before submission.

Strength combinations are starting values, not visual-quality guarantees. Dedicated Preview3-era patches may control newer Anima checkpoints less strongly. No generation was used to qualify this implementation.

## Batch editor options

These options are recorded for a follow-up. The Image Batch Editor has not been redesigned.

| Option | Intended behavior | Implementation impact |
|---|---|---|
| Per-image control | Each source image becomes a guide; one control preset applies across the batch | Recommended first follow-up. Existing batch routing already supplies ControlNet images. Add a clear control-only mode and compatible preset selection. |
| Shared control | One guide applies to every source image used for image-to-image processing | Add a separate shared guide attachment and preserve its role independently of source images. |
| Compare controls | Compare control presets or strengths against one guide | Extend Simple's grid builder with dedicated control axes and per-cell validation. Current grids only reuse a shared fixed guide. |

The current Image Batch Editor enables both Init Image and ControlNet input by default. A future control-only mode must make that role selection explicit. Input/output folder handling and existing batch execution remain unchanged.

## Implementation and verification

The implementation stays under `MobileEnhancements`: `SimpleControlNetAPI.cs`, `Assets/m/m_controlnet.js`, and focused integration in state, Create, presets, Images, grid, asset registration, and CSS. The C# workflow generator is unchanged. It already loads Anima patches and handles lineart inversion.

CPU-only verification:

```powershell
node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-controlnet.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-presets.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-create-panel.mjs
node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-grid.mjs
dotnet test SwarmUITests/SwarmUITests.csproj --configuration Release
dotnet build SwarmUI.sln --configuration Release
dotnet format SwarmUI.sln --verify-no-changes
dotnet format style SwarmUI.sln --verify-no-changes
```

The browser checks use synthetic models, presets, and images. No generation endpoint receives a job. They cover independent preset application, variant rejection, missing annotators, image roles, file upload, storage, capture, save/rename, grid guards, and layout at 360/768/1440 pixels.

## Activation and rollback

A running Release server caches extension assets and needs a rebuilt assembly for the new API. Rebuild and restart SwarmUI, then bypass the browser cache. Source validation does not activate the feature in an already running server.

Rollback reverts the feature files and integration hunks, then rebuilds and restarts. No model files or existing saved presets are migrated. Previously saved control presets remain ordinary Swarm presets in the server store.
