using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Core;
using SwarmUI.Utils;
using System.IO;
using System.Security.Cryptography;

namespace SwarmUI.Builtin_PromptEnhanceExtension;

/// <summary>Caches enhanced prompts by their inputs, so a repeat request behaves consistently and works
/// even while the writer host is asleep.
/// <para>Not an optimization: the profile pack is versioned non-deterministic text, so the same idea can
/// legitimately enhance differently across writer-model or profile-pack changes. The cache key folds in
/// every input that can change the answer, which is what makes batches, grids, and reruns reproducible.</para>
/// <para>Small in-memory map plus a flat JSON file under <see cref="Program.DataDir"/>, loaded lazily and
/// saved synchronously on every write. No debouncing or background thread: entries are short strings and
/// writes are rare compared to a writer-host round trip.</para></summary>
public static class PromptEnhanceCache
{
    /// <summary>Maximum number of cached entries kept; the oldest by insertion order is dropped once this
    /// is exceeded.</summary>
    public const int MaxEntries = 2000;

    /// <summary>Cached results by key.</summary>
    private static readonly Dictionary<string, string> Entries = [];

    /// <summary>Keys in the order they were first inserted, so the oldest can be evicted first.</summary>
    private static readonly List<string> InsertionOrder = [];

    /// <summary>Guards <see cref="Entries"/> and <see cref="InsertionOrder"/>, and serializes the on-disk save.</summary>
    private static readonly object CacheLock = new();

    /// <summary>Whether <see cref="CachePath"/> has been read yet this run.</summary>
    private static bool Loaded = false;

    /// <summary>Full path to the persisted cache file.</summary>
    public static string CachePath => $"{Program.DataDir}/PromptEnhance/cache.json";

    /// <summary>Builds the cache key for one enhance request: a lowercase SHA256 hex digest of every input
    /// that can change the result. Stable for identical inputs, and changes whenever the prompt, the
    /// resolved profile, the profile-pack version, or the writer model differs.</summary>
    public static string Key(string prompt, string profileId, string packVersion, string writerModel)
    {
        string raw = $"{prompt}|{profileId}|{packVersion}|{writerModel}";
        return Utilities.BytesToHex(SHA256.HashData(raw.EncodeUTF8())).ToLowerFast();
    }

    /// <summary>Loads <see cref="CachePath"/> into memory on first use. Never throws: a missing or
    /// malformed file just leaves the cache empty for this run, which is indistinguishable from a cold
    /// start.</summary>
    private static void EnsureLoaded()
    {
        if (Loaded)
        {
            return;
        }
        lock (CacheLock)
        {
            if (Loaded)
            {
                return;
            }
            try
            {
                if (File.Exists(CachePath))
                {
                    JObject data = JObject.Parse(File.ReadAllText(CachePath));
                    foreach (JProperty property in data.Properties())
                    {
                        string value = property.Value?.Type == JTokenType.String ? property.Value.Value<string>() : null;
                        if (value is not null)
                        {
                            Entries[property.Name] = value;
                            InsertionOrder.Add(property.Name);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Logs.Error($"[PromptEnhance] Could not load cache '{CachePath}': {ex.ReadableString()}");
            }
            Loaded = true;
        }
    }

    /// <summary>Writes the current in-memory cache to <see cref="CachePath"/> as a flat JSON object. Must
    /// be called while holding <see cref="CacheLock"/>.</summary>
    private static void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CachePath));
        JObject data = [];
        foreach (string key in InsertionOrder)
        {
            data[key] = Entries[key];
        }
        File.WriteAllText(CachePath, data.ToString());
    }

    /// <summary>Looks up a previously cached result. Returns false (and leaves <paramref name="result"/>
    /// null) on a miss or on any failure reading the cache; never throws.</summary>
    public static bool TryGet(string key, out string result)
    {
        try
        {
            EnsureLoaded();
            lock (CacheLock)
            {
                return Entries.TryGetValue(key, out result);
            }
        }
        catch (Exception ex)
        {
            Logs.Error($"[PromptEnhance] Cache read failed for key '{key}': {ex.ReadableString()}");
            result = null;
            return false;
        }
    }

    /// <summary>Stores a result under a key, evicting the oldest entry past <see cref="MaxEntries"/>, and
    /// persists the cache to disk. Never throws.</summary>
    public static void Put(string key, string result)
    {
        try
        {
            EnsureLoaded();
            lock (CacheLock)
            {
                if (!Entries.ContainsKey(key))
                {
                    InsertionOrder.Add(key);
                }
                Entries[key] = result;
                while (InsertionOrder.Count > MaxEntries)
                {
                    string oldest = InsertionOrder[0];
                    InsertionOrder.RemoveAt(0);
                    Entries.Remove(oldest);
                }
                Save();
            }
        }
        catch (Exception ex)
        {
            Logs.Error($"[PromptEnhance] Cache write failed for key '{key}': {ex.ReadableString()}");
        }
    }
}
