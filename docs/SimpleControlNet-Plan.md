# /simple Guide — ControlNet for the mobile page

**Status:** spec only. Nothing implemented. Written 2026-09-12 against `ee7869a4`.

## Principle

`/simple` exposes intent, not ControlNet mechanics. The user says *"match the pose in this photo"*. They never
pick a model file, a preprocessor, a slot, or start/end steps. Everything the page can decide, it decides.
Anything that needs those knobs is a full-genpage job.

## What the user sees

One **Guide** row under the prompt-image strip. Hidden entirely when the current checkpoint has no ControlNet.

```
Guide   [ Off ] [ Pose ] [ Depth ] [ Lines ] [ Sketch ]
        [ photo thumbnail  ✕ ]   Strength: [ Light ] [ Normal ] [ Strong ]
```

- Tap a type → image picker opens (same sheet as prompt images: file, camera, paste, clipboard).
- Tap the thumbnail → replace. Tap ✕ → back to Off.
- History image actions gain **Use as guide**, wherever `/simple` already offers "use as prompt image".
- Only types that have a compatible model for the *effective* checkpoint render. Types never shown as disabled
  clutter — they are absent.

That is the whole surface. Three taps: type, photo, generate.

## What exists today (verified)

| Fact | Where |
|---|---|
| ControlNet params: `controlnetimageinput`, `controlnetmodel`, `controlnetstrength` (default 1), `controlnetstart` (0), `controlnetend` (1). Slots Two/Three are separate params | `T2IParamTypes.cs:602-624` |
| Omitting the preprocessor param makes core pick one **from the ControlNet filename**: `canny`, `depth`/`midas`, `sketch`, `scribble`, `pose` | `WorkflowGeneratorSteps.cs:1073-1085` |
| `lineart` / `mistoline` are **not** in that keyword list → no preprocessor runs | same |
| ControlNet preprocessors are installed on the hub | `GetCurrentStatus` feature `controlnetpreprocessors` |
| `/simple` already has the image-attach path (`addImageFile`, clipboard, history paths) and a compat-class helper | `m_create.js:1238`, `m_state.js:609` |
| Params not in `coveredParams` render as Advanced chips | `m_create.js:27`, `:1751` |

### ControlNets on the hub, by checkpoint family

IllustriousXL and NoobAI are SDXL derivatives (compat class `stable-diffusion-xl-v1`), so the whole SDXL
ControlNet set applies to them. There is no separate Illustrious ControlNet family to look for.

| Family | Pose | Depth | Lines | Sketch |
|---|---|---|---|---|
| Anima (`anima`) | `anima-lllite-pose-1` | `anima-lllite-depth-1` | `anima-lllite-lineart-1` | `anima-lllite-scribble-1` |
| SDXL / Illustrious (`stable-diffusion-xl-v1`) | `controlnetxlCNXL_2vxpswa7OpenposeV21`, `control-lora-openposeXL2-rank256`, **†** `controlnetxlCNXL_bdsqlszOpenpose`, **†** `controllllite_v01032064e_sdxl_pose_anime` (+`_v2_500-1000`) | `CN-anytest_v4-marged` + a depth preprocessor | `mistoline_v10`, `mistoLine_rank256` | `control-lora-sketch-rank128-metadata` |
| SD 1.5 | `control_v11p_sd15_openpose` | — | — | — |
| Flux2 Klein, Krea 2, Qwen, H3 | none | none | none | none |

`CN-anytest_v4-marged` is a universal SDXL ControlNet: it takes whatever the preprocessor produces, so the
preprocessor decides whether it acts as depth, pose, or lines. That is what closes the SDXL depth gap without a
depth-specific model, and it is the fork owner's existing Illustrious workflow.

Also present and deliberately unused by this feature: `control-lora-canny-rank128`,
`xinsircontrolnet-tile-sdxl-1`, `control-lora-recolor-rank128`, `control_v11p_sd15_{canny,seg}`, the Anima
`inpainting`/`any-test` patches, and `detection_Resnet50_Final` (not a ControlNet).

48 preprocessors are installed, including `DepthAnythingV2Preprocessor`, `OpenposePreprocessor`,
`AnimeLineArtPreprocessor`, and `LineArtPreprocessor` (`ListT2IParams` → `controlnetpreprocessor`).

**† Prerequisite, do this before building.** Those four report `architecture: None` because their metadata was
never set, so nothing can prove they are SDXL and rule 2 below discards them. That would throw away
`controllllite_v01032064e_sdxl_pose_anime`, the only *anime-tuned* SDXL pose model in the library and the best
pose guide for an Illustrious checkpoint. Set the architecture on each in the Models tab (same job as SWR.59),
then re-check with `ListModels` before the builder starts. The `.pth` duplicates of the SD1.5 models can stay
untagged; their `.safetensors` twins are already correct.

So the Guide row appears for **Anima and the SDXL/Illustrious library**, and is hidden on everything else.
All four types resolve for both families.

Verified 2026-09-12: `E:\models\controlnet` plus `E:\models\model_patches` is the entire inventory. The F: root
has no ControlNet folder, StabilityMatrix's and ComfyUI's folders are symlinks to the same place, nothing is
misfiled under `loras/`, and the writer laptop has none of its own.

## Resolution rules

1. **Family** = compat class of the effective checkpoint (`mState.compatClassOf('Stable-Diffusion', buildGenInput().model)`).
2. **Candidates** = ControlNet list filtered to that compat class. A model with no detected architecture is
   skipped, because nothing can prove it compatible and a mismatched ControlNet fails at generation time. This
   is why the four untagged SDXL models above must have their architecture set first — the rule is correct, the
   metadata is what is missing.
3. **Type → (model, preprocessor) pair.** A guide type is not one model — it is a model that accepts the input
   plus the preprocessor that produces it. Two shapes:
   - **Dedicated model** (Anima): filename keyword picks the model, and the preprocessor is left unset so core
     resolves it. Pose: `pose`. Depth: `depth`|`midas`. Lines: `lineart`. Sketch: `scribble`.
   - **Universal model + explicit preprocessor** (SDXL/Illustrious): `CN-anytest_v4-marged` accepts any
     preprocessed input, so it serves every type, with the preprocessor carrying the meaning. This is the
     fork owner's own working setup — anytest plus DepthAnythingV2 for depth on Illustrious.

   | Type | SDXL/Illustrious model | Preprocessor sent |
   |---|---|---|
   | Pose | a `pose` model if one is tagged, else `CN-anytest_v4-marged` | unset (dedicated) / `OpenposePreprocessor` (anytest) |
   | Depth | `CN-anytest_v4-marged` | `DepthAnythingV2Preprocessor` |
   | Lines | `mistoline_v10` | `AnimeLineArtPreprocessor` |
   | Sketch | `control-lora-sketch-rank128-metadata` | unset |

   Prefer a dedicated model when the family has one; fall back to a universal model plus an explicit
   preprocessor. Never offer a type that has neither.

   Excluded as *models* for every type: `inpaint`, `tile`, `recolor`, `seg`, `canny`. `any-test`/`anytest` is not
   excluded — it is the SDXL fallback model.
4. **Several matches** → take the one the user last picked for this family+type, else the first by name.
   No picker in the row. A long-press on the type chip opens a one-line model list only when there are ≥2.
5. **Preprocessor** follows from the pair chosen in rule 3:
   - Dedicated model whose filename carries a keyword core knows (`pose`, `depth`, `midas`, `sketch`,
     `scribble`) → **do not send**. Core resolves it.
   - Everything else → send it explicitly. That covers every universal-model type, and `mistoline`/`lineart`,
     which core's keyword list does not recognise — omitting it there feeds the raw photo to a lineart model.
   - One toggle inside the image sheet: **"Already a pose/depth/line image"** → send preprocessor `None`, for an
     existing stick figure, depth map, or line drawing.
6. **Checkpoint changes to a family with no model for the chosen type** → the Guide state is kept but not sent,
   and the row shows one line: *"No Pose guide for Flux 2 Klein — guide not applied."* Never send an
   incompatible ControlNet and let the backend error.

## Strength levels

One control, three values. Each sets strength **and** end together, because on a phone "how strongly" is the
only question; start stays 0.

| Level | `controlnetstrength` | `controlnetend` | Intent |
|---|---|---|---|
| Light | 0.55 | 0.6 | Rough pose, free detail |
| Normal (default) | 0.8 | 0.8 | Pose held, hands and folds resolve naturally |
| Strong | 1.0 | 1.0 | Match closely |

Starting values. Tune them against real Anima generations before shipping; they are the only numbers in this
spec that aren't read from the tree.

## What gets sent

`buildGenInput()` adds, only when a type is chosen, an image is attached, and a model resolved:

```
controlnetimageinput   <data URI | output path>     # same normalisation as promptimages
controlnetmodel        <resolved model name>
controlnetstrength     <level>
controlnetend          <level>                      # omitted when 1 (IgnoreIf)
controlnetpreprocessor <lineart key | None>         # Lines, or "already a pose/line image" only
```

Add all five ids to `coveredParams` so they never also render as Advanced chips.

## State

`mState.guide = { type, image: {kind, value}, level, alreadyProcessed, modelPick: {"<family>|<type>": name} }`

- `type`, `level`, `alreadyProcessed`, `modelPick` persist like other `/simple` settings.
- `image` follows whatever `promptImages` does today. Never write a data URI to localStorage.

## Interactions

| Case | Behavior |
|---|---|
| Presets | A preset that sets `controlnet*` params keeps rendering them as Advanced chips as today; the Guide row does not read or write presets. The Guide row wins if both set a value. |
| Reuse Parameters | Restores type (from the model name keyword), level (nearest match), and model pick. Image slot stays empty with a note — metadata carries no image. |
| Prompt Enhance | Independent. A pose guide plus an enhanced prompt is the intended pairing. |
| Spoke routing | Not verified. The spoke mounts the same model roots, but check that a ControlNet job routed to `G18-API` resolves the model before relying on it. |
| Generate Forever / grids | Guide applies to every image, like any other param. |

## Out of scope

- ControlNet slots Two and Three
- Start/end sliders, a preprocessor picker, union types
- Preview-the-preprocessor (`controlnetpreviewonly`) — a Phase 2 candidate if Lines misfires
- Inpainting and any-test ControlNets
- Masks
- Genpage changes

## Build

Fork-owned files only, zero core edits.

| File | Change |
|---|---|
| `MobileEnhancements/Assets/m/m_state.js` | `guide` state, resolution helpers, `buildGenInput` additions, `coveredParams` ids |
| `MobileEnhancements/Assets/m/m_create.js` | Guide row, image sheet reuse, strength chips, mismatch line, history **Use as guide** |
| `MobileEnhancements/Assets/m/m.css` | Row layout, ≥44px targets |
| `MobileEnhancements/verify/verify-simple-guide.mjs` | New harness |

One builder agent. Roughly one session.

## Verification

Harness (extraction + stubs, like `verify-simple-coach.mjs`):
- Row hidden on a Flux/Krea/Qwen checkpoint; shown on Anima and on an `ill/` checkpoint
- Type chips limited to families' available models; unknown-arch models never chosen
- Pose/Depth/Sketch send no preprocessor; Lines sends the `lineart` key; "already processed" sends `None`
- Level → exact strength/end pairs; end omitted at 1
- Checkpoint switch to a family with no match → nothing `controlnet*` sent, notice shown
- No `controlnet*` key reaches Advanced chips

Live, on the hub:
- Anima + Pose + a full-body photo + Normal → pose held, character from the prompt
- `ill/` checkpoint + Lines + a sketch → line structure held
- Switch to Flux 2 Klein with a guide set → generates, no ControlNet error, notice visible

## Coupling watchlist

- `T2IParamTypes.cs` ControlNet param names (ids derive from them)
- `WorkflowGeneratorSteps.cs:1073-1085` filename→preprocessor keywords — if upstream adds `lineart`, drop the explicit Lines preprocessor
- `ComfyUIBackendExtension.ControlNetPreprocessors` key names
