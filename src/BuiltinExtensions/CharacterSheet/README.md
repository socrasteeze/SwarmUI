# Character Sheet

Builds a multi-view character reference sheet — front, side, back, close-ups, plus any extra pose or prop panels you ask for — from a handful of reference images, then composites the panels into one sheet image.

Lives in the **Tools** panel on the Generate tab. Selecting it takes over the main Generate button, so it inherits the whole parameter panel (model, resolution, sampler, steps, LoRAs) rather than duplicating any of it.

## What this is and isn't

It was prompted by the two-stage MiniMax H3 character-sheet ComfyUI workflows going around, which ship a custom node pack to do the job. SwarmUI does not need that pack: H3's reference model, its nine-image prompt-image channel, and its still-image frame handling are all already native. What was actually missing was prompt templating, fanning several generations out of one request, and compositing — which is all this extension is.

So there is no third-party node dependency here, and nothing to install.

## Models

The tool adapts to whichever model is loaded. It asks the server what that model supports and greys out reference slots it cannot use, with the reason.

| Family | Reference images | Notes |
| --- | --- | --- |
| MiniMax H3 (reference) | 9 | Best cross-view coherence. Prompt addresses images as `<Picture N>`. Being a video model, it is forced to a still-frame count automatically. |
| Flux Kontext / Flux.2 / OmniGen | 4 (soft) | No hard engine limit; more than four references tends to muddy the result. |
| Qwen Image Edit Plus | 3 (hard) | Its text encoder has exactly three image slots. |
| Qwen Image Edit | 1 | Single reference. |
| Anything else | 1 | Reference images may have little or no effect; the panel says so. |

## Modes

- **One-shot** — every view in a single generation. Keeps the views consistent with each other, which is the whole point of the technique. Default on H3.
- **Per-panel** — one generation per view, composited afterwards. Works on any edit model and lets you regenerate a single bad panel. Default elsewhere.

Extra panels are always their own generation, so a one-shot run with two extras is three generations.

## Reference slots

Face, Outfit, Pose, Prop, Environment — handed to the model in that order, so the identity reference is always `<Picture 1>`.

Two model behaviours worth knowing, both inherited from the technique rather than from this code:

- **A visible face in the outfit reference beats the face in the identity reference.** Crop the outfit image below the neck, or mask the face out.
- **Props duplicate across panels.** Ask for one sword and you may get three.

## Layouts

`16:9 sheet` (auto grid, padded to widescreen), `single row`, `2x2 grid`, `tall left + two right`, `wide top + two below`. The last two want exactly three panels; with any other count they fall back to an auto grid rather than erroring.

Panels are fitted into their cells preserving aspect ratio, never stretched — a stretched turnaround defeats the purpose of a sheet.

## Fork notes

Zero core-file edits. The tool registers through `registerNewTool`, the API through `API.RegisterAPICall`, and compositing uses ImageSharp, which Swarm already depends on.

While iterating on `Assets/charsheet.js` or `Assets/charsheet.css`, remember that a Release build caches extension assets in memory permanently — restart the server to see changes.
