using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
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
    /// <para>Send the FULL-RESOLUTION image, not the 256px thumbnail <see cref="TagDexExtension.WriteThumb"/>
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
}
