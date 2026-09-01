using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.IO;
using System.Net.WebSockets;

namespace SwarmUI.Builtin_TagDexExtension;

/// <summary>Per-user TagDex preferences.
/// <para>Stored as one JSON blob in the user's generic data rather than a key per setting: extensions cannot extend
/// <c>Settings.User</c>, and one blob means one read, one write, and no migration when a field is added.</para></summary>
public class TagDexPrefs
{
    /// <summary>Default floor for the pushed typeahead index. 15,034 danbooru characters clear a count of 100, which
    /// is a few hundred kilobytes gzipped - small enough to push, large enough to cover anything a model reliably knows.</summary>
    public const int DefaultLeanMinCount = 100;

    /// <summary>Which datasets feed the typeahead, in priority order.</summary>
    public string[] ActiveSources = ["danbooru_character"];

    /// <summary>Floor on post count for rows shown in search results. Applied inside the scan, so it costs nothing.</summary>
    public int DisplayMinCount = 20;

    /// <summary>Floor on post count for the pushed typeahead index.</summary>
    public int LeanMinCount = DefaultLeanMinCount;

    /// <summary>Whether character suggestions appear while typing in a prompt box.</summary>
    public bool TypeaheadEnabled = true;

    /// <summary>How many character suggestions may be mixed in when the user's own tag list also has matches.</summary>
    public int QuotaWithList = 8;

    /// <summary>How many character suggestions may show when the user has no tag list of their own.</summary>
    public int QuotaAlone = 25;

    /// <summary>Appended to the prompt when generating a reference thumbnail. Keeps references comparable to each
    /// other by pinning the framing, so the only thing varying between cards is the character or style itself.</summary>
    public string ThumbPromptSuffix = "solo, upper body, simple background, white background";

    /// <summary>Serializes to JSON for storage.</summary>
    public JObject ToJson()
    {
        return new JObject()
        {
            ["active_sources"] = new JArray(ActiveSources),
            ["display_min_count"] = DisplayMinCount,
            ["lean_min_count"] = LeanMinCount,
            ["typeahead_enabled"] = TypeaheadEnabled,
            ["quota_with_list"] = QuotaWithList,
            ["quota_alone"] = QuotaAlone,
            ["thumb_prompt_suffix"] = ThumbPromptSuffix
        };
    }

    /// <summary>Reads prefs for a user, falling back to defaults when unset or corrupt.</summary>
    public static TagDexPrefs For(Session session)
    {
        TagDexPrefs prefs = new();
        try
        {
            string raw = session.User.GetGenericData("tagdex", "prefs");
            if (string.IsNullOrWhiteSpace(raw))
            {
                return prefs;
            }
            JObject data = raw.ParseToJson();
            // An empty array is honored, not treated as unset: the manage drawer's per-dataset Typeahead
            // checkboxes can legitimately all be off, and TryGetValue already separates that from an absent or
            // corrupt key (which still falls through to the default below).
            if (data.TryGetValue("active_sources", out JToken sources) && sources is JArray array)
            {
                prefs.ActiveSources = [.. array.Select(v => $"{v}")];
            }
            prefs.DisplayMinCount = Math.Clamp((int?)data["display_min_count"] ?? prefs.DisplayMinCount, 0, 1000000);
            prefs.LeanMinCount = Math.Clamp((int?)data["lean_min_count"] ?? prefs.LeanMinCount, 1, 1000000);
            prefs.TypeaheadEnabled = (bool?)data["typeahead_enabled"] ?? prefs.TypeaheadEnabled;
            prefs.QuotaWithList = Math.Clamp((int?)data["quota_with_list"] ?? prefs.QuotaWithList, 0, 50);
            prefs.QuotaAlone = Math.Clamp((int?)data["quota_alone"] ?? prefs.QuotaAlone, 0, 50);
            prefs.ThumbPromptSuffix = (string)data["thumb_prompt_suffix"] ?? prefs.ThumbPromptSuffix;
        }
        catch (Exception ex)
        {
            Logs.Debug($"[TagDex] Could not read prefs for '{session.User.UserID}', using defaults: {ex.ReadableString()}");
        }
        return prefs;
    }
}

public partial class TagDexExtension
{
    /// <summary>API route: lists every known dataset with its presence, load state, and size.</summary>
    [API.APIDescription("Lists the known TagDex datasets, with presence, load state, row counts and staleness.", "\"sources\": [ { \"id\": \"danbooru_character\", \"present\": true, ... } ]")]
    public async Task<JObject> TagDexListSources(Session session)
    {
        JArray result = [];
        foreach (TagDexSource source in TagDexData.Sources)
        {
            bool present = TagDexData.IsPresent(source);
            TagDexData.Loaded.TryGetValue(source.ID, out TagDexList list);
            JObject entry = new()
            {
                ["id"] = source.ID,
                ["label"] = source.Label,
                ["kind"] = source.Kind == TagDexKind.Character ? "character" : "artist",
                ["url"] = source.Url,
                ["downloadable"] = source.IsDownloadable,
                ["scored"] = source.Format == TagDexFormat.AnimaStyles,
                ["present"] = present,
                ["loaded"] = list is not null,
                ["rows"] = list?.Entries.Length ?? 0,
                ["total_rows"] = list?.TotalRowsInFile ?? 0,
                ["copyrights"] = list?.Copyrights.Length ?? 0,
                ["approx_mb"] = list is null ? 0 : Math.Round(list.ApproxBytes / (1024.0 * 1024.0), 1),
                ["stale"] = present && TagDexData.IsStale(source)
            };
            if (present)
            {
                try
                {
                    entry["file_bytes"] = new FileInfo(TagDexData.PathFor(source)).Length;
                }
                catch (Exception)
                {
                    entry["file_bytes"] = 0;
                }
            }
            if (list is not null)
            {
                entry["index_version"] = TagDexIndexBlob.Fingerprint(list, TagDexPrefs.For(session).LeanMinCount);
            }
            result.Add(entry);
        }
        return new JObject() { ["sources"] = result, ["prefs"] = TagDexPrefs.For(session).ToJson() };
    }

    /// <summary>API route: faceted, paged search over one dataset.</summary>
    [API.APIDescription("Searches one TagDex dataset with optional facet filters, returning a page of results.", "\"total\": 431, \"results\": [ { \"name\": \"hatsune_miku\", ... } ]")]
    public async Task<JObject> TagDexSearchEntries(Session session,
        [API.APIParameter("Dataset ID, eg `danbooru_character`.")] string source,
        [API.APIParameter("Free text to match against the tag name and copyright.")] string search = "",
        [API.APIParameter("Exact copyright/series to filter to.")] string copyright = "",
        [API.APIParameter("Comma-separated hair colors to filter to.")] string hairColor = "",
        [API.APIParameter("Comma-separated hair lengths to filter to.")] string hairLength = "",
        [API.APIParameter("Comma-separated eye colors to filter to.")] string eyeColor = "",
        [API.APIParameter("Comma-separated gender tags to filter to.")] string gender = "",
        [API.APIParameter("Minimum post count, or -1 to use the caller's saved preference.")] int minCount = -1,
        [API.APIParameter("Sort mode: relevance, count, solo_count, name, or copyright.")] string sortBy = "relevance",
        [API.APIParameter("Whether to reverse the sort.")] bool sortReverse = false,
        [API.APIParameter("How many results to skip.")] int offset = 0,
        [API.APIParameter("How many results to return, capped at 250.")] int limit = 100,
        [API.APIParameter("Whether to include the copyright folder list in the response.")] bool withFolders = false,
        [API.APIParameter("Whether to return only the caller's favorites.")] bool favoritesOnly = false)
    {
        TagDexList list = TagDexData.EnsureLoaded(source);
        if (list is null)
        {
            return new JObject() { ["error"] = $"Dataset '{source}' is not downloaded yet.", ["missing_data"] = true };
        }
        TagDexPrefs prefs = TagDexPrefs.For(session);
        HashSet<string> favorites = TagDexFavorites.For(session);
        HashSet<string> favoriteNames = TagDexFavorites.ForSource(favorites, source);
        TagDexQuery query = TagDexSearch.BuildQuery(search, copyright, hairColor, hairLength, eyeColor, gender,
            minCount < 0 ? prefs.DisplayMinCount : minCount);
        query.FavoritesOnly = favoritesOnly;
        query.FavoriteNames = favoriteNames;
        long start = Environment.TickCount64;
        TagDexResults results = TagDexSearch.Run(list, query, sortBy, sortReverse, offset, limit);
        JArray array = [];
        foreach (int index in results.Indices)
        {
            array.Add(DescribeEntry(list, index, favoriteNames.Contains(list.Entries[index].Name)));
        }
        JObject response = new()
        {
            ["total"] = results.Total,
            ["offset"] = offset,
            ["limit"] = limit,
            ["took_ms"] = Environment.TickCount64 - start,
            ["results"] = array
        };
        if (withFolders)
        {
            JArray folders = [];
            foreach ((string name, int count) in list.Copyrights)
            {
                folders.Add(new JObject() { ["token"] = TagDexNames.ToFolderToken(name), ["name"] = name, ["count"] = count });
            }
            response["copyrights"] = folders;
        }
        return response;
    }

    /// <summary>API route: the facet vocabularies plus the copyright rollup, for building filter controls.</summary>
    [API.APIDescription("Gets TagDex facet vocabularies and the copyright rollup for one dataset.", "\"facets\": { \"hair_color\": [...], ... }")]
    public async Task<JObject> TagDexGetFacets(Session session,
        [API.APIParameter("Dataset ID.")] string source,
        [API.APIParameter("How many copyrights to return, most populous first.")] int topCopyrights = 400)
    {
        TagDexList list = TagDexData.EnsureLoaded(source);
        if (list is null)
        {
            return new JObject() { ["error"] = $"Dataset '{source}' is not downloaded yet.", ["missing_data"] = true };
        }
        JArray copyrights = [];
        int max = Math.Min(Math.Max(topCopyrights, 0), list.Copyrights.Length);
        for (int i = 0; i < max; i++)
        {
            (string name, int count) = list.Copyrights[i];
            copyrights.Add(new JObject() { ["token"] = TagDexNames.ToFolderToken(name), ["name"] = name, ["count"] = count });
        }
        JArray genders = [];
        for (int i = 0; i < TagDexVocab.Genders.Length; i++)
        {
            genders.Add(new JObject() { ["value"] = TagDexVocab.Genders[i], ["label"] = TagDexVocab.GenderLabels[i] });
        }
        return new JObject()
        {
            ["facets"] = new JObject()
            {
                ["hair_color"] = new JArray(TagDexVocab.HairColors),
                ["hair_length"] = new JArray(TagDexVocab.HairLengths),
                ["eye_color"] = new JArray(TagDexVocab.EyeColors),
                ["gender"] = genders,
                ["copyright"] = copyrights
            },
            ["copyright_total"] = list.Copyrights.Length,
            ["rows"] = list.Entries.Length
        };
    }

    /// <summary>API route: reads the caller's TagDex preferences.</summary>
    [API.APIDescription("Gets the caller's TagDex preferences.", "\"prefs\": { ... }")]
    public async Task<JObject> TagDexGetPrefs(Session session)
    {
        return new JObject() { ["prefs"] = TagDexPrefs.For(session).ToJson() };
    }

    /// <summary>API route: writes the caller's TagDex preferences.</summary>
    [API.APIDescription("Saves the caller's TagDex preferences.", "\"success\": true")]
    public async Task<JObject> TagDexSetPrefs(Session session,
        [API.APIParameter("The full preferences object to store.")] JObject prefs)
    {
        session.User.SaveGenericData("tagdex", "prefs", prefs.ToString());
        return new JObject() { ["success"] = true };
    }

    /// <summary>API route: downloads one dataset CSV from HuggingFace, streaming progress over the socket.</summary>
    [API.APIDescription("Downloads a TagDex dataset CSV, with websocket progress updates.", "\"success\": true, \"rows\": 15034")]
    public async Task<JObject> TagDexDownloadSource(Session session, WebSocket ws,
        [API.APIParameter("Dataset ID to download.")] string source)
    {
        TagDexSource src = TagDexData.SourceFor(source);
        if (src is null)
        {
            await ws.SendJson(new JObject() { ["error"] = $"Unknown dataset '{source}'." }, API.WebsocketTimeout);
            return null;
        }
        if (!src.IsDownloadable)
        {
            await ws.SendJson(new JObject() { ["error"] = $"Dataset '{source}' is supplied locally and has no download source." }, API.WebsocketTimeout);
            return null;
        }
        string outPath = TagDexData.PathFor(src);
        string tempPath = $"{outPath}.download.tmp";
        try
        {
            if (File.Exists(tempPath))
            {
                File.Delete(tempPath);
            }
            Logs.Info($"[TagDex] Downloading dataset '{src.ID}' from {src.Url}");
            using CancellationTokenSource canceller = new();
            Task downloading = Utilities.DownloadFile(src.Url, tempPath, (progress, total, perSec) =>
            {
                ws.SendJson(new JObject()
                {
                    ["status"] = "downloading",
                    ["current_percent"] = total <= 0 ? 0 : progress / (double)total,
                    ["downloaded"] = progress,
                    ["total"] = total,
                    ["per_second"] = perSec
                }, API.WebsocketTimeout).Wait();
            }, canceller);
            Task listenForSignal = Utilities.RunCheckedTask(async () =>
            {
                while (true)
                {
                    while (ws.State == WebSocketState.Connecting)
                    {
                        await Task.Delay(TimeSpan.FromSeconds(0.1), Program.GlobalProgramCancel);
                    }
                    if (ws.State != WebSocketState.Open || ws.CloseStatus.HasValue || downloading.IsCompleted)
                    {
                        break;
                    }
                    JObject data = await ws.ReceiveJson(1024 * 1024, true);
                    if (data is not null && data.TryGetValue("signal", out JToken signal) && $"{signal}".ToLowerFast() == "cancel")
                    {
                        canceller.Cancel();
                    }
                }
            });
            await downloading;
            if (File.Exists(outPath))
            {
                File.Delete(outPath);
            }
            File.Move(tempPath, outPath);
            await ws.SendJson(new JObject() { ["status"] = "parsing" }, API.WebsocketTimeout);
            TagDexData.Unload(src.ID);
            TagDexList list = TagDexData.EnsureLoaded(src.ID);
            if (list is null)
            {
                await ws.SendJson(new JObject() { ["error"] = "Downloaded, but the file could not be parsed. See server logs." }, API.WebsocketTimeout);
                return null;
            }
            await ws.SendJson(new JObject()
            {
                ["success"] = true,
                ["rows"] = list.Entries.Length,
                ["total_rows"] = list.TotalRowsInFile,
                ["approx_mb"] = Math.Round(list.ApproxBytes / (1024.0 * 1024.0), 1)
            }, API.WebsocketTimeout);
            return null;
        }
        catch (TaskCanceledException)
        {
            CleanupTemp(tempPath);
            await ws.SendJson(new JObject() { ["error"] = "Download cancelled." }, API.WebsocketTimeout);
            return null;
        }
        catch (Exception ex)
        {
            CleanupTemp(tempPath);
            Logs.Error($"[TagDex] Download of '{source}' failed: {ex.ReadableString()}");
            await ws.SendJson(new JObject() { ["error"] = $"Download failed: {ex.Message}" }, API.WebsocketTimeout);
            return null;
        }
    }

    /// <summary>Removes a partial download, ignoring failures.</summary>
    public static void CleanupTemp(string tempPath)
    {
        try
        {
            if (File.Exists(tempPath))
            {
                File.Delete(tempPath);
            }
        }
        catch (Exception)
        {
            // A leftover .tmp is harmless - the next download deletes it first.
        }
    }

    /// <summary>API route: re-parses one dataset from disk.</summary>
    [API.APIDescription("Reloads one TagDex dataset from disk.", "\"success\": true, \"rows\": 15034")]
    public async Task<JObject> TagDexReloadSource(Session session,
        [API.APIParameter("Dataset ID to reload.")] string source)
    {
        TagDexList list = TagDexData.Reload(source);
        if (list is null)
        {
            return new JObject() { ["error"] = $"Dataset '{source}' could not be loaded." };
        }
        return new JObject() { ["success"] = true, ["rows"] = list.Entries.Length };
    }

    /// <summary>API route: drops one dataset from memory.</summary>
    [API.APIDescription("Unloads one TagDex dataset from memory.", "\"success\": true")]
    public async Task<JObject> TagDexUnloadSource(Session session,
        [API.APIParameter("Dataset ID to unload.")] string source)
    {
        TagDexData.Unload(source);
        return new JObject() { ["success"] = true };
    }

    /// <summary>API route: adopts thumbnails dropped into the import folder.
    /// <para>Matches AnimaDex's on-disk convention, where a character's image is named after its trigger, eg
    /// <c>hatsune miku, vocaloid.webp</c>. Matching is tried against the trigger first, then the tag name, with
    /// underscores and spaces treated as equivalent.</para></summary>
    [API.APIDescription("Imports thumbnail images from the TagDex import folder into a dataset's thumbnail store.", "\"imported\": 412, \"unmatched\": 9")]
    public async Task<JObject> TagDexImportThumbnails(Session session,
        [API.APIParameter("Dataset ID to import into.")] string source)
    {
        TagDexList list = TagDexData.EnsureLoaded(source);
        if (list is null)
        {
            return new JObject() { ["error"] = $"Dataset '{source}' is not downloaded yet.", ["missing_data"] = true };
        }
        string importRoot = $"{TagDexData.FolderPath}/imported";
        string destRoot = $"{TagDexData.ThumbsPath}/{source}";
        Directory.CreateDirectory(destRoot);
        Dictionary<string, int> byTrigger = [];
        for (int i = 0; i < list.Entries.Length; i++)
        {
            // TryAdd, not assignment: Normalize folds filename-illegal characters and trailing dots to nothing, so
            // a handful of tag pairs ('awa' / 'awa.', 'unown' / 'unown_?') share one key and are indistinguishable
            // on disk. Entries is sorted count-descending, so first-wins gives the thumbnail to the tag the model
            // actually learned. Assignment would hand it to the obscure twin.
            byTrigger.TryAdd(Normalize(list.Entries[i].Trigger), i);
            byTrigger.TryAdd(Normalize(list.Entries[i].Name), i);
        }
        int imported = 0;
        int unmatched = 0;
        foreach (string file in Directory.EnumerateFiles(importRoot, "*", SearchOption.AllDirectories))
        {
            string ext = Path.GetExtension(file).ToLowerFast();
            if (ext != ".webp" && ext != ".jpg" && ext != ".jpeg" && ext != ".png")
            {
                continue;
            }
            string stem = Normalize(Path.GetFileNameWithoutExtension(file));
            if (!byTrigger.TryGetValue(stem, out int index))
            {
                unmatched++;
                continue;
            }
            try
            {
                File.Copy(file, $"{destRoot}/{TagDexNames.SafeFileName(list.Entries[index].Name)}{ext}", true);
                imported++;
            }
            catch (Exception ex)
            {
                Logs.Debug($"[TagDex] Could not import thumbnail '{file}': {ex.ReadableString()}");
                unmatched++;
            }
        }
        TagDexData.InvalidateThumbs(source);
        Logs.Info($"[TagDex] Imported {imported} thumbnails into '{source}' ({unmatched} unmatched).");
        return new JObject() { ["success"] = true, ["imported"] = imported, ["unmatched"] = unmatched };
    }

    /// <summary>Characters illegal in Windows filenames. External exporters (eg AnimaDex) replace these before
    /// writing, so a thumbnail's on-disk stem for a tag like '2b_(nier:automata)' can never contain the colon.
    /// Treating them as equivalent to space on BOTH sides of the import match recovers those entries.</summary>
    public static readonly char[] IllegalFileChars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

    /// <summary>Normalizes a name for loose matching: lowercase, with underscores, spaces, and
    /// filename-illegal characters treated as equivalent, and trailing dots dropped (Windows strips them).</summary>
    public static string Normalize(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "";
        }
        value = value.ToLowerFast().Replace('_', ' ');
        foreach (char c in IllegalFileChars)
        {
            value = value.Replace(c, ' ');
        }
        return value.TrimEnd(' ', '.').Trim();
    }

    /// <summary>Builds the JSON description of one entry, as sent to the browse tab.</summary>
    public static JObject DescribeEntry(TagDexList list, int index, bool favorited = false)
    {
        ref TagDexEntry entry = ref list.Entries[index];
        JObject result = new()
        {
            ["name"] = entry.Name,
            ["display"] = TagDexNames.Humanize(entry.Name),
            ["trigger"] = entry.Trigger,
            ["count"] = entry.Count,
            ["solo_count"] = entry.SoloCount,
            ["url"] = list.UrlFor(in entry),
            ["kind"] = list.Source.Kind == TagDexKind.Character ? "character" : "artist"
        };
        if (entry.Copyright is not null)
        {
            result["copyright"] = entry.Copyright;
            result["copyright_display"] = TagDexNames.Humanize(entry.Copyright);
        }
        if (entry.CoreTags is not null)
        {
            result["core_tags"] = new JArray(entry.CoreTags.Split(',').Select(t => t.Trim()).Where(t => t.Length > 0));
        }
        if (entry.Uniqueness > 0)
        {
            result["uniqueness"] = Math.Round(entry.Uniqueness, 2);
        }
        if (entry.AvgScore > 0)
        {
            result["avg_score"] = Math.Round(entry.AvgScore, 1);
        }
        if (favorited)
        {
            result["favorited"] = true;
        }
        string thumb = ThumbnailFor(list, in entry);
        if (thumb is not null)
        {
            result["thumb"] = thumb;
        }
        return result;
    }

    /// <summary>Resolves the served URL of an entry's thumbnail, or null when none exists.</summary>
    public static string ThumbnailFor(TagDexList list, in TagDexEntry entry)
    {
        System.Collections.Frozen.FrozenSet<string> present = TagDexData.ThumbsFor(list.Source.ID);
        if (present.Count == 0)
        {
            return null;
        }
        // Datasets that ship their own images carry a pre-resolved relative path; everything else is looked up by
        // sanitized name across the extensions we might have written.
        if (entry.ThumbPath is not null)
        {
            return present.Contains(entry.ThumbPath) ? ThumbUrl(list.Source.ID, entry.ThumbPath) : null;
        }
        string stem = TagDexNames.SafeFileName(entry.Name);
        foreach (string ext in new[] { ".jpg", ".webp", ".png" })
        {
            if (present.Contains($"{stem}{ext}"))
            {
                return ThumbUrl(list.Source.ID, $"{stem}{ext}");
            }
        }
        return null;
    }

    /// <summary>Builds the served URL for a thumbnail, escaping each path segment but keeping the separators.</summary>
    public static string ThumbUrl(string sourceId, string relativePath)
    {
        string escaped = relativePath.Split('/').Select(Uri.EscapeDataString).JoinString("/");
        return $"/TagDexThumb/{sourceId}/{escaped}";
    }
}
