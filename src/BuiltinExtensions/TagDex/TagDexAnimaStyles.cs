using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Utils;
using System.Collections.Frozen;
using System.IO;

namespace SwarmUI.Builtin_TagDexExtension;

/// <summary>Loader for the anima-styles gallery export.
/// <para>A curated artist dataset the user supplies locally rather than downloading: 42,509 entries filtered to a
/// post count of at least 45, each carrying a 512x768 style reference image, plus a style-uniqueness score and
/// artwork-quality scores that the raw noob-wiki CSV has no equivalent for. 97.4% of it cross-references
/// <c>danbooru_artist</c>, so it is best understood as a higher-quality curated subset with pictures attached.</para>
/// <para>Metadata lives in <c>Data/TagDex/anima_styles.js</c>, which is the gallery's own <c>app/data.js</c> copied
/// verbatim - a single <c>const galleryData = [ ... ]</c> assignment. Images extract to
/// <c>Data/TagDex/thumbs/anima_styles/{shard}/{id}.webp</c>, keeping the export's own 1,000-per-folder sharding.</para></summary>
public static class TagDexAnimaStyles
{
    /// <summary>Parses the gallery export into a loaded list.</summary>
    public static TagDexList Parse(TagDexSource source, int minCount)
    {
        string path = TagDexData.PathFor(source);
        long startTicks = Environment.TickCount64;
        try
        {
            string raw = File.ReadAllText(path);
            int open = raw.IndexOf('[');
            int close = raw.LastIndexOf(']');
            if (open < 0 || close < open)
            {
                Logs.Error($"[TagDex] '{source.ID}' does not contain a JSON array. Expected the gallery's app/data.js verbatim.");
                return null;
            }
            JArray array = JArray.Parse(raw[open..(close + 1)]);
            List<TagDexEntry> entries = new(array.Count);
            int total = 0;
            foreach (JToken token in array)
            {
                total++;
                if (token is not JObject row)
                {
                    continue;
                }
                string name = (string)row["name"];
                if (string.IsNullOrWhiteSpace(name))
                {
                    continue;
                }
                int count = (int?)row["post_count"] ?? 0;
                if (count < minCount)
                {
                    continue;
                }
                // The gallery already stores names prompt-escaped ("hammer \(sunset beach\)"), which is exactly what
                // should land in a prompt - so it becomes the trigger untouched. The search key is the unescaped,
                // underscored booru slug, matching how every other dataset's name column reads.
                TagDexEntry entry = new()
                {
                    Trigger = name,
                    Name = ToSlug(name),
                    Count = count,
                    Uniqueness = (float?)row["uniqueness_score"] ?? 0f,
                    AvgScore = (float?)row["avg_score"] ?? 0f
                };
                int id = (int?)row["id"] ?? 0;
                int shard = (int?)row["p"] ?? 0;
                if (id > 0 && shard > 0)
                {
                    entry.ThumbPath = $"{shard}/{id}.webp";
                }
                entries.Add(entry);
            }
            TagDexEntry[] sorted = [.. entries];
            Array.Sort(sorted, (a, b) => b.Count.CompareTo(a.Count));
            TagDexList list = new()
            {
                Source = source,
                Entries = sorted,
                TotalRowsInFile = total,
                LoadedMinCount = minCount
            };
            string[] names = new string[sorted.Length];
            Dictionary<string, int> byName = new(sorted.Length);
            for (int i = 0; i < sorted.Length; i++)
            {
                names[i] = sorted[i].Name;
                byName.TryAdd(sorted[i].Name, i);
            }
            list.Names = names;
            list.ByName = byName.ToFrozenDictionary();
            list.ApproxBytes = TagDexData.EstimateBytes(sorted);
            try
            {
                list.FileModifiedUtc = new FileInfo(path).LastWriteTimeUtc.Ticks;
            }
            catch (Exception)
            {
                list.FileModifiedUtc = 0;
            }
            Logs.Init($"[TagDex] Loaded '{source.ID}': {sorted.Length:N0} of {total:N0} styles (min count {minCount}), "
                + $"~{list.ApproxBytes / (1024 * 1024)} MB, in {Environment.TickCount64 - startTicks} ms.");
            return list;
        }
        catch (Exception ex)
        {
            Logs.Error($"[TagDex] Failed to parse '{source.ID}': {ex.ReadableString()}");
            return null;
        }
    }

    /// <summary>Converts a prompt-escaped display name back to its booru slug, for searching.
    /// <para><c>hammer \(sunset beach\)</c> becomes <c>hammer_(sunset_beach)</c>, which is the form the other
    /// datasets store and the form the client's matcher normalizes typed input into.</para></summary>
    public static string ToSlug(string name)
    {
        return name.Replace("\\", "").Replace(' ', '_').ToLowerFast();
    }
}
