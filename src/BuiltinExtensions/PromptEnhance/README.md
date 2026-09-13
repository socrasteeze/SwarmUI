# Prompt Enhance

Rewrites the user's typed idea into a prompt shaped for the currently loaded image model, using a local
writer LLM reached from the hub over plain HTTP.

Adds an **Enhance Prompt** entry to the Generate caret menu on the genpage (the `⮟` button beside Generate,
`#popover_generate_center`). Clicking it opens a panel that streams a rewritten prompt from the writer model,
shows any advisory notes underneath, and offers Apply, Keep original, or Close. It lives in that menu rather
than loose in the prompt row so it lines up with the rest of the layout instead of sitting proud of it.

A mode control in the same menu (**Off / Review / Auto**, see below) decides whether generate is touched
at all. In its default **Review** mode nothing is sent anywhere on generate; the user always reviews the
rewrite first. **Auto** mode enhances silently ahead of generating instead - see "Mode control and
auto-enhance" below.

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
   | 1 | Manual override | Wins over everything. Set from the panel's profile dropdown (see "Manual profile override" below), or an override naming an unknown profile ID is a hard miss - disabled, with the bad ID in the reason, not a silent fall-through. |
   | 2 | Configured folder/filename override | A user-editable list of regexes over the model's lowercased, subfolder-relative name, loaded from `Data/PromptEnhance/overrides.json` (see "Folder/filename override config" below). Ships with `^ill/` → `illustriousxl` and `^anima/` → `anima`. |
   | 3 | Built-in filename override | The original single fallback regex, anchored on a name segment (`(^|[\/_ -])(illustrious\|noob)`). Catches Illustrious/NoobAI checkpoints outside a configured folder. |
   | 4 | Model class ID map | `qwen-image-edit` and `qwen-image-edit-plus` both map to `qwen-image-edit-2511`. Plain `qwen-image` T2I is deliberately left unmapped - it has no profile written for it. |
   | 5 | Compat class ID map | Only for compat classes that are exactly one architecture wide: `flux-2-klein-4b`, `flux-2-klein-9b`, `anima`, `krea-2`. Never `stable-diffusion-xl-v1` (shared by IllustriousXL and vanilla SDXL - the override map/filename fallback handle IllustriousXL, vanilla SDXL has no profile) or `qwen-image` (already covered by the class map). |
   | 6 | None | The Enhance button is disabled, with the reason shown in its tooltip. The panel's manual override dropdown (row 1) is always reachable from here regardless - see "Manual profile override" below. |

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
   `cached`, `strength` (the effective strength actually used - see "Strength" below). It is registered
   `VisibleNormally: false, Toggleable: false, Nonreusable: true,
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

## Strength

The panel also carries a **Strength** dropdown (Faithful / Expand / Full scene), sent as `strength` on every
`EnhancePrompt` request (both the panel's own review request and the silent auto-enhance path) and persisted
per user the same way the profile override is (`pref('strength', 'full')`). It controls how much the writer is
asked to add on top of a faithful rewrite, by prepending a directive to the (already-shielded) user message -
the profile files themselves are never modified:

| API value | Effect |
|---|---|
| `faithful` | Sends the shielded prompt unchanged - exactly the pre-Strength behavior. |
| `expand` | Prepends `Mode: expand\n\n` - the profile pack's own "restrained visual additions" switch. |
| `full` | **Default.** Prepends an explicit instruction to build out setting, lighting, camera framing, mood, and material detail while keeping every detail and art style the user gave unchanged. |

Rules `PromptEnhanceClient.ApplyStrength` applies, in order:

1. **User shortcut wins.** If the user's own prompt already starts with one of the profile pack's shortcuts
   (`/rewrite`, `/expand`, `/positive`, `/full`, `/explain`, `/json`, each matched as a whole token) or
   `Mode:` (case-insensitive), the user is already talking to the writer directly - no directive is added,
   and the effective strength reports as `user`.
2. **Blank/unrecognized falls back to `full`**, the feature default. The value is lowercased on input.
3. **Edit-profile cap.** `full` is not allowed on an edit profile (currently `qwen-image-edit-2511` -
   see `PromptEnhanceProfiles.KnownEditProfileIDs`/`PromptEnhanceProfile.IsEdit`): it invents a new setting
   and contradicts the edit, so it is capped down to `expand` instead, and the terminal frame carries a
   `strength_note` explaining the cap (eg "Full scene is not available for edit profiles; used Expand.").
   `ListPromptEnhanceStatus`'s `resolved.strengths` reflects the cap too (`["faithful", "expand"]` for an
   edit profile, `["faithful", "expand", "full"]` otherwise, or when no profile has resolved yet). The
   frontend disables/hides options `resolved.strengths` omits, but never overwrites the stored preference -
   a later model swap that lifts the cap sees the full choice again.
4. **Order.** The directive is applied *after* `PromptEnhanceClient.Shield`, on the shielded prompt, so it can
   never interact with shielding - `Unshield` still re-appends the shield-extracted tokens exactly as before.
   The shortcut check in rule 1 looks at the user's raw, unshielded prompt.

The cache key (`PromptEnhanceCache.Key`) folds in the effective strength as its own dimension, so a `full`
rewrite and a `faithful` pass-through of the same idea never collide on one cache entry, and a repeat request
at the same effective strength still hits the cache. Both the `running` status frame and the terminal result
frame report `strength` (the effective value actually used); a capped request also carries `strength_note`.
Applying a result includes `strength` alongside the other six fields in the provenance JSON recorded into the
hidden `promptenhanceprovenance` param.

## Mode control and auto-enhance

A tri-state control sits directly under the Enhance Prompt entry in the Generate caret menu, labeled
**Enhance: Off / Review / Auto**. Unlike the entry above it, changing the mode does not dismiss the menu.
It persists
per user the same way `interrogate.js` persists its own preferences (a prefixed `localStorage` key, read on
load and written on change - see `PromptEnhanceHelperClass.pref`/`setPref`).

- **Off** - no enhancement at all. The Enhance Prompt entry is hidden (the mode control itself stays visible, so
  switching back is always possible) and every generate path is completely untouched.
- **Review** - the default, and exactly the behavior described above: the button opens the panel, the user
  reviews the rewrite, and Apply writes the prompt. Generate is never touched.
- **Auto** - generate enhances silently first. The button still works for manual review at any time.

**Auto mode's mechanism.** `alt_generate_button` is the one element every generate path clicks through -
the main `generate_button` (`onclick="getRequiredElementById('alt_generate_button').click()"`), the
Ctrl+Enter handler in `currentimagehandler.js`, and the Enter-in-prompt-box handlers in `layout.js` all call
`.click()` on it. `promptenhance.js` registers a single **capture-phase** click listener on that element.
Capture-phase listeners always run before an element's own bubble/target-phase listeners (its `onclick=`
attribute included), *regardless of which was registered first* - verified directly against a live browser
before relying on it, since this extension's script loads after `GenerateTab.cshtml`'s markup has already
set the button's `onclick` attribute. When mode is `auto` and a profile resolves (`buttonEnabled`) and the
current prompt is not already the applied-enhanced text, the interceptor calls `stopPropagation()` and
`preventDefault()`, then runs one `EnhancePrompt` request:

- On `result`: writes the prompt box and records provenance (the same `applyResult` step manual Apply uses),
  then re-dispatches a synthetic click on the generate button under a **re-entry guard** flag
  (`this.reentryGuard`). The interceptor's first line is `if (this.reentryGuard) { return; }`, so that one
  synthetic click passes straight through to the real generate handler instead of being intercepted again.
- On `conflict` or `needs_input`: shows the existing red block and does **not** generate - a conflict blocks
  generation entirely, per the failure posture above.
- On `passthrough`, a transport `error`, or an empty result: shows the existing "Not enhanced" marker and
  generates anyway with the original, unmodified prompt (fail open).
- The generate button shows a brief "Enhancing..." busy state for the duration (cold start on the writer
  host is roughly 7-8 seconds), restored to its original text once the request settles.

This resolves exactly once per real click, never per image in a batch or grid - the interception happens at
the button itself, not inside `T2IEngine`/`PreGenerateEvent`, neither of which this extension touches.

**"Generate Forever" is not intercepted, on purpose.** `doGenForeverOnce()` (`generatecontrols.js`) calls
`mainGenHandler.doGenerate()` directly - it never touches `alt_generate_button` at all, so there is no click
for the capture-phase listener to see. In `auto` mode, Generate Forever therefore always generates
un-enhanced; enhancing on every tick of a forever-loop would mean a writer-host round trip ahead of every
single image, which is a different feature than this one. Switch to `review` mode (or apply an enhancement
once manually before starting Generate Forever) if you want a forever run to use an enhanced prompt.

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

## Folder/filename override config

A checkpoint library organised by folder can map an entire folder to a profile without depending on any
filename convention within it. This is a **user-editable** sibling of `endpoints.json`, at
`Data/PromptEnhance/overrides.json` (gitignored, same config area). A default file is written on first run:

```json
{
  "_comment": "User-editable folder/filename overrides, consulted before the built-in Illustrious/NoobAI filename fallback. 'pattern' is a regex matched against the model's lowercased, subfolder-relative name (eg 'ill/Auralis_v3.safetensors' starts with 'ill/'). A malformed pattern is logged and skipped rather than disabling the rest of the file.",
  "overrides": [
    { "pattern": "^ill/", "profile": "illustriousxl" },
    { "pattern": "^anima/", "profile": "anima" }
  ]
}
```

Each entry's `pattern` is a regex checked against the model's lowercased `T2IModel.Name`, which is
subfolder-relative - `ill/Auralis_v3.safetensors` starts with `ill/` regardless of what the filename itself
contains. Entries are checked in file order, before the built-in `(^|[\/_ -])(illustrious|noob)` filename
fallback (which stays in place for Illustrious/NoobAI checkpoints outside a configured folder) and before
the model-class and compat-class maps. A malformed regex pattern is logged (`Logs.Error`) and skipped -
never thrown - so one bad line never disables every other override. `PromptEnhanceProfiles.LoadOverrides()`
reloads this file; it runs once from `OnInit`, same as `PromptEnhanceEndpoints.Init()`.

The shipped defaults route a folder of IllustriousXL derivatives (`ill/`) and Anima checkpoints outside the
`anima` compat class (`anima/`) to their profiles even when the filenames carry no recognizable substring at
all - add a line per folder for any other convention your library uses.

## Manual profile override

The panel includes a profile dropdown (**Profile**, above the preview) listing every registered profile plus
an **Automatic** default. Selecting one persists the choice per user (same `localStorage` mechanism as the
mode control) and is sent as `profile_override` on every subsequent status check and `EnhancePrompt`
request - both from the panel and from the auto-enhance path in `auto` mode.

This is the escape hatch for a model with no automatic resolution at all (eg a plain SDXL checkpoint, or a
plain `qwen-image` T2I model, both deliberately left unmapped): the Enhance button always opens the panel
regardless of its enabled state, so the dropdown is reachable even when automatic resolution found nothing.
Picking a profile there re-checks status with the override included, which resolves and re-enables the
button; if the panel was already open, it also re-sends the request immediately with the new override.
`PromptEnhanceProfiles.Resolve` already returns null with a reason (`Unknown profile override '<id>'`) for
an override naming no known profile - that reason surfaces the same way any other disabled-button reason
does, in the button's tooltip.

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

Shipped profile-pack version: **`1.2.0+0d2a1cd9`** (`Assets/profiles/VERSION`, read at extension init and
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
`profiles-noninteractive`, 79 validation cases across the 6-profile 1.2.0 pack.

| Writer model | Grade | Notes |
|---|---|---|
| `huihui_ai/qwen3-vl-abliterated:8b-instruct` | 68/79 mechanically clean | Measured on the writer host (RTX 5080 Laptop, 16 GB, Ollama). Cold first call 7.8s wall; resident call 0.23s wall at ~103 tok/s. Shipped default. |
| `huihui_ai/gemma-4-abliterated:12b` | 68/79 | Same grading pass, same score as the shipped 8B - but not shipped as the default: it emitted invalid JSON in `/json` mode on 5 of the 6 profiles, and its output was unstable, self-contradicting between otherwise-identical calls. |
| `gemma-4-26B-A4B` Q4_K_M v3 | 66/68 (pre-1.2.0, 5-profile pack; not yet re-graded against Krea-2) | Graded 2026-09-10 on the hub. 18 GB on disk - spills on the writer host's 16 GB card, so it's kept as an opt-in `endpoints.json` entry rather than the default. |

Failing pairs for the shipped 8B default: `10/illustrious` INVENTED-SUBJECT; `11/anima` EXAMPLE-LEAK;
`5a/qwenedit` SPURIOUS-CONFLICT; `5a/anima` INVENTED-SUBJECT + EXAMPLE-LEAK; `5a/illustrious` and
`5b/illustrious` INVENTED-SUBJECT; `9 runtime/lora` NO-NOTES on klein9b, qwenedit, anima, illustrious, and
krea-2. The `9 runtime/lora` case (LoRA/protected-token handling) is the 8B's systematic failure mode and
this fork's real workload - it's the reason the syntax shield above exists. Krea-2's only systematic failure
is that same `9 runtime/lora` NO-NOTES case, which 4 of the other 5 profiles fail identically - a writer-model
weakness, not a defect in the Krea-2 profile.

## Not built

Deliberately out of scope:

- A Prompt Enhance entry on the `/simple` mobile client.
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
