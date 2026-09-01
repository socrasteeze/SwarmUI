using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Media;
using SwarmUI.Utils;
using System.IO;
using System.Net.Http;
using System.Text;

namespace SwarmUI.Builtin_TagDexExtension;

/// <summary>Outbound sync: pushes a TagDex reference image into an AnimaDex instance, so a thumbnail
/// generated here also lands in that catalogue.
/// <para>This is the return leg of a two-way pairing. AnimaDex pushes to TagDex through
/// <see cref="TagDexExtension.TagDexSetThumbnail"/>; this pushes back the other way.</para>
/// <para><b>Why the config lives in a file rather than in <c>TagDexPrefs</c>.</b> Prefs are per-user
/// data behind <c>tagdex_use</c>, which defaults to the USER tier, and <c>TagDexSetPrefs</c> stores the
/// request body verbatim with no whitelist. Putting a push target there would let any ordinary user
/// redirect every generated image to a host of their choosing, and <c>TagDexPrefs.ToJson</c> would echo
/// the shared key to every browser that loads the tab. This file is read server-side only and is never
/// serialized into an API response.</para>
/// <para><b>Why not <c>Settings.cs</c>.</b> TagDex is deliberately a zero-core-edit extension. Adding a
/// settings section would be a core edit for a feature only this extension uses.</para></summary>
public static class TagDexAnimaDex
{
    /// <summary>Maps a TagDex dataset id to an AnimaDex mode, or null when that dataset has no AnimaDex
    /// counterpart.
    /// <para>Only the two danbooru sets map. AnimaDex is built from the danbooru CSVs, so an e621 entry
    /// has no row there, and <c>anima_styles</c> is a local gallery export with no AnimaDex equivalent
    /// either. Pushing those would be a guaranteed 404 per image.</para></summary>
    public static string ModeFor(string sourceId)
    {
        return sourceId switch
        {
            "danbooru_character" => "characters",
            "danbooru_artist" => "artists",
            _ => null
        };
    }

    /// <summary>Pushes one image to AnimaDex. Fire-and-forget: never throws, never blocks the caller.
    /// <para>Send the FULL-RESOLUTION image, not the configured-height WebP <see cref="TagDexExtension.WriteThumb"/>
    /// stores. AnimaDex keeps its own full-size PNG and derives a 297x445 WebP from it, so handing it the
    /// downscaled copy would permanently cap the quality on that side.</para></summary>
    public static void PushAsync(string sourceId, string name, ImageFile image)
    {
        TagDexLocal.AnimaDexConfig cfg = TagDexLocal.AnimaDex();
        if (!cfg.Enabled || string.IsNullOrWhiteSpace(cfg.Url) || image is null)
        {
            return;
        }
        string mode = ModeFor(sourceId);
        if (mode is null)
        {
            return;
        }
        string dataUrl = image.AsDataString();
        Utilities.RunCheckedTask(async () =>
        {
            try
            {
                JObject body = new()
                {
                    ["mode"] = mode,
                    // The slug, never a filename. AnimaDex names files after the trigger and resolves
                    // its own paths from its database, so identity is the only thing that crosses.
                    ["slug"] = name,
                    ["source"] = $"tagdex:{sourceId}",
                    ["image"] = dataUrl
                };
                using HttpRequestMessage req = new(HttpMethod.Post, $"{cfg.Url}/api/dev/ingest")
                {
                    Content = new StringContent(body.ToString(), Encoding.UTF8, "application/json")
                };
                if (!string.IsNullOrWhiteSpace(cfg.DevKey))
                {
                    req.Headers.Add("X-AnimaDex-Dev-Key", cfg.DevKey);
                }
                using CancellationTokenSource cancel = new(TimeSpan.FromSeconds(cfg.TimeoutSeconds));
                using HttpResponseMessage resp = await Utilities.UtilWebClient.SendAsync(req, cancel.Token);
                string text = await resp.Content.ReadAsStringAsync(cancel.Token);
                if (resp.IsSuccessStatusCode)
                {
                    Logs.Debug($"[TagDex] Pushed '{name}' to AnimaDex ({mode}).");
                }
                else if ((int)resp.StatusCode == 404)
                {
                    // Expected for a large share of entries: TagDex's datasets are far bigger than
                    // AnimaDex's, and AnimaDex has no route that creates a row. Not worth a warning.
                    Logs.Debug($"[TagDex] AnimaDex has no {mode} row for '{name}'; skipped.");
                }
                else
                {
                    Logs.Warning($"[TagDex] AnimaDex push for '{name}' failed: HTTP {(int)resp.StatusCode} {text.Trim()}");
                }
            }
            catch (Exception ex)
            {
                Logs.Warning($"[TagDex] AnimaDex push for '{name}' failed: {ex.ReadableString()}");
            }
        }, "tagdex-animadex-push");
    }

    /// <summary>Pushes one favorite state to AnimaDex. Fire-and-forget, matching image sync: the local favorite is
    /// already durable, so an unavailable peer must not roll it back.</summary>
    public static void PushFavoriteAsync(string sourceId, string name, bool favorited)
    {
        TagDexLocal.AnimaDexConfig cfg = TagDexLocal.AnimaDex();
        string mode = ModeFor(sourceId);
        if (!cfg.Enabled || string.IsNullOrWhiteSpace(cfg.Url) || mode is null)
        {
            return;
        }
        Utilities.RunCheckedTask(async () =>
        {
            try
            {
                (bool success, int status, string text) = await SetFavoriteAsync(cfg, mode, name, favorited);
                if (success)
                {
                    Logs.Debug($"[TagDex] Pushed favorite state for '{name}' to AnimaDex ({mode}).");
                }
                else if (status == 404)
                {
                    // The datasets are larger than AnimaDex's catalogue. Missing rows are expected and cannot be
                    // created by this route, so keep this at Debug just like the image-sync 404.
                    Logs.Debug($"[TagDex] AnimaDex has no {mode} row for favorite '{name}'; skipped.");
                }
                else
                {
                    Logs.Warning($"[TagDex] AnimaDex favorite push for '{name}' failed: HTTP {status} {text.Trim()}");
                }
            }
            catch (Exception ex)
            {
                Logs.Warning($"[TagDex] AnimaDex favorite push for '{name}' failed: {ex.ReadableString()}");
            }
        }, "tagdex-animadex-favorite-push");
    }

    /// <summary>Unions one user's local favorites with AnimaDex and writes each missing side once.
    /// <para>Union is deliberate. A fire-and-forget outage can lose an add, which union repairs. Deletes reconcile
    /// only through live two-way relay because a missing value alone cannot reveal which side intentionally removed
    /// it.</para></summary>
    public static async Task<JObject> ReconcileFavoritesAsync(Session session, string sourceId)
    {
        TagDexLocal.AnimaDexConfig cfg = TagDexLocal.AnimaDex();
        string mode = ModeFor(sourceId);
        if (mode is null)
        {
            return new JObject() { ["error"] = $"Dataset '{sourceId}' has no AnimaDex counterpart." };
        }
        if (!cfg.Enabled || string.IsNullOrWhiteSpace(cfg.Url))
        {
            return new JObject() { ["error"] = "AnimaDex sync is not configured." };
        }
        try
        {
            TagDexList list = TagDexData.EnsureLoaded(sourceId);
            if (list is null)
            {
                return new JObject() { ["error"] = $"Dataset '{sourceId}' is not downloaded yet." };
            }
            (HashSet<string> remoteNames, string fetchError) = await FetchFavoritesAsync(cfg, mode);
            if (remoteNames is null)
            {
                return new JObject() { ["error"] = fetchError };
            }
            int localUnavailable = remoteNames.RemoveWhere(name => !list.ByName.ContainsKey(name));
            int localAdded = 0;
            HashSet<string> localNames;
            lock (session.User)
            {
                HashSet<string> allLocal = TagDexFavorites.For(session);
                localNames = TagDexFavorites.ForSource(allLocal, sourceId);
                localNames.RemoveWhere(name => !list.ByName.ContainsKey(name));
                foreach (string name in remoteNames)
                {
                    if (localNames.Add(name))
                    {
                        allLocal.Add(TagDexFavorites.Key(sourceId, name));
                        localAdded++;
                    }
                }
                if (localAdded > 0)
                {
                    TagDexFavorites.Save(session, allLocal);
                }
            }
            int remoteAdded = 0;
            int remoteUnavailable = 0;
            foreach (string name in localNames)
            {
                if (remoteNames.Contains(name))
                {
                    continue;
                }
                (bool success, int status, string text) = await SetFavoriteAsync(cfg, mode, name, true);
                if (success)
                {
                    remoteNames.Add(name);
                    remoteAdded++;
                }
                else if (status == 404)
                {
                    remoteUnavailable++;
                }
                else
                {
                    return new JObject()
                    {
                        ["error"] = $"AnimaDex favorite reconcile failed for '{name}': HTTP {status} {text.Trim()}",
                        ["local_added"] = localAdded,
                        ["remote_added"] = remoteAdded,
                        ["remote_unavailable"] = remoteUnavailable
                    };
                }
            }
            return new JObject()
            {
                ["success"] = true,
                ["source"] = sourceId,
                ["local_added"] = localAdded,
                ["local_unavailable"] = localUnavailable,
                ["remote_added"] = remoteAdded,
                ["remote_unavailable"] = remoteUnavailable,
                ["total"] = localNames.Count
            };
        }
        catch (Exception ex)
        {
            return new JObject() { ["error"] = $"AnimaDex favorite reconcile failed: {ex.Message}" };
        }
    }

    /// <summary>Fetches AnimaDex's favorited slugs for one mode.</summary>
    private static async Task<(HashSet<string> Favorites, string Error)> FetchFavoritesAsync(TagDexLocal.AnimaDexConfig cfg, string mode)
    {
        using HttpRequestMessage request = new(HttpMethod.Get, $"{cfg.Url}/api/dev/favorites?mode={Uri.EscapeDataString(mode)}");
        AddDevKey(request, cfg);
        using CancellationTokenSource cancel = new(TimeSpan.FromSeconds(cfg.TimeoutSeconds));
        using HttpResponseMessage response = await Utilities.UtilWebClient.SendAsync(request, cancel.Token);
        string text = await response.Content.ReadAsStringAsync(cancel.Token);
        if (!response.IsSuccessStatusCode)
        {
            return (null, $"AnimaDex favorites API failed: HTTP {(int)response.StatusCode} {text.Trim()}");
        }
        JObject data = JObject.Parse(text);
        JArray values = data["favorites"] as JArray ?? [];
        HashSet<string> favorites = new(StringComparer.Ordinal);
        foreach (JToken token in values)
        {
            string name = $"{token}";
            if (!string.IsNullOrWhiteSpace(name))
            {
                favorites.Add(name);
            }
        }
        return (favorites, null);
    }

    /// <summary>Writes one favorite state to AnimaDex and returns the raw HTTP outcome.</summary>
    private static async Task<(bool Success, int Status, string Text)> SetFavoriteAsync(TagDexLocal.AnimaDexConfig cfg,
        string mode, string name, bool favorited)
    {
        JObject body = new()
        {
            ["mode"] = mode,
            ["slug"] = name,
            ["favorited"] = favorited
        };
        using HttpRequestMessage request = new(HttpMethod.Post, $"{cfg.Url}/api/dev/favorite")
        {
            Content = new StringContent(body.ToString(), Encoding.UTF8, "application/json")
        };
        AddDevKey(request, cfg);
        using CancellationTokenSource cancel = new(TimeSpan.FromSeconds(cfg.TimeoutSeconds));
        using HttpResponseMessage response = await Utilities.UtilWebClient.SendAsync(request, cancel.Token);
        string text = await response.Content.ReadAsStringAsync(cancel.Token);
        return (response.IsSuccessStatusCode, (int)response.StatusCode, text);
    }

    /// <summary>Adds the configured shared development key to an AnimaDex request when present.</summary>
    private static void AddDevKey(HttpRequestMessage request, TagDexLocal.AnimaDexConfig cfg)
    {
        if (!string.IsNullOrWhiteSpace(cfg.DevKey))
        {
            request.Headers.Add("X-AnimaDex-Dev-Key", cfg.DevKey);
        }
    }
}
