# Prompt Enhance

Rewrites the user's typed idea into a prompt shaped for the currently loaded image model, using a local
writer LLM reached from the hub over plain HTTP.

Adds an **Enhance** button beside the prompt textbox on the genpage. Clicking it opens a panel that streams
a rewritten prompt from the writer model, shows any advisory notes underneath, and offers Apply, Keep
original, or Close. Nothing is sent anywhere on generate; the user always reviews the rewrite first.

## How it works

SwarmUI has no local-LLM runtime of its own worth building on (`src/LLMs` is an explicit placeholder, and
the spoke protocol would mirror an LLM backend as a phantom image backend - see
`docs/PromptEnhance-Design.md`). This extension instead makes a direct HTTP call from the hub to a writer
host running Ollama or any OpenAI-compatible server, with selection, shielding, caching, and transport all
owned here.

1. **Selection.** `PromptEnhanceProfiles.Resolve` picks a per-architecture writer profile for the currently
   loaded model, in this order:

   | Order | Source | Notes |
   |---|---|---|
   | 1 | Manual override | Wins over everything. An override naming an unknown profile ID is a hard miss - disabled, with the bad ID in the reason, not a silent fall-through. |
   | 2 | Filename override | A regex over the model's lowercased name, anchored on a name segment (`(^|[\/_ -])(illustrious\|noob)`). Handles checkpoints that share a class ID but need different writer targets. |
   | 3 | Model class ID map | `qwen-image-edit` and `qwen-image-edit-plus` both map to `qwen-image-edit-2511`. Plain `qwen-image` T2I is deliberately left unmapped - it has no profile written for it. |
   | 4 | Compat class ID map | Only for compat classes that are exactly one architecture wide: `flux-2-klein-4b`, `flux-2-klein-9b`, `anima`. Never `stable-diffusion-xl-v1` (shared by IllustriousXL and vanilla SDXL - the filename override handles IllustriousXL, vanilla SDXL has no profile) or `qwen-image` (already covered by the class map). |
   | 5 | None | The Enhance button is disabled, with the reason shown in its tooltip. |

2. **Shielding.** Before the prompt is sent to the writer, `PromptEnhanceClient.Shield` extracts every
   balanced angle-tag block (`<lora:...>`, `<embed:...>`, `<random:<lora:a>|<lora:b>>`, etc - tracked by
   nesting depth, not a flat regex) and every `__wildcard__`-style token, in order of appearance. The writer
   never sees them, so it cannot rephrase, translate, or drop a LoRA tag, an embedding tag, or a wildcard
   name. `Unshield` re-appends the extracted tokens onto the writer's reply afterward. There is no separate
   bare `embedding:` shield - SwarmUI's own embedding syntax is the angle-tag form `<embed:...>`, already
   covered by the tag shield. Removing a token can orphan a separator; `CollapseSeparators` repairs doubled
   commas, stray comma spacing, doubled plain spaces, and a leading/trailing comma, without touching newlines
   or rewriting anything else.
3. **Transport.** `PromptEnhanceClient.ChatStream` posts to `/api/chat` (Ollama) or `/v1/chat/completions`
   (OpenAI-compatible), streamed, and reads it back with `StreamReader.ReadLineAsync` against a linked
   cancellation token that carries both the per-request timeout and the session's own interrupt/shutdown
   token. Sampling matches the profile pack's own grading harness: `temperature 0.7`, `seed 7`,
   `num_predict`/`max_tokens 2048`, `think false`. `keep_alive` is sent from the endpoint's config on every
   request. A reply is capped at 32,000 characters (a runaway stream aborts rather than buffering forever);
   a submitted prompt over 20,000 characters is rejected outright, before any shielding or caching work.
4. **Cache.** Every prompt is looked up before it is ever dispatched, keyed on
   `(shielded prompt, profile ID, profile-pack version, endpoint's configured model)`. The endpoint used for
   that key is the first healthy one, or - if none answer their health probe - simply the first *enabled*
   endpoint in config, since its model name is known either way. This is deliberate: cache lookup happens
   **before** health is checked, which is what lets a repeat prompt still return instantly while the writer
   host is asleep. A miss with nothing healthy passes through unchanged. An empty (or notes-only) reply is
   never cached - it isn't a success, so it's treated as a passthrough instead of poisoning future lookups.
5. **Provenance.** Applying a result writes one hidden T2I param, `Prompt Enhance Provenance`
   (id `promptenhanceprovenance`) as JSON: `original`, `profile`, `pack_version`, `writer_model`, `endpoint`,
   `cached`. It is registered `VisibleNormally: false, Toggleable: false, Nonreusable: true,
   IntentionalUnused: true` - hidden from the params list but still built and still written into image
   metadata, since `GenParameterMetadata` only skips a param for `HideFromMetadata`, not for
   `VisibleNormally` alone; `IntentionalUnused` is required because nothing server-side ever reads the param
   back with `Get()`, which would otherwise make `GenFullMetadataObject` strip it as an unused parameter. It
   is cleared automatically the moment the prompt box's value diverges from the just-applied text, and on
   "Keep original" - so it never survives onto an unrelated later generation.

### Failure posture

| Condition | Behavior |
|---|---|
| Endpoint unreachable, connection failure, or timed out | **Fail open.** Passthrough, with a visible "Not enhanced: `<reason>`" marker. Generation is never blocked on an un-enhanced prompt the user believes was enhanced. |
| No profile resolves for the loaded model | Enhance button disabled, reason in its tooltip. Nothing is sent. |
| No endpoint configured, or nothing healthy and no cache hit | Passthrough, reason shown. |
| Reply begins `CONFLICT:` | Hard stop. Red block, the line shown verbatim, no Apply. |
| Reply begins `NEEDS INPUT:` | Hard stop, same red block treatment, plus a logged profile miss (`Logs.Warning`) - a non-interactive profile should never emit this. |
| Reply is empty or whitespace-only after `NOTES:` lines are split off | Treated as passthrough, not cached. |
| Panel closed mid-stream | Silent. The in-flight socket is closed without raising an error. |

## Endpoints

Configured writer hosts live in `Data/PromptEnhance/endpoints.json` (gitignored - a writer-host address is
never committed). It is an **ordered list**; the first *enabled* entry that answers its health probe is
used. A default file is written on first run:

```json
{
  "_comment": "Ordered list; the first enabled endpoint that answers its health probe is used. kind is 'ollama' or 'openai'.",
  "endpoints": [
    {
      "id": "writer",
      "url": "http://127.0.0.1:11434",
      "kind": "ollama",
      "model": "huihui_ai/qwen3-vl-abliterated:8b-instruct",
      "keep_alive": "30m",
      "timeout_seconds": 120,
      "enabled": true
    }
  ]
}
```

To point this at a real writer host, edit `url` to the writer host's LAN or tailnet address (never a
private IP or hostname baked into this repo). `kind` is `ollama` (`POST /api/chat`) or `openai` (an
OpenAI-compatible server such as LM Studio, `POST /v1/chat/completions`); it is lowercased on load, and an
entry with any other kind is skipped with a logged error rather than crashing extension init. `id` defaults
to `endpoint<index>` when absent and is deduplicated (a repeated ID is renamed and a warning logged) so it
always has a stable value to key health results and API overrides on. The health probe is `GET /api/tags`
(ollama) or `GET /v1/models` (openai), status code only, 5 second timeout, and the result is cached 5 seconds
per endpoint so a resolve-then-dispatch pair of calls doesn't double the probe cost. `ListPromptEnhanceStatus`
never exposes endpoint URLs to the client - only `id`, `kind`, `model`, `enabled`, `healthy`.

## Caller contract

The system prompt sent to the writer is one of the versioned profile assets under `Assets/profiles/`,
verbatim - these are the **non-interactive** variants, meant for a caller with no human able to answer a
question. The contract they're written against (`profiles-noninteractive`, authored upstream - see below):

- A reply beginning `CONFLICT:` means the request is unsatisfiable by one image. Hard stop, nothing applied.
- A reply beginning `NEEDS INPUT:` should never happen against a non-interactive profile; if it does, it's
  a hard stop and a logged profile miss, not a silent retry.
- Any `NOTES:` line is advisory text about this one rewrite, not part of the prompt. It is split off,
  returned separately, shown under the preview, and **never** applied to the prompt or included in the
  cached prompt text.
- Everything else in the reply is the finished prompt, verbatim.

## Profile pack

Shipped profile-pack version: **`1.1.0+7ff564b9`** (`Assets/profiles/VERSION`, read at extension init and
folded into every cache key and provenance record, so a stale copy is detectable rather than silently
mismatched against a newer grading run).

The profiles themselves are not this extension's IP. They are authored, validated, and graded in the
ComfyUI fork's `fork_tools/prompt_guides/` tree (`profiles/` for the interactive originals, plus
`harness/dryrun.py`, `harness/grade.py`, `VALIDATION_CASES.md`, and `output.schema.json`), then hand-copied
into `Assets/profiles/*.system.md` here with the version bumped to match. To refresh a profile: edit or
regrade it in the ComfyUI tree, re-run the harness, copy the finished `.system.md` over the matching file
here, and update `VERSION`. There is no build-time or runtime dependency on that tree existing on this
machine - the copy plus the recorded version is the whole point.

### Writer models measured

Harness: ComfyUI fork `fork_tools/prompt_guides/harness/dryrun.py` + `grade.py`, run against
`profiles-noninteractive`, 68 validation cases.

| Writer model | Grade | Notes |
|---|---|---|
| `huihui_ai/qwen3-vl-abliterated:8b-instruct` | 58/68 mechanically clean | Measured on the writer host (RTX 5080 Laptop, 16 GB, Ollama), 2026-09-12. Cold first call 7.8s wall; resident call 0.23s wall at ~103 tok/s; full 68-run dry-run 63s. Shipped default. |
| `gemma-4-26B-A4B` Q4_K_M v3 | 66/68 | Graded 2026-09-10 on the hub. 18 GB on disk - spills on the writer host's 16 GB card, so it's kept as an opt-in `endpoints.json` entry rather than the default. |
| `gemma-4-abliterated:12b` | Not measured | Grading run was interrupted; no numbers recorded. |

Failing pairs for the shipped 8B default: `10/illustrious` INVENTED-SUBJECT; `11/anima` EXAMPLE-LEAK;
`5a/qwenedit` SPURIOUS-CONFLICT; `5a/anima` INVENTED-SUBJECT + EXAMPLE-LEAK; `5a/illustrious` and
`5b/illustrious` INVENTED-SUBJECT; `9 runtime/lora` NO-NOTES on klein9b, qwenedit, anima, and illustrious.
The `9 runtime/lora` case (LoRA/protected-token handling) is the 8B's systematic failure mode and this
fork's real workload - it's the reason the syntax shield above exists.

## Phase 2 (not built)

Deliberately out of scope for this build:

- Auto-enhance on generate (resolving and rewriting automatically at request intake, with no review step).
- A Prompt Enhance entry on the `/simple` mobile client.
- A manual profile-override control in the UI (the API already accepts `profile_override`; nothing today
  sends one).
- A wider SDXL-derivative filename map beyond `illustrious`/`noob`.
- A spoke-side route (rejected for the same reasons recorded in `docs/PromptEnhance-Design.md`: it would
  mint a phantom image backend and impose `VaryID` lockstep deploys for no benefit here).

## Fork notes

Zero core-file edits - everything in this directory is new, plus one hidden T2I param registered from this
extension's own `OnInit`.

While iterating on `Assets/promptenhance.js` or `Assets/promptenhance.css`, remember that a Release build
caches extension assets in memory permanently - restart the server to see changes.

Verify with:

```
node src/BuiltinExtensions/PromptEnhance/verify/verify-promptenhance.mjs
```
