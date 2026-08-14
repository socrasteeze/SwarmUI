# `/simple` Prompt Coach Plan

Backburner design for a mobile-first, profile-aware prompt assistant. No implementation has shipped yet.

Primary doctrine source: [CircleStone Labs Anima model card](https://huggingface.co/circlestone-labs/Anima), checked 2026-08-12.

## Objective

Help a user move from legacy SDXL/Illustrious prompting habits to the prompt language expected by the effective checkpoint, while preserving full manual control.

The coach must answer four questions without becoming another prompt editor:

1. Which prompt doctrine applies to the checkpoint that will actually generate?
2. What setup does that doctrine recommend for positive, negative, Steps, and CFG?
3. What does each active LoRA expect, and where should its trigger belong?
4. What is wrong or suboptimal in the current prompt, with a safe one-tap repair?

## Product decisions

- The **effective base checkpoint owns the prompt profile**. A LoRA never silently changes the global syntax.
- A LoRA contributes its compatibility class, exact metadata trigger, and an optional user-assigned role: Character, Series, Artist, Style, or General.
- Selecting a checkpoint or LoRA never rewrites a prompt. Every mutation is explicit, previewed, idempotent, and undoable.
- The existing positive and negative text in `mState.params` remain the only prompt source of truth. The coach derives a view from them; it does not maintain a second hidden prompt document.
- Tag, natural-language, and hybrid prompting are separate modes. Tag normalization is never run against prose.
- Unknown content is preserved byte-for-byte and in stable order. A classifier being unsure is not permission to move or rewrite text.
- The feature starts in `/simple`. Genpage parity is a separate decision after the workflow proves itself on-device.

## Entry point and mobile flow

Add a slim, non-modal profile button beside the prompt heading. Model and LoRA selection never launches a wizard:

```text
Prompt: Anima Aesthetic · Tags        2 advisories ›
```

Tapping it opens a bottom sheet with four compact sections.

The sheet leads with fast actions before the detailed controls:

- preview and `Add missing` for the positive starter;
- preview and `Add missing` for the negative starter;
- LoRA trigger status: Covered, Missing, or No metadata;
- `Build ordered draft`.

### 1. Profile

- Shows the effective checkpoint, including a preset override.
- Shows the resolved profile and confidence: explicit, metadata, inferred, or unassigned.
- Offers `Auto`, `Anima Base`, `Anima Aesthetic`, `Anima Turbo`, and `Generic / off` when the checkpoint is Anima-compatible. Auto always displays its result, for example `Auto: Anima Aesthetic`.
- Offers `Remember for this checkpoint`. Store a confirmed choice by model hash when available, with normalized model path as the fallback. Third-party finetunes therefore never inherit an Aesthetic/Turbo guess forever from a filename heuristic.

### 2. Mode

- **Tags** — lint and compose an ordered draft from comma-separated tags. Never rearrange the existing prompt.
- **Natural language** — show model tips only: use ordinary capitalization for names, write at least two sentences, and describe each character's appearance in multi-character scenes. Do not lowercase, replace underscores, or reorder sentences.
- **Hybrid** — manage only known prefix/artist/LoRA items. Leave the freeform caption block untouched.

Anima's tag dropout means the coach does not nag for exhaustive tagging. It reports doctrine violations and missing user-selected ingredients, not every tag the image might contain.

### 3. Setup and advisories

Examples:

- `Add recommended positive prefix`
- `Merge recommended negative`
- `Aesthetic: score tags are discouraged in positive and negative`
- `Artist “nnn yryr” is missing @`
- `Tag mode: 17 underscore tags can use spaces; score_5 is preserved`
- `Turbo: current Steps 30 / CFG 4.5; recommended 8–12 / 1`

Each repair opens an exact before/after preview. `Apply` writes once and exposes `Undo` until the next coach mutation. Existing Aesthetic score tags are warning-only; the coach highlights them but never deletes them as a side effect of another action.

The ordered composer follows `lead → subject → character → series → artist → general` and keeps a live draft separate from the real prompt. Its primary action is `Use draft` when the prompt is empty or `Insert at cursor` when populated; `Copy` is always available. Ordering feedback remains advisory.

### 4. Active LoRAs

Each active LoRA row shows:

- current weight and metadata default weight when available;
- metadata trigger phrase, unchanged;
- metadata usage hint as read-only guidance, never executable prompt text;
- compatibility with the effective checkpoint;
- role selector: Character, Series, Artist, Style, General;
- `Insert exact trigger` and `Edit then insert`;
- the destination section in Tags mode.

Do not automatically prefix an arbitrary LoRA activation token with `@`. `@` is applied only to a TagDex-known artist or after the user explicitly marks text as an artist tag. A style LoRA's private activation token may not be an artist name.

Preserve LoRA activation text literally. Never lowercase it or replace its underscores: trained words are not ordinary booru tags. Secondary metadata sources can also produce large, noisy trigger lists, so show the exact phrase and require the user to choose it rather than treating every harvested word as mandatory.

Keep the existing `<trigger>` shortcut. Label it as a bundled shortcut that expands all active model/LoRA triggers at one location and therefore cannot be sectioned by role. If `<trigger>` is already present, every metadata trigger is reported as covered. A separate `Add dynamic triggers` action inserts the shortcut only after confirmation.

Do not reuse the current model-card trigger-chip callback for `Insert exact trigger`: that callback routes through global `<trigger>` and discards the selected literal phrase. The coach owns a separate literal insertion path so role, destination, and source identity survive.

Prompt-syntax LoRAs found directly in prompt text are reported separately. Do not claim that the selected LoRA parameter is an exhaustive list of everything influencing the prompt.

Build this list from effective `loras` and `loraweights`, including additions supplied by active presets. Mark preset-owned LoRAs as locked. Reuse rich rows already cached by the picker; otherwise lazily call `DescribeModel` for only the active names with bounded concurrency. Missing metadata is reported plainly, never guessed from a filename.

Adding a LoRA must not force a modal. Its active row gains a visible `Prompt` action, and the normal confirmation can report `Trigger available`.

## Profile resolver

Resolve against `mState.buildGenInput()['model']`, not the raw manual model param. This keeps the coach aligned when an active preset overrides the user's pick.

Priority:

1. Per-user, per-checkpoint override, keyed by hash with normalized path fallback.
2. Exact model metadata tag `prompt-profile:<profile-id>`.
3. Exact official filename patterns, presented as a suggestion until confirmed:
   - `anima-base-*` → `anima-base`
   - `anima-aesthetic-*` → `anima-aesthetic`
   - `anima-turbo-*` → `anima-turbo`
4. Architecture or compatibility class `anima` → variant chooser.
5. No match → `No coach`.

Architecture and compatibility identify only the Anima family. Base, Aesthetic, and Turbo currently serialize with the same family identity, so neither field may choose a variant by itself. Civitai import also does not currently retain an Anima `baseModel` value. The explicit metadata marker is a future/manual enrichment path, not data the resolver may assume exists.

`ListT2IParams.models` already supplies model name → class ID, enough to identify Anima compatibility without opening a picker. `DescribeModel` supplies `architecture`, `compat_class`, `usage_hint`, `trigger_phrase`, `tags`, hash, title, and description when richer resolution is needed. Cache targeted descriptions by subtype/name. Fetch only the effective checkpoint and active LoRAs; the coach must never request the full LoRA catalog.

Filename/title/description heuristics are never high-confidence assignments for third-party finetunes. They may raise a suggestion; only metadata or a user confirmation persists a profile.

## Profile schema

Keep doctrine in fork-owned data, separate from UI code. Initial shape:

```js
{
    id: 'anima-aesthetic',
    family: 'anima',
    revision: 1,
    sourceUrl: 'https://huggingface.co/circlestone-labs/Anima',
    modes: ['tags', 'natural', 'hybrid'],
    positivePrefix: ['masterpiece', 'best quality'],
    negativeSuggested: ['worst quality', 'low quality', 'artist name', 'blurry', 'jpeg artifacts', 'chromatic aberration'],
    forbiddenPatterns: [/^score_[1-9]$/],
    parameterAdvice: { steps: [30, 50], cfgscale: [4, 5] },
    sections: ['lead', 'subject', 'character', 'series', 'artist', 'general']
}
```

Profile definitions are versioned. User assignments store the profile ID, not a copy of its rules, so doctrine fixes apply without rewriting preferences.

## Initial Anima profiles

### Anima Base / standard

- Suggested positive prefix: `masterpiece, best quality, score_7, safe`.
- Suggested negative: `worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration`.
- Generation advice: 30–50 Steps, CFG 4–5.
- Tag rules: lowercase; spaces instead of underscores except `score_*`; Gelbooru spelling preferred when a verified alias map exists; artist tags use `@`.
- Weighting guidance is advisory only. Show the official `(chibi:2)` example; do not auto-increase user weights.

### Anima Aesthetic

- Default Quality mode is None. `masterpiece, best quality` is an optional Human quality choice that is safe but not required.
- Do not expose score chips in the composer. Flag existing `score_*` in both positive and negative prompts with a warning and explanation; never strip them silently.
- Do not claim an official Aesthetic-specific negative prompt where none is published. A helper may offer the standard negative with `score_*` removed, clearly labeled as derived.
- General generation advice remains 30–50 Steps, CFG 4–5 unless the source doctrine changes.

### Anima Turbo

- Same tag/caption language as the family unless the source publishes a separate prompt rule.
- Strong parameter advisory: CFG 1, 8–12 Steps.
- Never apply those values silently. The existing Steps/CFG steppers must show the effective values before and after the action.

## Tag section model

Official order:

```text
quality/meta/year/safety → subject count → character → series → artist → general
```

The first implementation classifies only high-confidence data:

- curated quality, score, period, meta, and safety vocabularies;
- `year ####` by pattern;
- `1girl`, `1boy`, `1other`, `no humans`, and similar curated subject markers;
- TagDex records, which already expose `kind`, character trigger, series/copyright, and artist identity;
- user-confirmed LoRA roles;
- everything else → General, retaining original order.

Gelbooru-vs-Danbooru substitution cannot be automated from the current data. Do not invent aliases. Add it only after a reviewed alias asset exists; until then the coach states the preference without rewriting.

## Safe prompt parsing

Tags mode needs a top-level comma tokenizer, not `split(',')`. It must preserve commas inside:

- weighted/grouped expressions such as `(red hair, blue eyes:1.5)`;
- Swarm tags such as `<random:a,b>` and `<segment:text,0.6,0.5>`;
- escaped text, quotes, and nested `()`, `[]`, `{}`, and `<>`.

Each token retains its exact raw slice plus a normalized comparison key. Dedupe and classification use the key; untouched serialization uses the raw slice.

Normalization is an explicit previewed action. It lowercases top-level tag text and replaces underscores with spaces, except exact `score_[1-9]` tokens. It must not modify model paths, prompt syntax, wildcard names, macro bodies, or freeform prose.

Ordering applies only to the coach's ephemeral draft. It never moves tokens in the source prompt. Unknown tokens keep relative order in General. If the tokenizer encounters unbalanced syntax, draft building is disabled and the sheet points to the location instead of guessing.

Analysis runs against the effective prompt from `mState.buildGenInput()`, while an accepted edit targets the raw positive or negative field. After patching a copy, rebuild the effective input first. If an active preset replaces the field and the proposed change disappears, block the action with `Active preset replaces this prompt` instead of pretending it worked. `Add missing` changes only the missing starter tokens and preserves the remainder byte-for-byte.

Natural-language blocks are opaque to tag lint. High-confidence advisories include duplicate normalized tags, conflicting safety tags, Aesthetic score tags, missing `@` on coach-selected artists, and missing LoRA triggers.

## Persistence

Phase 1 stores a versioned, non-generation `promptGuide` block inside the existing `m_client_state`. Persist:

- schema version;
- checkpoint → profile overrides;
- LoRA hash/name → role/edited-trigger preferences;
- preferred prompt mode per profile family;
- coach enabled/disabled.

Do not persist parsed sections or fetched model metadata. The visible prompt is authoritative; a second prompt document will drift. Existing `/simple` reset behavior clears this client state.

Cross-device persistence is a later option: extension-owned get/set methods can use `User.SaveGenericData("simple_prompt_coach", "prefs", ...)`, following TagDex's pattern. If added, mirror the last response locally for instant PWA paint and let server data win after reconciliation. Do not store full prompts in either preference blob; `mState` already owns them.

Built-in profiles and cached assignments remain usable offline. Missing model metadata degrades to manual profile selection. If TagDex is absent or not loaded, keep plain character, series, and artist inputs available and point to `More → TagDex datasets` when possible; the coach must not maintain a second character/artist index.

## Proposed implementation

New fork-owned files:

```text
src/BuiltinExtensions/MobileEnhancements/Assets/m/m_prompt_profiles.js
src/BuiltinExtensions/MobileEnhancements/Assets/m/m_prompt_coach.js
```

Small edits:

- `MobileEnhancementsExtension.cs` — register both assets. Optional cross-device preference APIs stay here; no core edit is required.
- `Assets/m/index.html` — load profiles and coach after TagDex's optional hook and before `m_create.js`.
- `Assets/m/m_state.js` — versioned guide preference defaults/load/save.
- `Assets/m/m_create.js` — profile entry point, active-LoRA Prompt action, selected-model notification.
- `Assets/m/m_models.js` — retain an already-loaded rich LoRA row and notify the coach without forcing catalog loading.
- `Assets/m/m_autocomplete.js` — optional known-entry callback so a TagDex artist/character insertion carries role metadata. Existing insertion remains the fallback.
- `Assets/m/m.css` — sheet, issue rows, role chips, and diff preview.
- `AGENTS.md` and this plan — coupling log.

Keep the coach isolated from generation transport. It may read and explicitly edit `mState`; `m_gen.js` must not know it exists.

## Delivery phases

1. **Profile and read-only coach.** Resolver, profile pill, mode selector, doctrine card, Steps/CFG advisories. No prompt mutation.
2. **Safe setup actions.** Idempotent prefix/negative merge, Aesthetic score cleanup, exact preview, one-level undo.
3. **LoRA prompt guidance.** Lazy model metadata, role assignments, compatibility warning, exact/editable trigger insertion.
4. **Tag-aware lint and ordered draft.** Syntax-aware tokenizer, high-confidence sections, normalization preview, TagDex role bridge. Existing prompt order remains untouched.
5. **Custom profiles.** User-authored templates and other checkpoint families only after the Anima workflow is proven on a phone.

Each phase must be independently useful. Do not make prompt generation depend on later phases.

## Verification gates

Static:

- `node --check` on every changed `/simple` script.
- `dotnet format SwarmUI.sln --verify-no-changes --no-restore` for API additions.
- tokenizer fixtures for nested/escaped Swarm syntax, weighted groups, prose, score tags, and malformed input.
- resolver fixtures covering preset override, official Base/Aesthetic/Turbo names, metadata override, third-party Anima finetune, and unknown models.
- resolver fixture proving a LoRA named `aesthetic` cannot change the checkpoint profile.
- idempotence: applying the same repair twice produces no second diff.
- round trip: no-op analysis serializes the prompt byte-for-byte.
- preset guard: a preset that replaces the prompt blocks an ineffective raw-field patch.
- metadata budget: opening the coach describes only the effective checkpoint and active LoRAs, never the full LoRA list.

On-device:

- 390px and 430px portrait widths; keyboard open and closed.
- one-hand path: choose checkpoint → add LoRA → inspect trigger → apply scaffold → Generate.
- profile changes with a populated prompt never mutate before confirmation.
- preset-overridden model shows the same effective model in the model button and coach.
- preset-supplied LoRAs appear as locked rows without loading the full catalog.
- Aesthetic warning catches score tags in both prompts; Base does not forbid them.
- Turbo advisory updates Steps/CFG only after confirmation.
- TagDex artist inserts `@`; arbitrary LoRA activation text does not gain it.
- malformed prompt syntax disables ordered-draft building without losing text.
- TagDex unavailable and offline/PWA paths retain built-in recipes and plain manual inputs.

## Explicit non-goals

- No LLM-generated prompt rewriting.
- No automatic prompt mutation on model/LoRA selection or generation.
- No automatic reordering, lowercasing, underscore replacement, or score-tag removal in an existing prompt.
- No guessing that every LoRA trigger is an artist/character tag.
- No broad Danbooru→Gelbooru rewrite without a verified mapping.
- No startup or coach-open request for the full LoRA collection.
- No interpretation of `usage_hint` prose as prompt syntax.
- No replacement for presets. Profiles explain and repair prompt doctrine; presets remain parameter bundles.
