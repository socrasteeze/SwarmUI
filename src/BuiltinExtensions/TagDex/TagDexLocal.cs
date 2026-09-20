using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Utils;
using System.IO;

namespace SwarmUI.Builtin_TagDexExtension;

/// <summary>Server-side local configuration for TagDex, read from <c>Data/TagDex/local.json</c>.
/// <para><b>Why a file and not <see cref="TagDexPrefs"/>.</b> Prefs are per-user data behind
/// <c>tagdex_use</c>, which defaults to the USER tier, and <c>TagDexSetPrefs</c> stores the request body
/// verbatim with no whitelist. Anything here that names a push target or holds a shared key would
/// therefore be writable by any ordinary user and echoed back to every browser by
/// <c>TagDexPrefs.ToJson</c>. This file is read server-side only and is never serialized into an API
/// response.</para>
/// <para><b>Why not <c>Settings.cs</c>.</b> That is a core file, and TagDex is deliberately a
/// zero-core-edit extension.</para>
/// <para>Missing file means defaults, which leave every optional behaviour off except the thumbnail
/// format. Re-read on mtime change, so edits apply without a restart.</para></summary>
public static class TagDexLocal
{
    /// <summary>Config file path.</summary>
    public static string ConfigPath => $"{TagDexData.FolderPath}/local.json";

    /// <summary>Where full-resolution lossless originals are kept, when enabled.</summary>
    public static string OriginalsPath => $"{TagDexData.FolderPath}/originals";

    /// <summary>Outbound sync to an AnimaDex instance.</summary>
    public record class AnimaDexConfig(bool Enabled, string Url, string DevKey, int TimeoutSeconds)
    {
        public static AnimaDexConfig Default = new(false, "", "", 30);
    }

    /// <summary>Authenticated local AnimaDex library API.</summary>
    public record class LibraryConfig(bool Enabled, string Url, string Key, int TimeoutSeconds)
    {
        public static LibraryConfig Default = new(false, "", "", 30);
    }

    /// <summary>NAS Model Manager archive used for explicit LoRA acquisition.</summary>
    public record class ArchiveConfig(bool Enabled, string Url, string Token, int TimeoutSeconds)
    {
        public static ArchiveConfig Default = new(false, "", "", 300);
    }

    /// <summary>How reference thumbnails are stored.</summary>
    /// <param name="Height">Target height in pixels; width scales proportionally. 445 matches AnimaDex's
    /// own thumbnail geometry, so the two catalogues hold identically sized images.</param>
    /// <param name="Quality">WebP quality, 0-100.</param>
    /// <param name="KeepOriginals">Whether to also keep the untouched full-resolution PNG.</param>
    public record class ThumbConfig(int Height, int Quality, bool KeepOriginals)
    {
        // WebP rather than the JPEG that ToMetadataJpg produces: measured on real cards, the JPEG ran
        // ~9% LARGER than an equivalent WebP while holding fewer pixels (256px short side vs 297x445).
        // Anime line art is the worst case for JPEG - flat colour and hard edges are exactly what DCT
        // ringing damages - and WebP handles it well. See docs/TagDex-Plan.md.
        public static ThumbConfig Default = new(445, 82, false);
    }

    private static AnimaDexConfig CachedAnimaDex = null;
    private static ThumbConfig CachedThumbs = null;
    private static LibraryConfig CachedLibrary = null;
    private static ArchiveConfig CachedArchive = null;
    private static DateTime CachedStamp = DateTime.MinValue;
    private static string CachedPath = null;
    private static readonly object CacheLock = new();

    private static void Refresh()
    {
        lock (CacheLock)
        {
            try
            {
                if (!File.Exists(ConfigPath))
                {
                    CachedAnimaDex = AnimaDexConfig.Default;
                    CachedThumbs = ThumbConfig.Default;
                    CachedLibrary = LibraryConfig.Default;
                    CachedArchive = ArchiveConfig.Default;
                    CachedStamp = DateTime.MinValue;
                    return;
                }
                DateTime stamp = File.GetLastWriteTimeUtc(ConfigPath);
                if (CachedAnimaDex is not null && stamp == CachedStamp && CachedPath == ConfigPath)
                {
                    return;
                }
                JObject data = JObject.Parse(File.ReadAllText(ConfigPath));
                JObject ad = data["animadex"] as JObject ?? [];
                CachedAnimaDex = new(
                    ad.Value<bool?>("enabled") ?? false,
                    (ad.Value<string>("url") ?? "").TrimEnd('/'),
                    ad.Value<string>("dev_key") ?? "",
                    ad.Value<int?>("timeout_seconds") ?? 30);
                JObject th = data["thumbnails"] as JObject ?? [];
                CachedThumbs = new(
                    Math.Clamp(th.Value<int?>("height") ?? 445, 64, 4096),
                    Math.Clamp(th.Value<int?>("quality") ?? 82, 1, 100),
                    th.Value<bool?>("keep_originals") ?? false);
                JObject library = data["library"] as JObject ?? [];
                CachedLibrary = new(
                    library.Value<bool?>("enabled") ?? false,
                    (library.Value<string>("url") ?? "").TrimEnd('/'),
                    library.Value<string>("key") ?? "",
                    Math.Clamp(library.Value<int?>("timeout_seconds") ?? 30, 1, 300));
                JObject archive = data["archive"] as JObject ?? [];
                CachedArchive = new(
                    archive.Value<bool?>("enabled") ?? false,
                    (archive.Value<string>("url") ?? "").TrimEnd('/'),
                    archive.Value<string>("token") ?? "",
                    Math.Clamp(archive.Value<int?>("timeout_seconds") ?? 300, 10, 3600));
                CachedStamp = stamp;
                CachedPath = ConfigPath;
            }
            catch (Exception ex)
            {
                // A malformed config must never break thumbnail generation. Fall back to defaults, which
                // are the behaviour everyone gets with no file at all.
                Logs.Warning($"[TagDex] Could not read '{ConfigPath}', using defaults: {ex.ReadableString()}");
                CachedAnimaDex = AnimaDexConfig.Default;
                CachedThumbs = ThumbConfig.Default;
                CachedLibrary = LibraryConfig.Default;
                CachedArchive = ArchiveConfig.Default;
                CachedStamp = DateTime.MinValue;
                CachedPath = null;
            }
        }
    }

    /// <summary>Current AnimaDex sync config.</summary>
    public static AnimaDexConfig AnimaDex()
    {
        Refresh();
        return CachedAnimaDex ?? AnimaDexConfig.Default;
    }

    /// <summary>Current thumbnail storage config.</summary>
    public static ThumbConfig Thumbs()
    {
        Refresh();
        return CachedThumbs ?? ThumbConfig.Default;
    }

    /// <summary>Current local library connection.</summary>
    public static LibraryConfig Library()
    {
        Refresh();
        return CachedLibrary ?? LibraryConfig.Default;
    }

    /// <summary>Current archive connection.</summary>
    public static ArchiveConfig Archive()
    {
        Refresh();
        return CachedArchive ?? ArchiveConfig.Default;
    }
}
