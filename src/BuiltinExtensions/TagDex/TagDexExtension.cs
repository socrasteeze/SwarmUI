using FreneticUtilities.FreneticExtensions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.IO;

namespace SwarmUI.Builtin_TagDexExtension;

/// <summary>Fork-owned extension adding a character/artist tag picker for booru-trained anime models
/// (Anima, IllustriousXL, NoobAI).
/// <para>These checkpoints are trained on the Danbooru/e621 tag vocabulary, so summoning a character requires its
/// exact trigger - "hatsune miku, vocaloid" - which there was previously no way to discover from inside SwarmUI.
/// This adds inline prompt typeahead plus a faceted browse tab, backed by the Laxhar/noob-wiki CSV datasets.</para>
/// <para>Everything ships as new files so upstream merges stay clean. Zero core-file edits.</para></summary>
public partial class TagDexExtension : Extension
{
    /// <summary>Permission to search and read the tag datasets. Safe - it is a read-only local lookup.</summary>
    public static PermInfo PermUseTagDex = Permissions.Register(new("tagdex_use", "[TagDex] Use Tag Picker",
        "Allows searching and reading the character/artist tag datasets.", PermissionDefault.USER, Permissions.GroupUser, PermSafetyLevel.SAFE));

    /// <summary>Permission to download datasets, reload them, and import thumbnails.
    /// <para>Separate from <see cref="PermUseTagDex"/> and defaulted higher because these actions spend up to 113 MB
    /// of bandwidth and write to the server's data folder, matching how <c>Permissions.DownloadModels</c> is gated.</para></summary>
    public static PermInfo PermManageTagDex = Permissions.Register(new("tagdex_manage", "[TagDex] Manage Tag Data",
        "Allows downloading tag datasets from HuggingFace, reloading them, and importing thumbnails.", PermissionDefault.POWERUSERS, Permissions.GroupControl, PermSafetyLevel.SAFE));

    /// <inheritdoc/>
    public override void OnInit()
    {
        ScriptFiles.Add("Assets/tagdex_core.js");
        ScriptFiles.Add("Assets/tagdex_prompt.js");
        ScriptFiles.Add("Assets/tagdex_tab.js");
        StyleSheetFiles.Add("Assets/tagdex.css");
        // The /simple hook goes in OtherAssets, not ScriptFiles: ScriptFiles injects on every Razor page, where
        // MAutoComplete does not exist. It is loaded explicitly by MobileEnhancements' Assets/m/index.html.
        OtherAssets.Add("Assets/m_tagdex.js");
        // Same reasoning for the stylesheet: StyleSheetFiles would inject it into every Razor page, and it is only
        // ever wanted on /simple.
        OtherAssets.Add("Assets/m_tagdex.css");
        TagDexData.Init();
        API.RegisterAPICall(TagDexListSources, false, PermUseTagDex);
        API.RegisterAPICall(TagDexSearchEntries, false, PermUseTagDex);
        API.RegisterAPICall(TagDexGetFacets, false, PermUseTagDex);
        API.RegisterAPICall(TagDexGetPrefs, false, PermUseTagDex);
        API.RegisterAPICall(TagDexSetPrefs, true, PermUseTagDex);
        API.RegisterAPICall(TagDexToggleFavorite, true, PermUseTagDex);
        API.RegisterAPICall(TagDexListFavorites, false, PermUseTagDex);
        API.RegisterAPICall(TagDexDownloadSource, true, PermManageTagDex);
        API.RegisterAPICall(TagDexReloadSource, true, PermManageTagDex);
        API.RegisterAPICall(TagDexUnloadSource, true, PermManageTagDex);
        API.RegisterAPICall(TagDexImportThumbnails, true, PermManageTagDex);
        API.RegisterAPICall(TagDexGenerateThumbnail, true, PermManageTagDex);
        API.RegisterAPICall(TagDexSetThumbnail, true, PermManageTagDex);
        API.RegisterAPICall(TagDexDeleteThumbnail, true, PermManageTagDex);
        API.RegisterAPICall(TagDexReconcileFavorites, true, PermManageTagDex);
    }

    /// <inheritdoc/>
    public override void OnPreLaunch()
    {
        // MapGet only works here: WebApp exists after Web.Prep() but the server has not launched yet.
        WebServer.WebApp.MapGet("/TagDexIndex/{source}/{version}", ServeIndexBlob);
        // Catch-all on the file segment: the anima-styles export shards its images into numbered subfolders, so a
        // thumbnail path can contain a slash.
        WebServer.WebApp.MapGet("/TagDexThumb/{source}/{**file}", ServeThumbnail);
        // Warm any already-present dataset off the launch-critical path. Parsing the largest file takes roughly a
        // second, which must not be paid during startup, but should be done before anyone opens the tab.
        Utilities.RunCheckedTask(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5), Program.GlobalProgramCancel);
            }
            catch (OperationCanceledException)
            {
                // The server shut down inside the warm delay. Normal on a fast restart or a CI boot check, and not
                // worth an error in the log - RunCheckedTask would otherwise report it as an internal task failure.
                return;
            }
            foreach (TagDexSource source in TagDexData.Sources)
            {
                if (Program.GlobalProgramCancel.IsCancellationRequested)
                {
                    return;
                }
                if (TagDexData.IsPresent(source))
                {
                    TagDexData.EnsureLoaded(source.ID);
                }
            }
        });
    }

    /// <summary>Serves the lean typeahead index as a tab-separated blob.
    /// <para>A dedicated route rather than an API call so the response can carry an immutable cache header. The
    /// version segment is the loaded list's fingerprint, so a rebuilt dataset produces a new URL and the browser
    /// re-fetches automatically - while an unchanged one is served from cache and never touches the network. That
    /// matters most on a phone, where this is a few hundred kilobytes.</para></summary>
    public async Task ServeIndexBlob(HttpContext context)
    {
        if (!WebUtil.HasValidLogin(context))
        {
            context.Response.StatusCode = 401;
            await context.Response.CompleteAsync();
            return;
        }
        string sourceId = $"{context.Request.RouteValues["source"]}";
        TagDexList list = TagDexData.EnsureLoaded(sourceId);
        if (list is null)
        {
            context.Response.StatusCode = 404;
            await context.Response.CompleteAsync();
            return;
        }
        int minCount = TagDexPrefs.DefaultLeanMinCount;
        if (context.Request.Query.TryGetValue("min", out Microsoft.Extensions.Primitives.StringValues raw) && int.TryParse(raw, out int parsed))
        {
            minCount = Math.Clamp(parsed, 1, 1000000);
        }
        string body = TagDexIndexBlob.Build(list, minCount);
        context.Response.ContentType = "text/plain; charset=utf-8";
        context.Response.Headers["Cache-Control"] = "private, max-age=31536000, immutable";
        context.Response.StatusCode = 200;
        await context.Response.WriteAsync(body);
        await context.Response.CompleteAsync();
    }

    /// <summary>Serves one thumbnail image out of the TagDex data folder.</summary>
    public async Task ServeThumbnail(HttpContext context)
    {
        if (!WebUtil.HasValidLogin(context))
        {
            context.Response.StatusCode = 401;
            await context.Response.CompleteAsync();
            return;
        }
        string sourceId = $"{context.Request.RouteValues["source"]}";
        string file = $"{context.Request.RouteValues["file"]}";
        if (TagDexData.SourceFor(sourceId) is null)
        {
            context.Response.StatusCode = 404;
            await context.Response.CompleteAsync();
            return;
        }
        string root = $"{TagDexData.ThumbsPath}/{sourceId}";
        // Path-traversal guard, matching how ViewSpecial protects the wildcard preview route. CheckFilePath returns
        // (resolvedPath, consoleError, userError) - a non-null error means the path escaped the root.
        (string path, string consoleError, string userError) = WebServer.CheckFilePath(root, file);
        if (consoleError is not null || userError is not null || !File.Exists(path))
        {
            context.Response.StatusCode = 404;
            await context.Response.CompleteAsync();
            return;
        }
        context.Response.ContentType = file.EndsWith(".webp") ? "image/webp" : (file.EndsWith(".png") ? "image/png" : "image/jpeg");
        context.Response.Headers["Cache-Control"] = "private, max-age=604800";
        context.Response.StatusCode = 200;
        await context.Response.Body.WriteAsync(await File.ReadAllBytesAsync(path));
        await context.Response.CompleteAsync();
    }
}

/// <summary>Builds the lean client-side typeahead index.</summary>
public static class TagDexIndexBlob
{
    /// <summary>Cached serialized blobs, keyed by source ID, minimum count, and the list's file timestamp and row
    /// count. A rebuilt list gets a new key, so it never reads a stale blob - but the old key would otherwise stay
    /// resident forever, so <see cref="TagDexData.Unload"/> calls <see cref="Evict"/> to drop every entry for
    /// that source.</summary>
    public static ConcurrentDictionary<string, string> Cache = new();

    /// <summary>Drops every cached blob belonging to one source, whatever its minimum count or fingerprint.</summary>
    public static void Evict(string sourceId)
    {
        string prefix = $"{sourceId}\n";
        foreach (string key in Cache.Keys)
        {
            if (key.StartsWithFast(prefix))
            {
                Cache.TryRemove(key, out _);
            }
        }
    }

    /// <summary>A short fingerprint of a loaded list, used as the immutable-cache URL segment.</summary>
    public static string Fingerprint(TagDexList list, int minCount)
    {
        return $"{list.FileModifiedUtc:x}-{list.Entries.Length:x}-{minCount:x}";
    }

    /// <summary>Serializes the top entries of a list as newline-delimited, tab-separated records.
    /// <para>Tab-separated rather than JSON: at ~15,000 rows the bracket-and-quote overhead of a JSON array of
    /// arrays is roughly 30% of the payload for no benefit, since the client parses it with a single split.</para>
    /// <para>Field order is: name, trigger, copyright, coreTags, count. Entries are already sorted by count
    /// descending, which the client relies on to make an early-terminated scan return the most popular matches.</para></summary>
    public static string Build(TagDexList list, int minCount)
    {
        string key = $"{list.Source.ID}\n{minCount}\n{list.FileModifiedUtc}\n{list.Entries.Length}";
        return Cache.GetOrCreate(key, () =>
        {
            StringBuilder builder = new(1024 * 512);
            TagDexEntry[] entries = list.Entries;
            for (int i = 0; i < entries.Length; i++)
            {
                ref TagDexEntry entry = ref entries[i];
                if (entry.Count < minCount)
                {
                    // Entries are count-descending, so the first row under the floor ends the useful range.
                    break;
                }
                builder.Append(Clean(entry.Name)).Append('\t');
                builder.Append(Clean(entry.Trigger)).Append('\t');
                builder.Append(Clean(entry.Copyright)).Append('\t');
                builder.Append(Clean(entry.CoreTags)).Append('\t');
                builder.Append(entry.Count).Append('\n');
            }
            return builder.ToString();
        });
    }

    /// <summary>Strips the two characters that would corrupt the tab-separated line format.</summary>
    public static string Clean(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "";
        }
        if (value.Contains('\t') || value.Contains('\n'))
        {
            return value.Replace('\t', ' ').Replace('\n', ' ');
        }
        return value;
    }
}
