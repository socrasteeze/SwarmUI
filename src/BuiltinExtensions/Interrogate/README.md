# Interrogate

Turns an image into text: booru-style tags, or a descriptive prompt.

Adds an **Interrogate** button to every image surface in SwarmUI — the button row under the current image, the right-click menu on a batch thumbnail, the full-view overlay, and the Image History browser. Clicking it opens a modal where you pick a method, run it, and send the result straight to the prompt or negative prompt box.

## How it works

SwarmUI has no image-to-text model runtime of its own, and its `src/LLMs` subsystem is an explicit placeholder with no vision input. Rather than add a second runtime, this extension drives the ComfyUI backend that is already running:

1. `SwarmLoadImageB64` takes the image as base64.
2. The selected tagger or captioner node produces a string.
3. `SwarmAddSaveMetadataWS` streams that string back over SwarmUI's existing websocket text channel.

The result is read from the `T2IParamInput` this extension owns, which is why it calls `ComfyUIAPIAbstractBackend.AwaitJobLive` directly instead of `RunArbitraryWorkflowOnFirstBackend` — that helper builds its own input object internally, leaving the caller no way to read the returned text.

## Methods

| Method | Output | Notes |
| --- | --- | --- |
| WD14 Tagger | Comma-separated booru tags | Small ONNX models, fast, no meaningful VRAM cost. Good for prompt reuse and dataset captioning. |
| Florence-2 Caption | Natural-language description | Heavier, downloads a multi-GB model on first use. Prefers a PromptGen fine-tune when one is installed, since those were tuned to emit prompt-shaped text rather than dataset-style captions. Never held resident in VRAM — this is a one-shot utility sharing a GPU with image generation. |

Tag output is also rendered as chips below the text box. Any tag TagDex recognises as a character or artist picks up the same coloring the prompt autocomplete uses, and clicking a chip drops that tag from the result.

If the required ComfyUI nodes are not installed, the method is shown as unavailable with a one-click install button. Installing restarts the ComfyUI backend; the modal notices and re-enables itself when it comes back.

The first run of any tagger model also downloads it, which can take several minutes. The modal says so rather than appearing to hang.

## Adding a method

`InterrogateBackends.Register` is public, so another extension can add a method without touching this one:

```csharp
InterrogateBackends.Register(new("myid", "My Captioner", "What it does.", "my_feature_flag", "my_install_id", "prose", BuildMyWorkflow));
```

`BuildMyWorkflow` takes the base64 image plus an options blob and returns a raw ComfyUI API-format workflow. End it with a `SwarmAddSaveMetadataWS` node whose `key` is `InterrogateBackends.ResultKey`.

## Fork notes

Zero core-file edits. The node-to-feature map, the installable-feature registry, and the `object_info` parser list are all public static collections that the ComfyUI extension exposes for this purpose.

While iterating on `Assets/interrogate.js` or `Assets/interrogate.css`, remember that a Release build caches extension assets in memory permanently — restart the server to see changes.
