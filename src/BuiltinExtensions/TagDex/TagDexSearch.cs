using FreneticUtilities.FreneticExtensions;

namespace SwarmUI.Builtin_TagDexExtension;

/// <summary>One parsed search request against a loaded dataset.</summary>
public struct TagDexQuery
{
    /// <summary>Lowercased, underscored search text. Empty matches everything.</summary>
    public string Text;

    /// <summary>Bitmask of required hair colors, ORed within the facet. Zero means no constraint.</summary>
    public uint HairColors;

    /// <summary>Bitmask of required eye colors. Zero means no constraint.</summary>
    public ushort EyeColors;

    /// <summary>Bitmask of required hair lengths. Zero means no constraint.</summary>
    public byte HairLengths;

    /// <summary>Bitmask of required genders. Zero means no constraint.</summary>
    public byte Genders;

    /// <summary>Exact copyright to require, or null.</summary>
    public string Copyright;

    /// <summary>Per-user display floor on post count.</summary>
    public int MinCount;

    /// <summary>Whether entries absent from <see cref="FavoriteNames"/> must be rejected.</summary>
    public bool FavoritesOnly;

    /// <summary>The caller's favorited names for the active source. Empty when no favorites exist.</summary>
    public HashSet<string> FavoriteNames;
}

/// <summary>The result of one search: a page of entry indices plus the unpaged total.</summary>
/// <param name="Indices">Indices into the list's Entries array, already ranked.</param>
/// <param name="Total">How many entries matched before paging.</param>
public record class TagDexResults(int[] Indices, int Total);

/// <summary>Scans a loaded dataset.
/// <para>Because <see cref="TagDexList.Entries"/> is pre-sorted by count descending, and results are collected into
/// per-rank buckets in array order, the output is already count-descending within each rank band. The default query
/// therefore performs no sort at all.</para></summary>
public static class TagDexSearch
{
    /// <summary>Hard ceiling on how many results a single request may return, regardless of what the caller asks for.</summary>
    public const int MaxPageSize = 250;

    /// <summary>Runs a query against a loaded list.
    /// <para>Tests are ordered cheapest-first so most rows are rejected on an integer compare before any string work
    /// happens: count floor, then the four facet masks (one AND each), then copyright, then the name match.</para></summary>
    public static TagDexResults Run(TagDexList list, TagDexQuery query, string sortBy, bool sortReverse, int offset, int limit)
    {
        limit = Math.Clamp(limit, 1, MaxPageSize);
        offset = Math.Max(0, offset);
        bool hasText = !string.IsNullOrEmpty(query.Text);
        // Core tags are stored space-separated ("aqua eyes, twintails") while the query is underscore-normalized
        // to match names, so the tag comparison uses the query with its underscores put back as spaces.
        string tagText = hasText ? query.Text.Replace('_', ' ') : null;
        List<int> exact = [];
        // Prefix and word-boundary matches share one bucket, ordered by post count. Booru names put the
        // distinguishing word last ("hatsune_miku", "kirisame_marisa"), so ranking prefix above boundary would put
        // mikuma_(kancolle) at 1,245 posts ahead of hatsune_miku at 103,500 for the query "miku". Treating both as
        // equally strong and letting popularity decide gives the answer a person actually wants.
        List<int> strong = [];
        List<int> weak = [];
        TagDexEntry[] entries = list.Entries;
        string[] names = list.Names;
        for (int i = 0; i < entries.Length; i++)
        {
            ref TagDexEntry entry = ref entries[i];
            if (entry.Count < query.MinCount)
            {
                continue;
            }
            if (query.FavoritesOnly && (query.FavoriteNames is null || !query.FavoriteNames.Contains(entry.Name)))
            {
                continue;
            }
            if (query.HairColors != 0 && (entry.HairColors & query.HairColors) == 0)
            {
                continue;
            }
            if (query.EyeColors != 0 && (entry.EyeColors & query.EyeColors) == 0)
            {
                continue;
            }
            if (query.HairLengths != 0 && (entry.HairLengths & query.HairLengths) == 0)
            {
                continue;
            }
            if (query.Genders != 0 && (entry.Genders & query.Genders) == 0)
            {
                continue;
            }
            if (query.Copyright is not null && !query.Copyright.Equals(entry.Copyright, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            if (!hasText)
            {
                // No search text: everything matches equally, so the natural count-descending array order stands.
                strong.Add(i);
                continue;
            }
            string name = names[i];
            int hit = name.IndexOf(query.Text, StringComparison.Ordinal);
            if (hit < 0)
            {
                // Fall back to the copyright, so searching "genshin" surfaces its cast even though no character's
                // own name contains it; then to the descriptive core tags, so "twintails" or "aqua eyes" finds
                // the characters drawn that way. Both rank below any name hit.
                if (entry.Copyright is not null && entry.Copyright.Contains(query.Text, StringComparison.Ordinal))
                {
                    weak.Add(i);
                }
                else if (entry.CoreTags is not null && entry.CoreTags.Contains(tagText, StringComparison.Ordinal))
                {
                    weak.Add(i);
                }
                continue;
            }
            if (hit == 0)
            {
                if (name.Length == query.Text.Length)
                {
                    exact.Add(i);
                }
                else
                {
                    strong.Add(i);
                }
            }
            else if (name[hit - 1] == '_')
            {
                strong.Add(i);
            }
            else
            {
                weak.Add(i);
            }
        }
        int total = exact.Count + strong.Count + weak.Count;
        List<int> ordered = new(Math.Min(total, offset + limit + 1));
        ordered.AddRange(exact);
        ordered.AddRange(strong);
        ordered.AddRange(weak);
        if (sortBy is not null && sortBy != "relevance")
        {
            Comparison<int> comparison = sortBy switch
            {
                "count" => (a, b) => entries[b].Count.CompareTo(entries[a].Count),
                "solo_count" => (a, b) => entries[b].SoloCount.CompareTo(entries[a].SoloCount),
                "uniqueness" => (a, b) => entries[b].Uniqueness.CompareTo(entries[a].Uniqueness),
                "avg_score" => (a, b) => entries[b].AvgScore.CompareTo(entries[a].AvgScore),
                "name" => (a, b) => string.CompareOrdinal(names[a], names[b]),
                "copyright" => (a, b) => string.CompareOrdinal(entries[a].Copyright ?? "", entries[b].Copyright ?? ""),
                _ => null
            };
            if (comparison is not null)
            {
                ordered.Sort(comparison);
            }
        }
        if (sortReverse)
        {
            ordered.Reverse();
        }
        if (offset >= ordered.Count)
        {
            return new([], total);
        }
        int take = Math.Min(limit, ordered.Count - offset);
        int[] page = new int[take];
        ordered.CopyTo(offset, page, 0, take);
        return new(page, total);
    }

    /// <summary>Builds a query from raw request strings. Facet values are comma-separated and OR within a facet.</summary>
    public static TagDexQuery BuildQuery(string text, string copyright, string hairColor, string hairLength, string eyeColor, string gender, int minCount)
    {
        TagDexQuery query = new()
        {
            Text = string.IsNullOrWhiteSpace(text) ? "" : text.Trim().ToLowerFast().Replace(' ', '_'),
            Copyright = string.IsNullOrWhiteSpace(copyright) ? null : TagDexNames.FromFolderToken(copyright.Trim()),
            MinCount = Math.Max(0, minCount)
        };
        query.HairColors = (uint)MaskFor(TagDexVocab.HairColors, hairColor);
        query.EyeColors = (ushort)MaskFor(TagDexVocab.EyeColors, eyeColor);
        query.HairLengths = (byte)MaskFor(TagDexVocab.HairLengths, hairLength);
        query.Genders = (byte)MaskFor(TagDexVocab.Genders, gender);
        return query;
    }

    /// <summary>Turns a comma-separated list of facet values into a bitmask over the given vocabulary.
    /// Unrecognized values are ignored rather than failing the request.</summary>
    public static ulong MaskFor(string[] vocab, string values)
    {
        if (string.IsNullOrWhiteSpace(values))
        {
            return 0;
        }
        ulong mask = 0;
        foreach (string part in values.Split(','))
        {
            string trimmed = part.Trim();
            if (trimmed.Length == 0)
            {
                continue;
            }
            int bit = TagDexVocab.BitFor(vocab, trimmed);
            if (bit >= 0)
            {
                mask |= 1UL << bit;
            }
        }
        return mask;
    }
}
