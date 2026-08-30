using FreneticUtilities.FreneticExtensions;
using SwarmUI.Core;
using SwarmUI.Utils;
using System.Collections.Frozen;
using System.IO;

namespace SwarmUI.Builtin_TagDexExtension;

/// <summary>How a dataset's metadata file is encoded.</summary>
public enum TagDexFormat
{
    /// <summary>A noob-wiki style CSV.</summary>
    Csv,
    /// <summary>The anima-styles gallery's <c>data.js</c>: a single <c>const galleryData = [...]</c> JSON array.</summary>
    AnimaStyles
}

/// <summary>Static description of one dataset.</summary>
/// <param name="ID">Stable identifier, also the metadata filename stem, eg "danbooru_character".</param>
/// <param name="Kind">Whether this dataset holds characters or artists.</param>
/// <param name="Label">Human-readable name for the UI.</param>
/// <param name="Url">Direct download URL, or null for datasets the user supplies locally.</param>
/// <param name="PostUrlPrefix">Prefix used to rebuild a row's booru link, which is not stored per-row.</param>
/// <param name="Format">How the metadata file is encoded.</param>
public record class TagDexSource(string ID, TagDexKind Kind, string Label, string Url, string PostUrlPrefix, TagDexFormat Format = TagDexFormat.Csv)
{
    /// <summary>The metadata filename this dataset loads from.</summary>
    public string FileName => Format == TagDexFormat.AnimaStyles ? $"{ID}.js" : $"{ID}.csv";

    /// <summary>Whether this dataset can be fetched by the in-app downloader.</summary>
    public bool IsDownloadable => Url is not null;
}

/// <summary>One loaded dataset: the entries, the flat scan array, and the rollups the UI needs.</summary>
public class TagDexList
{
    /// <summary>The source this was loaded from.</summary>
    public TagDexSource Source;

    /// <summary>All retained entries, pre-sorted by <see cref="TagDexEntry.Count"/> descending.
    /// <para>Sorting once at load makes the common "most popular first" query free and turns paging into a slice.
    /// It also means an early-terminated scan yields the most popular matches rather than an arbitrary subset.</para></summary>
    public TagDexEntry[] Entries = [];

    /// <summary>Index-parallel copy of every entry's <see cref="TagDexEntry.Name"/>.
    /// <para>Duplicated deliberately: the substring scan walks 8-byte reference strides here instead of 48-byte
    /// struct strides through <see cref="Entries"/>. Costs ~2 MB, saves most of the scan's memory traffic.</para></summary>
    public string[] Names = [];

    /// <summary>Exact-name lookup to an index into <see cref="Entries"/>.</summary>
    public FrozenDictionary<string, int> ByName = FrozenDictionary<string, int>.Empty;

    /// <summary>Copyright values with their entry counts, sorted descending. Empty for artist datasets.</summary>
    public (string Name, int Count)[] Copyrights = [];

    /// <summary>How many rows the CSV actually contained, before the minimum-count filter.</summary>
    public int TotalRowsInFile;

    /// <summary>The minimum-count floor this list was loaded with.</summary>
    public int LoadedMinCount;

    /// <summary>Rough retained size in bytes, for reporting to the UI.</summary>
    public long ApproxBytes;

    /// <summary>Last-write timestamp of the source file when it was loaded, for staleness detection.</summary>
    public long FileModifiedUtc;

    /// <summary>Rebuilds the booru link for an entry, which is not stored per-row.</summary>
    public string UrlFor(in TagDexEntry entry)
    {
        return $"{Source.PostUrlPrefix}{Uri.EscapeDataString(entry.Name)}";
    }
}

/// <summary>Owns the loaded tag datasets.
/// <para>Structurally modelled on <see cref="SwarmUI.Utils.AutoCompleteListHelper"/>, with two deliberate departures.
/// It does not hook <c>Program.ModelRefreshEvent</c> - a model refresh has nothing to do with these CSVs, so
/// staleness is reported by re-stat and fixed by an explicit reload route. And it streams rather than calling
/// <c>File.ReadAllText</c>: a 38.7 MB CSV would become a ~77 MB UTF-16 string allocated straight onto the large
/// object heap, which is not compacted by default, producing durable fragmentation for a transient value.</para></summary>
public static class TagDexData
{
    /// <summary>Every dataset this extension knows how to load or download.</summary>
    public static readonly TagDexSource[] Sources =
    [
        new("danbooru_character", TagDexKind.Character, "Danbooru Characters",
            "https://huggingface.co/datasets/Laxhar/noob-wiki/resolve/main/danbooru_character.csv",
            "https://danbooru.donmai.us/posts?tags="),
        new("danbooru_artist", TagDexKind.Artist, "Danbooru Artists",
            "https://huggingface.co/datasets/Laxhar/noob-wiki/resolve/main/danbooru_artist.csv",
            "https://danbooru.donmai.us/posts?tags="),
        new("e621_character", TagDexKind.Character, "e621 Characters",
            "https://huggingface.co/datasets/Laxhar/noob-wiki/resolve/main/e621_character.csv",
            "https://e621.net/posts?tags="),
        new("e621_artist", TagDexKind.Artist, "e621 Artists",
            "https://huggingface.co/datasets/Laxhar/noob-wiki/resolve/main/e621_artist.csv",
            "https://e621.net/posts?tags="),
        // Locally supplied, not downloadable: the anima-styles gallery export. A curated artist set (42,509 entries,
        // post_count >= 45) that ships a 512x768 style reference for every single row, plus uniqueness and quality
        // scores the raw CSV has no equivalent for. 97.4% of it cross-references danbooru_artist.
        new("anima_styles", TagDexKind.Artist, "Anima Styles (local)", null,
            "https://danbooru.donmai.us/posts?tags=", TagDexFormat.AnimaStyles)
    ];

    /// <summary>Booru meta tags that masquerade as artists. Left in place they dominate any count-sorted artist
    /// list - <c>conditional_dnp</c> alone reports 147,138 posts - and the browser opens on three rows that are not
    /// artists at all.</summary>
    public static readonly FrozenSet<string> ArtistDenyList = new HashSet<string>()
    {
        "banned_artist", "conditional_dnp", "avoid_posting", "sound_warning", "epilepsy_warning",
        "unknown_artist", "anonymous_artist", "artist_request", "third-party_edit", "screencap"
    }.ToFrozenSet();

    /// <summary>Currently loaded lists, keyed by source ID.</summary>
    public static ConcurrentDictionary<string, TagDexList> Loaded = new();

    /// <summary>Per-source load gate, so two simultaneous first-hits do not both parse the same 38 MB file.</summary>
    public static ConcurrentDictionary<string, SemaphoreSlim> LoadGates = new();

    /// <summary>The folder holding the CSVs and generated thumbnails.</summary>
    public static string FolderPath;

    /// <summary>The subfolder holding generated and imported thumbnails.</summary>
    public static string ThumbsPath;

    /// <summary>Process-wide floor on which rows are retained in memory. Cannot be per-user - the index is shared, so
    /// two users with different floors cannot each own a copy. The per-user equivalent is a display filter applied
    /// inside the scan, which is free because it is already the first test in the loop.</summary>
    public static int ResidentMinCount = 20;

    /// <summary>Cached set of thumbnail filenames present on disk, keyed by source ID.
    /// <para>Without this, describing a 100-result page costs 300 File.Exists syscalls (three extensions per row).
    /// The directory is listed once and invalidated whenever the extension writes to it.</para></summary>
    public static ConcurrentDictionary<string, FrozenSet<string>> ThumbIndex = new();

    /// <summary>Returns the set of thumbnail filenames present for a source, listing the directory on first use.</summary>
    public static FrozenSet<string> ThumbsFor(string sourceId)
    {
        return ThumbIndex.GetOrCreate(sourceId, () =>
        {
            try
            {
                string root = $"{ThumbsPath}/{sourceId}";
                if (!Directory.Exists(root))
                {
                    return FrozenSet<string>.Empty;
                }
                // Recursive, with forward-slashed relative paths: the anima-styles export shards its images
                // 1,000 per folder, so a flat listing would find nothing.
                return Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
                    .Select(f => Path.GetRelativePath(root, f).Replace('\\', '/'))
                    .ToFrozenSet(StringComparer.OrdinalIgnoreCase);
            }
            catch (Exception ex)
            {
                Logs.Debug($"[TagDex] Could not list thumbnails for '{sourceId}': {ex.ReadableString()}");
                return FrozenSet<string>.Empty;
            }
        });
    }

    /// <summary>Drops the cached thumbnail listing for a source, after writing to it.</summary>
    public static void InvalidateThumbs(string sourceId)
    {
        ThumbIndex.TryRemove(sourceId, out _);
    }

    /// <summary>Prepares the folder layout. Cheap by design - this only creates directories, it does not parse
    /// anything, so it is safe to call during extension init on the launch-critical path.</summary>
    public static void Init()
    {
        FolderPath = $"{Program.DataDir}/TagDex";
        ThumbsPath = $"{FolderPath}/thumbs";
        try
        {
            Directory.CreateDirectory(FolderPath);
            Directory.CreateDirectory(ThumbsPath);
            Directory.CreateDirectory($"{FolderPath}/imported");
        }
        catch (Exception ex)
        {
            Logs.Error($"[TagDex] Could not prepare data folder '{FolderPath}': {ex.ReadableString()}");
        }
    }

    /// <summary>Looks up a source by ID, or null if unknown.</summary>
    public static TagDexSource SourceFor(string id)
    {
        foreach (TagDexSource source in Sources)
        {
            if (source.ID == id)
            {
                return source;
            }
        }
        return null;
    }

    /// <summary>Full path to a source's CSV on disk.</summary>
    public static string PathFor(TagDexSource source)
    {
        return $"{FolderPath}/{source.FileName}";
    }

    /// <summary>Whether a source's CSV is present on disk.</summary>
    public static bool IsPresent(TagDexSource source)
    {
        return File.Exists(PathFor(source));
    }

    /// <summary>Returns the loaded list for a source, parsing it first if needed. Null when the CSV is absent.
    /// <para>Single-flight per source: the first caller parses, everyone else waits on the same gate rather than
    /// starting a duplicate parse of the same file.</para></summary>
    public static TagDexList EnsureLoaded(string sourceId)
    {
        TagDexSource source = SourceFor(sourceId);
        if (source is null || !IsPresent(source))
        {
            return null;
        }
        if (Loaded.TryGetValue(sourceId, out TagDexList existing))
        {
            return existing;
        }
        SemaphoreSlim gate = LoadGates.GetOrCreate(sourceId, () => new SemaphoreSlim(1, 1));
        gate.Wait();
        try
        {
            if (Loaded.TryGetValue(sourceId, out existing))
            {
                return existing;
            }
            TagDexList list = Parse(source, ResidentMinCount);
            if (list is not null)
            {
                Loaded[sourceId] = list;
            }
            return list;
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>Drops a loaded list, freeing its memory, along with any typeahead index blobs built from it.
    /// <para>The blob cache is keyed by the list's fingerprint, so a re-parsed list can never read a stale blob -
    /// but without this the old fingerprint's blob would sit in memory for the life of the process, one more per
    /// reload or re-download.</para></summary>
    public static void Unload(string sourceId)
    {
        Loaded.TryRemove(sourceId, out _);
        TagDexIndexBlob.Evict(sourceId);
    }

    /// <summary>Drops and re-parses a list.</summary>
    public static TagDexList Reload(string sourceId)
    {
        Unload(sourceId);
        return EnsureLoaded(sourceId);
    }

    /// <summary>Whether a loaded list is older than its file on disk.</summary>
    public static bool IsStale(TagDexSource source)
    {
        if (!Loaded.TryGetValue(source.ID, out TagDexList list))
        {
            return false;
        }
        try
        {
            return new FileInfo(PathFor(source)).LastWriteTimeUtc.Ticks != list.FileModifiedUtc;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>Parses one CSV off disk into a loaded list.
    /// <para>Streams line by line. Rows below <paramref name="minCount"/> are parsed but not retained - the filter is
    /// on a parsed field, so it reduces retained memory, not read time.</para></summary>
    public static TagDexList Parse(TagDexSource source, int minCount)
    {
        if (source.Format == TagDexFormat.AnimaStyles)
        {
            return TagDexAnimaStyles.Parse(source, minCount);
        }
        string path = PathFor(source);
        long startTicks = Environment.TickCount64;
        try
        {
            using FileStream stream = File.OpenRead(path);
            using StreamReader reader = new(stream, Encoding.UTF8);
            StringBuilder buffer = new(128);
            Dictionary<string, int> header = TagDexCsv.ReadHeader(reader, buffer);
            if (header is null)
            {
                Logs.Error($"[TagDex] Dataset '{source.ID}' is empty.");
                return null;
            }
            int colName = header.GetValueOrDefault(source.Kind == TagDexKind.Character ? "character" : "artist", -1);
            int colTrigger = header.GetValueOrDefault("trigger", -1);
            int colCopyright = header.GetValueOrDefault("copyright", -1);
            int colCoreTags = header.GetValueOrDefault("core_tags", -1);
            int colCount = header.GetValueOrDefault("count", -1);
            int colSolo = header.GetValueOrDefault("solo_count", -1);
            if (colName < 0)
            {
                Logs.Error($"[TagDex] Dataset '{source.ID}' has no '{(source.Kind == TagDexKind.Character ? "character" : "artist")}' column. Header was: {header.Keys.JoinString(", ")}");
                return null;
            }
            int widest = Math.Max(Math.Max(colName, colTrigger), Math.Max(Math.Max(colCopyright, colCoreTags), Math.Max(colCount, colSolo)));
            string[] fields = new string[widest + 2];
            Dictionary<string, string> copyrightPool = [];
            Dictionary<string, int> copyrightCounts = [];
            List<TagDexEntry> entries = new(minCount > 100 ? 32768 : 262144);
            bool isArtist = source.Kind == TagDexKind.Artist;
            int total = 0;
            string line;
            while ((line = reader.ReadLine()) is not null)
            {
                if (line.Length == 0)
                {
                    continue;
                }
                total++;
                Array.Clear(fields);
                TagDexCsv.SplitLine(line, fields, buffer);
                string name = fields[colName];
                if (string.IsNullOrWhiteSpace(name))
                {
                    continue;
                }
                int count = 0;
                if (colCount >= 0)
                {
                    int.TryParse(fields[colCount], out count);
                }
                if (count < minCount)
                {
                    continue;
                }
                if (isArtist && ArtistDenyList.Contains(name))
                {
                    continue;
                }
                TagDexEntry entry = new()
                {
                    Name = name,
                    Count = count
                };
                string trigger = colTrigger >= 0 ? fields[colTrigger] : null;
                entry.Trigger = string.IsNullOrWhiteSpace(trigger) ? TagDexNames.Humanize(name) : trigger;
                if (colSolo >= 0)
                {
                    int.TryParse(fields[colSolo], out int solo);
                    entry.SoloCount = solo;
                }
                if (colCopyright >= 0)
                {
                    string copyright = fields[colCopyright];
                    if (!string.IsNullOrWhiteSpace(copyright))
                    {
                        // Pooled through a local dictionary rather than string.Intern - interning pins values into the
                        // runtime's intern table for the life of the process, so an unloaded dataset could never
                        // actually release them.
                        if (copyrightPool.TryGetValue(copyright, out string pooled))
                        {
                            copyright = pooled;
                        }
                        else
                        {
                            copyrightPool[copyright] = copyright;
                        }
                        entry.Copyright = copyright;
                        copyrightCounts[copyright] = copyrightCounts.GetValueOrDefault(copyright, 0) + 1;
                    }
                }
                if (colCoreTags >= 0)
                {
                    string coreTags = fields[colCoreTags];
                    if (!string.IsNullOrWhiteSpace(coreTags))
                    {
                        entry.CoreTags = coreTags;
                        ApplyFacets(ref entry, coreTags);
                    }
                }
                entries.Add(entry);
            }
            TagDexList list = new()
            {
                Source = source,
                TotalRowsInFile = total,
                LoadedMinCount = minCount
            };
            TagDexEntry[] array = [.. entries];
            Array.Sort(array, (a, b) => b.Count.CompareTo(a.Count));
            list.Entries = array;
            string[] names = new string[array.Length];
            Dictionary<string, int> byName = new(array.Length);
            for (int i = 0; i < array.Length; i++)
            {
                names[i] = array[i].Name;
                byName[array[i].Name] = i;
            }
            list.Names = names;
            list.ByName = byName.ToFrozenDictionary();
            (string, int)[] copyrights = [.. copyrightCounts.Select(pair => (pair.Key, pair.Value))];
            Array.Sort(copyrights, (a, b) => b.Item2.CompareTo(a.Item2));
            list.Copyrights = copyrights;
            list.ApproxBytes = EstimateBytes(array);
            try
            {
                list.FileModifiedUtc = new FileInfo(path).LastWriteTimeUtc.Ticks;
            }
            catch (Exception)
            {
                list.FileModifiedUtc = 0;
            }
            Logs.Init($"[TagDex] Loaded '{source.ID}': {array.Length:N0} of {total:N0} rows (min count {minCount}), "
                + $"{list.Copyrights.Length:N0} copyrights, ~{list.ApproxBytes / (1024 * 1024)} MB, in {Environment.TickCount64 - startTicks} ms.");
            return list;
        }
        catch (Exception ex)
        {
            Logs.Error($"[TagDex] Failed to parse dataset '{source.ID}': {ex.ReadableString()}");
            return null;
        }
    }

    /// <summary>Classifies a raw comma-separated core tag string into the entry's facet bitmasks.</summary>
    public static void ApplyFacets(ref TagDexEntry entry, string coreTags)
    {
        int start = 0;
        while (start < coreTags.Length)
        {
            int comma = coreTags.IndexOf(',', start);
            int end = comma < 0 ? coreTags.Length : comma;
            ReadOnlySpan<char> span = coreTags.AsSpan(start, end - start).Trim();
            if (span.Length > 0)
            {
                // Materialized rather than looked up as a span: FrozenDictionary's alternate-lookup API is .NET 9,
                // and this project targets net8.0. Parse-time only, so the transient Gen0 cost is irrelevant.
                if (TagDexVocab.Lookup.TryGetValue(span.ToString(), out (TagDexFacet Facet, int Bit) hit))
                {
                    switch (hit.Facet)
                    {
                        case TagDexFacet.HairColor:
                            entry.HairColors |= 1u << hit.Bit;
                            break;
                        case TagDexFacet.HairLength:
                            entry.HairLengths |= (byte)(1 << hit.Bit);
                            break;
                        case TagDexFacet.EyeColor:
                            entry.EyeColors |= (ushort)(1 << hit.Bit);
                            break;
                        case TagDexFacet.Gender:
                            entry.Genders |= (byte)(1 << hit.Bit);
                            break;
                    }
                }
            }
            if (comma < 0)
            {
                break;
            }
            start = comma + 1;
        }
    }

    /// <summary>Rough retained-size estimate, for reporting. A .NET x64 string costs 22 bytes of overhead plus two
    /// bytes per character, rounded up to an 8-byte boundary.</summary>
    public static long EstimateBytes(TagDexEntry[] entries)
    {
        long total = entries.Length * 48L;
        HashSet<string> seenCopyright = [];
        foreach (TagDexEntry entry in entries)
        {
            total += StringBytes(entry.Name) + StringBytes(entry.Trigger) + StringBytes(entry.CoreTags);
            if (entry.Copyright is not null && seenCopyright.Add(entry.Copyright))
            {
                total += StringBytes(entry.Copyright);
            }
            total += 8;
        }
        return total;
    }

    /// <summary>Estimated heap cost of one string.</summary>
    public static long StringBytes(string value)
    {
        if (value is null)
        {
            return 0;
        }
        return (22 + value.Length * 2 + 7) & ~7L;
    }
}
