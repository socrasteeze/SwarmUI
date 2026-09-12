# Prompt Enhance — architecture-aware local-LLM prompt writer

**Status:** design only. Nothing is implemented. Written 2026-09-12 against fork HEAD `64ba46f`.
**Branch:** `claude/prompt-enhancer-local-llm-39bs9z` (SwarmUI and ComfyUI both).

## Mission

The user types an idea. A local LLM rewrites it into a prompt shaped for the image model that is
actually loaded, using a per-architecture system profile. The rewritten prompt goes back into the
prompt box. The user generates as normal.

The writer model runs on a second machine so it never competes with image generation for VRAM.

## Topology (decided)

```
Browser -> Hub SwarmUI -> PromptEnhance extension
                            |
                            |  POST http://<writer-host>:11434/api/chat   (tailnet)
                            |  system = profile selected from the hub's loaded model class
                            v
                          Writer host: Ollama (or any OpenAI-compatible server)
                            |
                            |  streamed tokens
                            v
                          Hub: prompt box -> normal generation on hub GPU
```

The writer host is a laptop on the tailnet. In this flow it does **no image generation** — the hub
handles all computation and all generation. The writer host does not need SwarmUI running at all.

### Why not the spoke protocol

The spoke channel was evaluated and rejected for this feature. Three findings, all verified in tree:

1. **Feature negotiation would mint a phantom T2I backend.** `SwarmSwarmBackend.cs:989` filters remote
   backends by `HasRoutableModelCapacity(canLoadModels, maxUsages)`. `AbstractBackend.CanLoadModels`
   defaults `true` (`AbstractBackend.cs:108`) and neither LLM backend overrides it. An LLM backend
   registered on a spoke would be mirrored onto the hub as a nonreal image backend, counted in
   `runningBackends`, and offered image jobs. The code states the gap directly:
   `// TODO: support remote non-T2I Backends` (`SwarmSwarmBackend.cs:1002`).
2. **Lockstep.** `SwarmSwarmBackend.cs:292` parks the spoke in `loading` forever on any `VaryID`
   mismatch. Any spoke-side code means a manual two-machine deploy on every iteration.
3. **The LLM backend it would ride on is a stub.** `SimpleRemoteLLMBackend.GenerateLive` throws
   `NotImplementedException` (`SimpleRemoteLLMBackend.cs:63`), and both routes in `src/WebAPI/LLMAPI.cs`
   throw. Implementing them means editing upstream core files in a high-merge-risk area, and upstream
   will eventually land its own implementation.

A direct HTTP call from a fork-owned hub extension needs none of that.

The spoke path stays available for its original mission (hub-routed image generation on a GPU worker)
and is untouched by this feature.

## What already exists

### SwarmUI — LLM scaffolding is named, not wired

| File | State |
|---|---|
| `src/LLMs/LLMParamInput.cs` | 15 lines, self-labeled "aggressively a placeholder proof-of-concept" |
| `src/Backends/AbstractLLMBackend.cs` | Clean abstraction: `Generate` + `GenerateLive` |
| `src/Backends/SimpleRemoteLLMBackend.cs` | OpenAI-compatible shape; `GenerateLive` throws. Settings class already carries Address, `[ValueIsSecret]` auth header, extra headers, connect timeout |
| `src/Backends/LlamaSharpLLMBackend.cs` | In-process llama.cpp via LlamaSharp; functional, no vision, hardcoded 4096 context |
| `src/WebAPI/LLMAPI.cs` | Both routes throw `NotImplementedException` |
| `src/Accounts/Permissions.cs:92` | `basic_text_generation` permission already registered, default USER, `PermSafetyLevel.SAFE` |
| `src/Backends/BackendHandler.cs:117-118` | Both LLM backend types already registered with the handler |

None of this is used by the design below. It is recorded so a later session does not rediscover it,
and because a future upstream implementation is the natural place to migrate to.

### SwarmUI — architecture detection is free

`T2IModel.ModelClass.ID` and `.CompatClass.ID` already identify the loaded model. Relevant IDs from
`T2IModelClassSorter.cs`:

- `flux-2-klein-4b` (`:84`), `flux-2-klein-9b` (`:85`)
- `qwen-image` (`:78`), `qwen-image-edit` (`:688`), `qwen-image-edit-plus` (`:692`)
- `stable-diffusion-xl-v1` (`:59`)

Three of the five existing profiles map off the class ID alone.

**Known ambiguity:** Anima and IllustriousXL both sort as `stable-diffusion-xl-v1`. Class ID cannot
split them. Resolution: a filename/regex override map consulted before the class map, plus a manual
override control in the UI. Do not attempt to infer the derivative from the class.

### SwarmUI — the feature template

The fork's Interrogate extension is the working precedent for exactly this shape of feature:

- `src/BuiltinExtensions/Interrogate/` — 312 C# lines + 416 JS, **zero core-file edits**, all new files
- Registry as a public static dict other extensions can extend (`InterrogateBackends.cs:31`)
- Streams over websocket via `API.RunWebsocketHandlerCallWS` (`InterrogateAPI.cs`)
- Extension registers assets in `OnPreInit`, API in `OnInit` (`InterrogateExtension.cs:24-33`)

Copy this skeleton.

### ComfyUI — the profiles already exist and are graded

`fork_tools/prompt_guides/` on the ComfyUI fork branch holds the substantive work:

- `profiles/*.system.md` — five interactive per-architecture writer profiles (klein 4B, klein 9B,
  qwen-image-edit-2511, anima, illustriousxl)
- `profiles-noninteractive/*.system.md` — generated copies with an added non-interactive section, for
  use where a program consumes the reply and no human can answer a question
- `profiles-noninteractive/README.md` — the **caller contract**: a reply beginning `CONFLICT:` is a hard
  stop (show the line, generate nothing); a reply beginning `NEEDS INPUT:` should not occur and is
  likewise a hard stop plus a profile miss
- `harness/dryrun.py` — runs every profile against `VALIDATION_CASES.md` on any Ollama or
  OpenAI-compatible server, one fresh conversation per (profile, case). Server from
  `PROMPT_GUIDES_OLLAMA`, defaults to loopback
- `harness/grade.py`, `harness/patch_profiles.py`, `results/*.json` — graded runs for a Qwen 8B writer
  and a Gemma 26B-A4B writer
- `output.schema.json`, `RESEARCH_NOTES.md`, `VALIDATION_CASES.md`, `CHANGELOG.md`

**This is the intellectual property of the feature.** SwarmUI's job is selection and transport only.

## Design

### Where the profiles live

Copies ship as assets inside the SwarmUI extension
(`src/BuiltinExtensions/PromptEnhance/Assets/profiles/`), versioned with a profile-pack version string.
The ComfyUI tree stays the authoring, validation and grading home.

Rationale: a cross-repo path dependency would make the SwarmUI build depend on a ComfyUI checkout
being present at a particular path on every machine. A copy plus a recorded version is the lesser evil,
and the recorded version is what makes a stale copy detectable.

### Endpoint registry, not a single address field

Model it on `InterrogateBackends.Backends` (`InterrogateBackends.cs:31`): an **ordered** list of entries,
each with URL, writer model name, keep-alive, timeout, enabled flag. First healthy entry wins.

Ordered list rather than one address so a second writer host, or a hub-local fallback, is a config line
rather than a refactor. This is the only forward-looking element worth carrying in v1.

### Selection

1. Read the loaded model's `ModelClass.ID` / `CompatClass.ID`.
2. Consult the filename override map (handles the SDXL derivatives).
3. Fall back to the class map.
4. Fall back to no profile — in which case the Enhance control is disabled with a reason shown, not
   silently run against a wrong profile.
5. A manual override control always wins over all of the above.

### Cache

Key: `hash(prompt + profile_id + profile_version + writer_model)`.

Not an optimization — a correctness requirement. It is what makes batches, grids, and reruns behave
consistently, and it is what lets a repeat prompt work while the writer host is asleep.

### Transport

`POST {endpoint}/api/chat` (Ollama) or `/v1/chat/completions` (OpenAI-compatible), streamed.
System message = the selected non-interactive profile, verbatim. User message = the raw idea.
Reply streams into the prompt box token by token over the websocket, same pattern as
`InterrogateAPI.InterrogateImage_Internal`.

`keep_alive` is sent explicitly on every request. Long (e.g. `30m`) while the writer host is dedicated
to writing — residency is where the latency goes. `0` only if that host is being switched back to
image duty.

### Failure posture

| Condition | Behavior |
|---|---|
| Endpoint unreachable / timeout | **Fail open.** Prompt passes through unchanged, with a visible "not enhanced" marker in the UI. Never silently generate off an un-enhanced prompt the user believes was enhanced |
| Reply begins `CONFLICT:` | **Fail closed.** Show the line. Generate nothing. The request is unsatisfiable by one image |
| Reply begins `NEEDS INPUT:` | **Fail closed**, and log it as a profile miss — the non-interactive profile should never emit this |
| No profile for the loaded class | Control disabled with the reason shown |

Health probe (`GET /api/tags`) before dispatch, result cached a few seconds. Connect timeout 5s, not 30
— the writer host is a laptop on a LAN/tailnet, and upstream's own settings comment in
`SimpleRemoteLLMBackend.cs` says to use a low value for local-network machines.

### Provenance

Image metadata records: original prompt, final prompt, profile ID, profile-pack version, writer model,
endpoint ID. Without all six the history is not reproducible.

## Integration points considered

| Option | Verdict |
|---|---|
| **A. Explicit Enhance button + API route** | **Build this.** No generation-path risk, user reviews before generating, no reproducibility problem, zero core edits |
| **B. Auto-enhance on generate** | Second increment. Resolve **once at request intake**, not in `T2IEngine.PreGenerateEvent` (`T2IEngine.cs:284`) — that is a synchronous `Action` firing per image task, so an LLM call there blocks a thread and pays full latency on every image in a batch or grid |
| **C. `<llm:...>` prompt tag** | Novelty only. `T2IPromptHandling.PromptTagProcessors` is a public static dict (`T2IPromptHandling.cs:136`) and trivially extensible, but processors are synchronous `Func<string, PromptTagContext, string>`, so it would block on `.Result` inside prompt parsing — which also runs in wildcard and length-estimation paths |
| **D. Spoke-side route via `SendAPIJSON`** | Rejected for v1, see above. If a third machine ever joins, revisit: `SwarmSwarmBackend.SendAPIJSON` (`:1284`) is a generic forwarder, and a route registered `isUserUpdate: true` rides the existing controller auth (`API.IsSpokeRequestAuthorized`, `API.cs:41`) |

## Traps

- **Do not register an LLM backend that leaves `CanLoadModels` at its `true` default** on any machine the
  hub treats as a Swarm-API backend. It will be mirrored as an image backend and offered image jobs.
  See `SwarmSwarmBackend.cs:989` and `AbstractBackend.cs:108`.
- **Dual-role on one GPU is a scheduling problem worth avoiding, not solving.** If the writer host is
  ever also serving as an image spoke, disable its Swarm-API backend on the hub while it is on writer
  duty — `ToggleBackend` (`BackendAPI.cs:124`) persists the state (`BackendHandler.cs:753`). The hub can
  also read `BackendData.CheckIsInUseAtAll` (`BackendHandler.cs:300`) if an automatic check is ever
  wanted. Pick one posture per session instead.
- **A 26B-class writer will not co-reside with Flux or SDXL on a laptop card.** In the decided topology
  this does not arise, because the writer host does no image work — which is precisely why the bigger
  graded writer becomes available.
- **Profiles are non-deterministic text.** Never apply enhancement silently inside a saved preset or a
  grid run.
- Writer-host availability is the main failure mode. It is a laptop: it sleeps, closes, and leaves the
  tailnet. Fail-open plus the cache is what makes that a non-event.

## Build phases

**Phase 1 — hub extension only.** New directory `src/BuiltinExtensions/PromptEnhance/`: extension class,
API route, endpoint registry with health probe, profile assets, class-to-profile map, cache, Enhance
button with streaming, caller-contract enforcement, metadata provenance. No spoke code, no core-file
edits, nothing in the generation path. Writer host runs Ollama only.

**Phase 2 — full profile coverage and polish.** All five profiles, filename override map for the SDXL
derivatives, manual override control, optional auto-enhance-on-generate resolved once at request intake
(option B above).

**Phase 3 — only if a third machine joins.** Spoke-side enhance route through `SendAPIJSON`. Buys one
auth surface, hub-visible health, and no second tailnet port. Costs lockstep deploys forever.

## Before writing C#

Run the existing harness against the real writer host and record the numbers:

```
PROMPT_GUIDES_OLLAMA=http://<writer-host>:11434 python fork_tools/prompt_guides/harness/dryrun.py <model>
```

It needs no changes to do this. What it settles: resident versus cold latency, and whether the 26B
writer's quality margin over the 8B justifies its load time. That decides the shipped default and it is
free to measure.

## Verification (when Phase 1 is built)

Per `AGENTS.md`:

```powershell
dotnet build SwarmUI.sln --configuration Release
dotnet test SwarmUITests/SwarmUITests.csproj --configuration Release
dotnet format SwarmUI.sln --verify-no-changes
dotnet format style --verify-no-changes
```

Plus a live check that the Enhance control is hidden or disabled, and generation is unaffected, when no
endpoint is configured.
