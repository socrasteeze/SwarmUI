"""Compile an Anima-correct autocomplete tag list for SwarmUI.

Base is BetaDoggo's `anima-2.9B-preview-V1.csv`, which is the freshest genuinely Gelbooru-sourced list
available (asset 2026-08-13, tag cutoff 2026-08-12, `1girl` at 9,552,681 which is Gelbooru's level).
It is chosen over `anima-1.0.csv` despite that file matching official Anima's 2025-09-01 cutoff, because
`anima-1.0.csv` is Danbooru-dominant in practice - its `1girl` sits at 7,868,012, and it is missing
Gelbooru-first vocabulary like `sole_female` and `bangs_between_eyes`. The Anima model card's rule is
explicit: "When using a tag that is different between Danbooru and Gelbooru, prefer the Gelbooru version."
Surplus post-cutoff tags are harmless noise in a completion list; missing vocabulary is a real loss.

Defects in that base which this fixes, none of which any published list fixes:
  1. 1,953 tag names carry undecoded HTML entities (`girls&#039;_frontline`), a regression from the
     2026-08-13 "sloppily add gelbooru support" commit. They autocomplete as literal broken text.
  2. It is underscore-formatted. The model card asks for spaces - "Use lowercase for tags, and spaces
     instead of underscores. Score tags are the only tags that use underscores."
  3. Only 10,558 of 136,815 rows carry any alias, because Gelbooru exposes none. Danbooru's alias table
     is public and unauthenticated, so aliases are merged in from there.
  4. It has no rows for the control vocabulary the card names in its recommended prompt prefix.

Underscore conversion is done here rather than by SwarmUI's `SpacingMode` setting because that setting is
a blanket `Replace("_", " ")`: it would also rewrite `score_7` to `score 7`, which the card forbids, and
it mangles kaomoji tags like `^_^` and `>_<`. This script exempts both.

Category ids follow the a1111-tagcomplete convention SwarmUI reads: 0 general, 1 artist, 3 copyright,
4 character, 5 meta.

Usage: compile_anima_tags.py <source.csv> <dest.csv> [danbooru_aliases.json]
"""
import csv
import html
import json
import re
import sys
from pathlib import Path

SRC = Path(sys.argv[1])
DST = Path(sys.argv[2])
ALIASES = Path(sys.argv[3]) if len(sys.argv) > 3 else None

# Symbol/kaomoji tags whose underscores are part of the token, not word separators. SwarmUI's own
# SpacingMode conversion has no such exemption, which is one reason conversion is done here instead.
KAOMOJI = {
    "o_o", "0_0", "3_3", "6_9", "o_x", "x_x", "t_t", "u_u", "v_v", "e_e",
    "(o)_(o)", ">_<", ">_@", "^_^", "@_@", "+_+", "+_-", "=_=", "._.", ";_;",
    "|_|", "|_|_|", "||_||", "\\||/", "\\m/",
}


def keeps_underscores(tag):
    """True when a tag's underscores must survive conversion to spaces."""
    if tag.startswith("@"):
        # Artist names use underscores as word separators like any other tag.
        return False
    if re.fullmatch(r"score_[1-9]", tag):
        return True
    if tag in KAOMOJI:
        return True
    # Anything with no letters and no digits at all is punctuation art, not words.
    return not re.search(r"[a-z0-9]", tag)


def to_spaces(tag):
    # Strip AFTER converting, not before: a leading or trailing underscore in the source becomes a
    # leading or trailing space, which would otherwise survive into the output as an untrimmed tag.
    return tag if keeps_underscores(tag) else tag.replace("_", " ").strip()


alias_map = {}
if ALIASES and ALIASES.exists():
    alias_map = json.loads(ALIASES.read_text(encoding="utf-8"))

# Control vocabulary the Anima model card names but the scrape has no rows for. Counts are left at 0
# rather than given synthetic weights: this column is a real post count everywhere else in the file, and
# inventing values larger than the entire corpus would make it lie. The default 'Active' sort orders by
# tag length anyway, so these surface on their own.
CONTROL = []
for t in ["masterpiece", "best quality", "good quality", "normal quality", "low quality", "worst quality"]:
    CONTROL.append((t, "5"))
for i in range(9, 0, -1):
    CONTROL.append((f"score_{i}", "5"))
for t in ["newest", "recent", "mid", "early", "old"]:
    CONTROL.append((t, "5"))
for y in range(2026, 2004, -1):
    CONTROL.append((f"year {y}", "5"))
for t in ["safe", "sensitive", "nsfw", "explicit"]:
    CONTROL.append((t, "5"))
for t in ["anime screenshot", "official art", "jpeg artifacts", "artist name"]:
    CONTROL.append((t, "5"))

rows = []
seen = set()
stat = dict(read=0, entities=0, spaced=0, hashed=0, aliased=0, added_alias=0, dupes=0, added=0)

with SRC.open(encoding="utf-8", newline="") as f:
    for row in csv.reader(f):
        if not row or not row[0]:
            continue
        stat["read"] += 1
        raw = row[0]
        cat = row[1] if len(row) > 1 else "0"
        count = row[2] if len(row) > 2 else "0"
        aliases = row[3] if len(row) > 3 else ""

        fixed = html.unescape(raw)
        if fixed != raw:
            stat["entities"] += 1
        tag = fixed.strip().lower()
        if not tag:
            continue
        # SwarmUI treats a leading '#' as a comment and silently drops the row, so keeping these would
        # only inflate the row count with entries that can never complete.
        if tag.startswith("#"):
            stat["hashed"] += 1
            continue

        underscored = tag  # Danbooru's alias table is keyed on the underscore form.
        spaced = to_spaces(tag)
        if spaced != tag:
            stat["spaced"] += 1
        if not spaced:
            continue

        alias_list = [html.unescape(a).strip().lower() for a in aliases.split(",")]
        alias_list = [to_spaces(a) for a in alias_list if a]

        lookup = underscored[1:] if underscored.startswith("@") else underscored
        extra = alias_map.get(lookup)
        if extra:
            stat["added_alias"] += 1
            prefix = "@" if spaced.startswith("@") else ""
            for a in extra:
                a = prefix + to_spaces(a.strip().lower())
                if a and a != spaced and a not in alias_list:
                    alias_list.append(a)
        # Artists insert as "@name" but must stay findable by the bare name; SwarmUI's matcher tests the
        # alias column and gives alias hits their own high-priority bucket.
        if spaced.startswith("@"):
            bare = spaced[1:]
            if bare and bare not in alias_list:
                alias_list.insert(0, bare)

        if spaced in seen:
            stat["dupes"] += 1
            continue
        seen.add(spaced)
        if alias_list:
            stat["aliased"] += 1
        rows.append((spaced, cat, count, ",".join(alias_list)))

for tag, cat in CONTROL:
    if tag in seen:
        continue
    seen.add(tag)
    rows.append((tag, cat, "0", ""))
    stat["added"] += 1

with DST.open("w", encoding="utf-8", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    for r in rows:
        w.writerow(r)

print(f"read                     {stat['read']:>7}")
print(f"html entities repaired   {stat['entities']:>7}")
print(f"underscores -> spaces    {stat['spaced']:>7}")
print(f"'#' rows dropped         {stat['hashed']:>7}")
print(f"rows gaining danbooru alias {stat['added_alias']:>4}")
print(f"rows with any alias      {stat['aliased']:>7}")
print(f"duplicates dropped       {stat['dupes']:>7}")
print(f"control tags added       {stat['added']:>7}")
print(f"written                  {len(rows):>7}  -> {DST}")
