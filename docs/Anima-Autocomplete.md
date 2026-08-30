# Anima Autocomplete Tag List

Fork-owned note. Covers which prompt autocompletion word list to use with the **Anima** model family, why the obvious choices are wrong, and how to rebuild the list when a fresher source appears.

See [Autocompletions](/docs/Features/Autocompletions.md) for the engine itself.

## The rules, from the model card

These are not preferences. They come from Anima's own model card ([circlestone-labs/Anima](https://huggingface.co/circlestone-labs/Anima)), and each one disqualifies at least one popular tag list:

- *"Use lowercase for tags, and **spaces instead of underscores**. Score tags are the only tags that use underscores."*
- *"When using a tag that is different between Danbooru and Gelbooru, **prefer the Gelbooru version**."*
- *"Prefix artist with @. E.g. `@big chungus`. **You must put @ in front of the artist.** The effect will be very weak if you don't."*
- Tag order: `[quality/meta/year/safety] [1girl/1boy] [character] [series] [artist] [general]`.

Anima is `anima-base-v1.0` from CircleStone Labs and Comfy Org — a 2B model with a Qwen3 text encoder and a Qwen Image VAE. It is **not** SDXL, NoobAI or Illustrious lineage, so a tag list matched to those models is matched to the wrong thing.

## What not to use

| List | Why it fails |
| --- | --- |
| `NoobAIXL1.1_underscore.csv` | Built for NoobAI XL v1.1 (SDXL family). Underscored, danbooru+e621, tag cutoff 2024-11-03, and **zero** `@`-prefixed artists. Also carries e621 category ids (2, 6, 7, 8) outside the 0–5 range SwarmUI colors. |
| `illustriousV1.0_underscore.csv` | Different model, oldest data of the three. |
| `gelbooru_anima_2026-06-11.csv` | Right on convention and Gelbooru preference, but no `@` prefix and almost no aliases. Despite the filename it is not an Anima-matched build — "Anima" there is the uploader's Civitai category. |
| `anima-1.0.csv` | Matches official Anima's 2025-09-01 cutoff and has the `@` prefix, but its release note calling it "gelbooru based" does not hold up: its `1girl` sits at Danbooru's 7,868,012, and it is missing Gelbooru-first vocabulary such as `sole_female` (3.9M posts). It resolves the card's most explicit vocabulary rule the wrong way. |

## What this fork uses

`Data/Autocompletions/anima_gelbooru_2026-08-13.csv`, built by [`tools/compile_anima_tags.py`](/tools/compile_anima_tags.py) from BetaDoggo's `anima-2.9B-preview-V1.csv`.

That upstream file is the freshest genuinely Gelbooru-sourced list available (`1girl` at 9,552,681), already `@`-prefixes artists, and uses clean 0–5 categories. Its cutoff (2026-08-12) runs past official Anima's September-2025 knowledge, which is accepted deliberately: surplus tags are harmless noise in a completion list, whereas missing Gelbooru vocabulary breaks a rule the model card states outright.

The compiler fixes four defects, none of which any published list fixes:

1. **1,953 tag names carrying undecoded HTML entities** — `girls&#039;_frontline`, `grabbing_another&#039;s_breast`. A regression from that repo's 2026-08-13 Gelbooru-support commit; they would otherwise autocomplete as literal broken text.
2. **Underscores converted to spaces**, exempting `score_1`–`score_9` and ~20 kaomoji tags (`^_^`, `o_o`, `|_|`).
3. **Aliases merged from Danbooru's public alias table** (40,857 active pairs, no auth). Gelbooru exposes none, so alias coverage rises from 10,558 rows to 67,099.
4. **45 control tags added** at category 5 — the quality set, `score_1`–`score_9`, period and `year` tags, safety tags. None existed, despite `masterpiece, best quality, score_7, safe` being the card's own recommended prefix. Their post-count column is left at `0` rather than given a synthetic weight, because that column holds real counts everywhere else.

Artists keep the bare name in the alias column, so typing `dairi` still finds `@dairi` — SwarmUI's matcher tests aliases and gives alias hits their own priority bucket.

## Settings

- `AutoCompletionsSource` → `anima_gelbooru_2026-08-13.csv`
- `SpacingMode` → **`None`**

`SpacingMode` must stay `None`. Setting it to `Spaces` looks like a fix for an underscored list, but it is a blanket `_`→space replace: it would rewrite `score_7` to `score 7`, which the card forbids, and mangle every kaomoji tag. The conversion is done at compile time instead, where those exemptions exist.

A newly added list file is not picked up until the autocomplete cache refreshes — restart, or hit Refresh on the Generate tab.

## Rebuilding

```
python tools/compile_anima_tags.py <source.csv> Data/Autocompletions/<dest.csv> [danbooru_aliases.json]
```

The alias JSON is optional; without it the merge step is skipped. Build it from Danbooru's public endpoint:

```
https://danbooru.donmai.us/tag_aliases.json?limit=1000&search%5Bstatus%5D=active&search%5Border%5D=tag_count&only=antecedent_name,consequent_name&page=N
```

41 pages at `limit=1000`, no authentication, keyed consequent → antecedents.

Name the output after **the source data's date, not the build date**. A file named for the day it was compiled asserts a recency it does not have.

Sourcing notes for whoever rebuilds this:

- BetaDoggo's `Model-Tags` release is a **rolling** release. Its page says "Published Feb 9, 2025", which is the git tag date; assets are uploaded into it continuously. Read each asset's `created_at`, not the release date.
- Gelbooru's tag API requires a free account's `api_key` and `user_id`; without them it returns HTTP 401. The keyless web listing is capped at `pid=20000` and silently repeats page 1 beyond that, so it cannot be paginated to a post-count threshold.
- Gelbooru exposes no tag creation date, so a Gelbooru-sourced list **cannot** be backdated to a model's knowledge cutoff. That is the reason no perfectly-matched Anima list exists.
