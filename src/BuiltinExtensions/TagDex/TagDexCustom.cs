using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.Collections.Frozen;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;

namespace SwarmUI.Builtin_TagDexExtension;

/// <summary>One LoRA attached to a custom character.</summary>
/// <param name="Name">The LoRA's Swarm model name, eg "folder/aria_zzz". No <c>.safetensors</c> suffix.</param>
/// <param name="Weight">The LoRA weight, already clamped to <see cref="TagDexCustom.MaxWeight"/>.</param>
/// <param name="Tags">Extra tags that belong with this LoRA (its trigger words), comma-separated.</param>
public record class TagDexCustomLora(string Name, double Weight, string Tags);

/// <summary>One user-authored character.</summary>
/// <param name="Name">Display name, in the user's own casing.</param>
/// <param name="Series">Series or franchise, or empty.</param>
/// <param name="Tags">The character's own tags, comma-separated.</param>
/// <param name="Loras">Attached LoRAs, in the order they are inserted.</param>
public record class TagDexCustomCharacter(string Name, string Series, string Tags, List<TagDexCustomLora> Loras);

/// <summary>Store, validation and loader for the user's own characters (<c>Data/TagDex/custom_character.json</c>).
/// <para>A custom character is a card like any other TagDex dataset row - thumbnail, name, series, tag chips, star -
/// whose trigger is the user's own tags and whose core tags are each attached LoRA's <c>&lt;lora:...&gt;</c> tag
/// followed by that LoRA's own tags. Clicking the card therefore inserts exactly "my tags, LoRA tags" with no new
/// insertion path anywhere.</para>
/// <para>Custom rows carry no post count. Search and the typeahead index therefore ignore the count floor for this
/// source (see <see cref="TagDexFormat.Custom"/> handling in the search route and <c>TagDexIndexBlob.Build</c>).</para></summary>
public static class TagDexCustom
{
    /// <summary>The dataset ID of the custom characters.</summary>
    public const string SourceId = "custom_character";

    /// <summary>Longest accepted character name.</summary>
    public const int MaxNameLength = 100;

    /// <summary>Longest accepted series.</summary>
    public const int MaxSeriesLength = 200;

    /// <summary>Longest accepted character tag line.</summary>
    public const int MaxTagsLength = 4000;

    /// <summary>Most LoRAs one character may carry.</summary>
    public const int MaxLoras = 20;

    /// <summary>Longest accepted per-LoRA tag line.</summary>
    public const int MaxLoraTagsLength = 1000;

    /// <summary>Longest accepted LoRA name.</summary>
    public const int MaxLoraNameLength = 300;

    /// <summary>Largest absolute LoRA weight. Matches the fork's <c>LoraWeights</c> parameter cap.</summary>
    public const double MaxWeight = 2;

    /// <summary>Serializes writers and the read-modify-write cycle of the store file.</summary>
    public static readonly object StoreLock = new();

    /// <summary>Whitespace runs, collapsed to one underscore by <see cref="Slug"/>.</summary>
    public static readonly Regex WhitespaceRun = new(@"\s+", RegexOptions.Compiled);

    /// <summary>Line breaks inside a tag field, treated as commas by <see cref="NormalizeTags"/>.</summary>
    public static readonly Regex LineBreaks = new(@"[\r\n]+", RegexOptions.Compiled);

    /// <summary>Records of the last parse, by slug, so a search page can attach each record's raw fields without a
    /// disk read per row. Replaced wholesale on every parse.</summary>
    public static FrozenDictionary<string, TagDexCustomCharacter> ParsedBySlug = FrozenDictionary<string, TagDexCustomCharacter>.Empty;

    /// <summary>Full path to the store file.</summary>
    public static string StorePath => $"{TagDexData.FolderPath}/{TagDexData.SourceFor(SourceId).FileName}";

    /// <summary>Converts a display name to its stable slug: trimmed, lowercase, whitespace runs to <c>_</c>.</summary>
    public static string Slug(string name)
    {
        return WhitespaceRun.Replace((name ?? "").Trim().ToLowerFast(), "_");
    }

    /// <summary>Cleans a tag field: line breaks become commas, each tag is trimmed, empty tags are dropped, and
    /// the rest are joined with <c>", "</c>.</summary>
    public static string NormalizeTags(string tags)
    {
        if (string.IsNullOrWhiteSpace(tags))
        {
            return "";
        }
        return LineBreaks.Replace(tags, ",").Split(',').Select(t => t.Trim()).Where(t => t.Length > 0).JoinString(", ");
    }

    /// <summary>Clamps a LoRA weight into +/-<see cref="MaxWeight"/>. A non-finite weight becomes 1.</summary>
    public static double ClampWeight(double weight)
    {
        if (!double.IsFinite(weight))
        {
            return 1;
        }
        return Math.Clamp(weight, -MaxWeight, MaxWeight);
    }

    /// <summary>Formats a weight for a prompt tag: invariant culture, at most three decimals, no trailing zeros.</summary>
    public static string FormatWeight(double weight)
    {
        string text = Math.Round(weight, 3).ToString("0.###", CultureInfo.InvariantCulture);
        return text == "-0" ? "0" : text;
    }

    /// <summary>The prompt tag for one attached LoRA.</summary>
    public static string LoraTag(TagDexCustomLora lora)
    {
        return $"<lora:{lora.Name}:{FormatWeight(lora.Weight)}>";
    }

    /// <summary>Builds a card's core tags: for each LoRA in order its <c>&lt;lora:NAME:WEIGHT&gt;</c> tag, then its
    /// own tags. Empty string when there are no LoRAs.</summary>
    public static string CoreTagsFor(TagDexCustomCharacter record)
    {
        List<string> parts = [];
        foreach (TagDexCustomLora lora in record.Loras)
        {
            parts.Add(LoraTag(lora));
            string tags = NormalizeTags(lora.Tags);
            if (tags.Length > 0)
            {
                parts.Add(tags);
            }
        }
        return parts.JoinString(", ");
    }

    /// <summary>Returns a trimmed, normalized copy of a record, ready to validate and store.</summary>
    public static TagDexCustomCharacter Clean(TagDexCustomCharacter record)
    {
        List<TagDexCustomLora> loras = [];
        foreach (TagDexCustomLora lora in record.Loras ?? [])
        {
            string name = (lora.Name ?? "").Trim();
            if (name.EndsWith(".safetensors", StringComparison.OrdinalIgnoreCase))
            {
                name = name[..^".safetensors".Length];
            }
            loras.Add(new(name, ClampWeight(lora.Weight), NormalizeTags(lora.Tags)));
        }
        return new(WhitespaceRun.Replace((record.Name ?? "").Trim(), " "), (record.Series ?? "").Trim(), NormalizeTags(record.Tags), loras);
    }

    /// <summary>Validates a cleaned record. Returns a user-facing message, or null when it is acceptable.
    /// <paramref name="originalSlug"/> is the slug of the record being edited (empty when creating): it is the one
    /// record allowed to share the new slug.</summary>
    public static string Validate(TagDexCustomCharacter record, string originalSlug, IEnumerable<TagDexCustomCharacter> existing)
    {
        if (string.IsNullOrWhiteSpace(record.Name))
        {
            return "A name is required.";
        }
        if (record.Name.Length > MaxNameLength)
        {
            return $"The name is too long (limit {MaxNameLength} characters).";
        }
        string slug = Slug(record.Name);
        string original = Slug(originalSlug);
        foreach (TagDexCustomCharacter other in existing)
        {
            string otherSlug = Slug(other.Name);
            if (otherSlug == slug && otherSlug != original)
            {
                return $"A character named '{other.Name}' already exists.";
            }
        }
        if (record.Series.Length > MaxSeriesLength)
        {
            return $"The series is too long (limit {MaxSeriesLength} characters).";
        }
        if (record.Tags.Length > MaxTagsLength)
        {
            return $"The tags are too long (limit {MaxTagsLength} characters).";
        }
        if (record.Loras.Count > MaxLoras)
        {
            return $"Too many LoRAs (limit {MaxLoras}).";
        }
        foreach (TagDexCustomLora lora in record.Loras)
        {
            if (string.IsNullOrWhiteSpace(lora.Name))
            {
                return "Every LoRA needs a name.";
            }
            if (lora.Name.Length > MaxLoraNameLength || lora.Name.IndexOfAny(['<', '>', ',']) >= 0)
            {
                return $"'{lora.Name}' is not a valid LoRA name (no '<', '>' or ',', at most {MaxLoraNameLength} characters).";
            }
            if (lora.Tags.Length > MaxLoraTagsLength)
            {
                return $"The tags for '{lora.Name}' are too long (limit {MaxLoraTagsLength} characters).";
            }
        }
        return null;
    }

    /// <summary>Maps a record to a dataset row. <see cref="TagDexEntry.Name"/> is the slug; the trigger is the user's
    /// tags (or the humanized, paren-escaped name when there are none); core tags are the LoRA tags; the count is 0.</summary>
    public static TagDexEntry ToEntry(TagDexCustomCharacter record)
    {
        string slug = Slug(record.Name);
        string tags = NormalizeTags(record.Tags);
        string coreTags = CoreTagsFor(record);
        TagDexEntry entry = new()
        {
            Name = slug,
            Trigger = tags.Length > 0 ? tags : TagDexPromptTags.EscapeParens(TagDexNames.Humanize(slug)),
            Copyright = string.IsNullOrWhiteSpace(record.Series) ? null : record.Series.Trim(),
            CoreTags = coreTags.Length > 0 ? coreTags : null,
            Count = 0
        };
        // Facets are read from the user's tags too, so a "1girl, blue eyes" character answers the gender and eye
        // filters even with no LoRA attached.
        string facetSource = $"{tags}, {coreTags}";
        TagDexData.ApplyFacets(ref entry, facetSource);
        return entry;
    }

    /// <summary>Reads a record from its stored (or API) JSON shape. Missing or malformed fields become empty.</summary>
    public static TagDexCustomCharacter FromJson(JObject data)
    {
        List<TagDexCustomLora> loras = [];
        if (data["loras"] is JArray array)
        {
            foreach (JToken token in array)
            {
                if (token is not JObject row)
                {
                    continue;
                }
                double weight = 1;
                if (row["weight"] is JToken weightToken && !double.TryParse($"{weightToken}", NumberStyles.Float, CultureInfo.InvariantCulture, out weight))
                {
                    weight = 1;
                }
                loras.Add(new($"{row["name"]}", weight, $"{row["tags"]}"));
            }
        }
        return new($"{data["name"]}", $"{data["series"]}", $"{data["tags"]}", loras);
    }

    /// <summary>Serializes a record to its stored JSON shape. Also the <c>custom</c> object sent to the editor.</summary>
    public static JObject ToJson(TagDexCustomCharacter record)
    {
        return new JObject()
        {
            ["name"] = record.Name,
            ["series"] = record.Series,
            ["tags"] = record.Tags,
            ["loras"] = new JArray(record.Loras.Select(l => new JObject() { ["name"] = l.Name, ["weight"] = l.Weight, ["tags"] = l.Tags }))
        };
    }

    /// <summary>Reads every stored record from a store file. A missing file is an empty store.</summary>
    public static List<TagDexCustomCharacter> ReadStore(string path)
    {
        List<TagDexCustomCharacter> records = [];
        if (!File.Exists(path))
        {
            return records;
        }
        JObject root = JObject.Parse(File.ReadAllText(path));
        if (root["characters"] is JArray array)
        {
            foreach (JToken token in array)
            {
                if (token is JObject row)
                {
                    records.Add(Clean(FromJson(row)));
                }
            }
        }
        return records;
    }

    /// <summary>Writes a store file atomically (temp file, then replace).</summary>
    public static void WriteStore(string path, List<TagDexCustomCharacter> records)
    {
        JObject root = new() { ["characters"] = new JArray(records.Select(ToJson)) };
        TagDexExtension.WriteAtomic(path, Encoding.UTF8.GetBytes(root.ToString(Formatting.Indented)));
    }

    /// <summary>Looks up a record from the last parse by slug, or null.</summary>
    public static TagDexCustomCharacter RecordFor(string slug)
    {
        return ParsedBySlug.GetValueOrDefault(slug);
    }

    /// <summary>Parses the store into a loaded list. <paramref name="minCount"/> is ignored: custom rows have no
    /// post count. Sorted by name, since there is no popularity to order by.</summary>
    public static TagDexList Parse(TagDexSource source, int minCount)
    {
        string path = TagDexData.PathFor(source);
        long startTicks = Environment.TickCount64;
        try
        {
            // Under the store lock so a parse cannot catch a writer between its delete and its move.
            List<TagDexCustomCharacter> records;
            lock (StoreLock)
            {
                records = ReadStore(path);
            }
            Dictionary<string, TagDexCustomCharacter> bySlug = [];
            Dictionary<string, string> copyrightPool = new(StringComparer.OrdinalIgnoreCase);
            Dictionary<string, int> copyrightCounts = new(StringComparer.OrdinalIgnoreCase);
            List<TagDexEntry> entries = [];
            foreach (TagDexCustomCharacter record in records)
            {
                string slug = Slug(record.Name);
                if (slug.Length == 0 || !bySlug.TryAdd(slug, record))
                {
                    Logs.Warning($"[TagDex] Skipping custom character '{record.Name}': empty or duplicate name.");
                    continue;
                }
                TagDexEntry entry = ToEntry(record);
                if (entry.Copyright is not null)
                {
                    // Pooled so two spellings of one series that differ only by case share one folder and one filter value.
                    if (!copyrightPool.TryGetValue(entry.Copyright, out string pooled))
                    {
                        pooled = entry.Copyright;
                        copyrightPool[pooled] = pooled;
                    }
                    entry.Copyright = pooled;
                    copyrightCounts[pooled] = copyrightCounts.GetValueOrDefault(pooled, 0) + 1;
                }
                entries.Add(entry);
            }
            TagDexEntry[] sorted = [.. entries];
            Array.Sort(sorted, (a, b) => string.CompareOrdinal(a.Name, b.Name));
            string[] names = new string[sorted.Length];
            Dictionary<string, int> byName = new(sorted.Length);
            for (int i = 0; i < sorted.Length; i++)
            {
                names[i] = sorted[i].Name;
                byName[sorted[i].Name] = i;
            }
            (string, int)[] copyrights = [.. copyrightCounts.Select(pair => (pair.Key, pair.Value))];
            Array.Sort(copyrights, (a, b) => b.Item2.CompareTo(a.Item2));
            TagDexList list = new()
            {
                Source = source,
                Entries = sorted,
                Names = names,
                ByName = byName.ToFrozenDictionary(),
                Copyrights = copyrights,
                TotalRowsInFile = records.Count,
                LoadedMinCount = 0,
                ApproxBytes = TagDexData.EstimateBytes(sorted)
            };
            try
            {
                list.FileModifiedUtc = new FileInfo(path).LastWriteTimeUtc.Ticks;
            }
            catch (Exception)
            {
                list.FileModifiedUtc = 0;
            }
            ParsedBySlug = bySlug.ToFrozenDictionary();
            Logs.Init($"[TagDex] Loaded '{source.ID}': {sorted.Length:N0} custom characters in {Environment.TickCount64 - startTicks} ms.");
            return list;
        }
        catch (Exception ex)
        {
            Logs.Error($"[TagDex] Failed to parse '{source.ID}': {ex.ReadableString()}");
            return null;
        }
    }

    /// <summary>Thumbnail file extensions probed and cleaned for one character.</summary>
    public static readonly string[] ThumbExtensions = [".jpg", ".webp", ".png"];

    /// <summary>Moves a character's thumbnail (and archived original) to a new slug's stem after a rename.
    /// Best effort: a failure leaves the card on the placeholder rather than failing the save.</summary>
    public static void MoveThumbs(string oldSlug, string newSlug)
    {
        string oldStem = TagDexNames.SafeFileName(oldSlug);
        string newStem = TagDexNames.SafeFileName(newSlug);
        if (oldStem == newStem)
        {
            return;
        }
        try
        {
            string root = $"{TagDexData.ThumbsPath}/{SourceId}";
            foreach (string ext in ThumbExtensions)
            {
                if (File.Exists($"{root}/{oldStem}{ext}"))
                {
                    File.Move($"{root}/{oldStem}{ext}", $"{root}/{newStem}{ext}", true);
                }
            }
            string origRoot = $"{TagDexLocal.OriginalsPath}/{SourceId}";
            if (File.Exists($"{origRoot}/{oldStem}.png"))
            {
                File.Move($"{origRoot}/{oldStem}.png", $"{origRoot}/{newStem}.png", true);
            }
        }
        catch (Exception ex)
        {
            Logs.Debug($"[TagDex] Could not move thumbnail for renamed character '{oldSlug}': {ex.ReadableString()}");
        }
    }

    /// <summary>Deletes a character's thumbnail files and archived original. Best effort.</summary>
    public static void DeleteThumbs(string slug)
    {
        string stem = TagDexNames.SafeFileName(slug);
        try
        {
            string root = $"{TagDexData.ThumbsPath}/{SourceId}";
            foreach (string ext in ThumbExtensions)
            {
                if (File.Exists($"{root}/{stem}{ext}"))
                {
                    File.Delete($"{root}/{stem}{ext}");
                }
            }
            string original = $"{TagDexLocal.OriginalsPath}/{SourceId}/{stem}.png";
            if (File.Exists(original))
            {
                File.Delete(original);
            }
        }
        catch (Exception ex)
        {
            Logs.Debug($"[TagDex] Could not delete thumbnail for '{slug}': {ex.ReadableString()}");
        }
    }

    /// <summary>Creates or replaces one record. Returns the saved record's slug, or an error message.
    /// <para>Favorites are per-user and live in each user's own data, so a rename cannot migrate everyone's
    /// stars here; the API route migrates the saving user's.</para></summary>
    public static (string Slug, string Error) Save(string originalSlug, TagDexCustomCharacter incoming)
    {
        TagDexCustomCharacter record = Clean(incoming);
        string slug = Slug(record.Name);
        string original = Slug(originalSlug);
        lock (StoreLock)
        {
            List<TagDexCustomCharacter> store = ReadStore(StorePath);
            string error = Validate(record, original, store);
            if (error is not null)
            {
                return (null, error);
            }
            if (original.Length > 0)
            {
                int index = store.FindIndex(r => Slug(r.Name) == original);
                if (index < 0)
                {
                    return (null, $"No character named '{originalSlug}' to edit.");
                }
                store[index] = record;
            }
            else
            {
                store.Add(record);
            }
            WriteStore(StorePath, store);
            if (original.Length > 0 && original != slug)
            {
                MoveThumbs(original, slug);
            }
        }
        TagDexData.Reload(SourceId);
        TagDexData.InvalidateThumbs(SourceId);
        return (slug, null);
    }

    /// <summary>Removes one record and its thumbnail. Returns false when no such record exists.</summary>
    public static bool Delete(string slug)
    {
        string target = Slug(slug);
        lock (StoreLock)
        {
            List<TagDexCustomCharacter> store = ReadStore(StorePath);
            if (store.RemoveAll(r => Slug(r.Name) == target) == 0)
            {
                return false;
            }
            WriteStore(StorePath, store);
            DeleteThumbs(target);
        }
        TagDexData.Reload(SourceId);
        TagDexData.InvalidateThumbs(SourceId);
        return true;
    }
}

public partial class TagDexExtension
{
    /// <summary>API route: creates or edits one custom character.</summary>
    [API.APIDescription("Creates or edits one of the user's own TagDex characters (tags plus optional attached LoRAs).", "\"success\": true, \"name\": \"aria\"")]
    public async Task<JObject> TagDexSaveCustomCharacter(Session session,
        [API.APIParameter("The full request payload: `original` (slug being edited, empty to create), `name`, `series`, `tags`, and `loras` (array of name/weight/tags).")] JObject raw)
    {
        // A JObject API parameter is bound to the WHOLE request payload minus session_id, not to a field named
        // 'raw', so every field is read straight off it.
        string original = $"{raw["original"]}".Trim();
        (string slug, string error) = TagDexCustom.Save(original, TagDexCustom.FromJson(raw));
        if (error is not null)
        {
            return new JObject() { ["error"] = error };
        }
        string originalSlug = TagDexCustom.Slug(original);
        if (originalSlug.Length == 0)
        {
            // A new character starts favorited so it shows under the Characters tab's favorites filter.
            TagDexFavorites.Set(session, TagDexCustom.SourceId, slug, true);
        }
        else if (originalSlug != slug && TagDexFavorites.Set(session, TagDexCustom.SourceId, originalSlug, false))
        {
            // Carry the saving user's star across a rename. Other users' stars on the old name are left behind.
            TagDexFavorites.Set(session, TagDexCustom.SourceId, slug, true);
        }
        return new JObject() { ["success"] = true, ["name"] = slug };
    }

    /// <summary>API route: deletes one custom character and its reference image.</summary>
    [API.APIDescription("Deletes one of the user's own TagDex characters.", "\"success\": true")]
    public async Task<JObject> TagDexDeleteCustomCharacter(Session session,
        [API.APIParameter("Slug of the character to delete.")] string name)
    {
        if (!TagDexCustom.Delete(name))
        {
            return new JObject() { ["error"] = $"No character named '{name}'." };
        }
        TagDexFavorites.Set(session, TagDexCustom.SourceId, TagDexCustom.Slug(name), false);
        return new JObject() { ["success"] = true };
    }
}
