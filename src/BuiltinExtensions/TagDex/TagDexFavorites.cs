using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Utils;
using SwarmUI.WebAPI;

namespace SwarmUI.Builtin_TagDexExtension;

/// <summary>Per-user TagDex favorites, stored as canonical <c>source:name</c> keys in one generic-data blob.
/// <para>The booru slug is the identity on both TagDex and AnimaDex. Filenames are deliberately excluded: their
/// sanitization rules are a storage detail and cannot be a stable join key.</para></summary>
public static class TagDexFavorites
{
    /// <summary>Generic-data namespace shared with the TagDex preferences blob.</summary>
    public const string DataName = "tagdex";

    /// <summary>Generic-data item name for the favorites array.</summary>
    public const string StoreName = "favorites";

    /// <summary>Builds the canonical stored key for one entry.</summary>
    public static string Key(string source, string name)
    {
        return $"{source}:{name}";
    }

    /// <summary>Loads a user's favorites. Missing or malformed data is treated as an empty set.</summary>
    public static HashSet<string> For(Session session)
    {
        HashSet<string> favorites = new(StringComparer.Ordinal);
        try
        {
            string raw = session.User.GetGenericData(DataName, StoreName);
            if (string.IsNullOrWhiteSpace(raw))
            {
                return favorites;
            }
            JArray data = JArray.Parse(raw);
            foreach (JToken token in data)
            {
                string key = $"{token}";
                if (!string.IsNullOrWhiteSpace(key))
                {
                    favorites.Add(key);
                }
            }
        }
        catch (Exception ex)
        {
            Logs.Debug($"[TagDex] Could not read favorites for '{session.User.UserID}', using an empty set: {ex.ReadableString()}");
        }
        return favorites;
    }

    /// <summary>Returns the favorited entry names belonging to one source.</summary>
    public static HashSet<string> ForSource(HashSet<string> favorites, string source)
    {
        HashSet<string> names = new(StringComparer.Ordinal);
        string prefix = $"{source}:";
        foreach (string key in favorites)
        {
            if (key.StartsWithFast(prefix) && key.Length > prefix.Length)
            {
                names.Add(key[prefix.Length..]);
            }
        }
        return names;
    }

    /// <summary>Saves a user's complete favorites set in deterministic order.</summary>
    public static void Save(Session session, HashSet<string> favorites)
    {
        JArray data = new(favorites.OrderBy(key => key, StringComparer.Ordinal));
        session.User.SaveGenericData(DataName, StoreName, data.ToString(Formatting.None));
    }

    /// <summary>Returns whether one canonical entry is favorited in a preloaded set.</summary>
    public static bool IsFavorite(HashSet<string> favorites, string source, string name)
    {
        return favorites.Contains(Key(source, name));
    }

    /// <summary>Atomically toggles one favorite for a user and returns the new state.</summary>
    public static bool Toggle(Session session, string source, string name)
    {
        lock (session.User)
        {
            HashSet<string> favorites = For(session);
            string key = Key(source, name);
            bool favorited;
            if (favorites.Remove(key))
            {
                favorited = false;
            }
            else
            {
                favorites.Add(key);
                favorited = true;
            }
            Save(session, favorites);
            return favorited;
        }
    }

    /// <summary>Atomically sets one favorite to a desired state. Returns whether stored state changed.</summary>
    public static bool Set(Session session, string source, string name, bool favorited)
    {
        lock (session.User)
        {
            HashSet<string> favorites = For(session);
            string key = Key(source, name);
            bool changed = favorited ? favorites.Add(key) : favorites.Remove(key);
            if (changed)
            {
                Save(session, favorites);
            }
            return changed;
        }
    }
}

public partial class TagDexExtension
{
    /// <summary>API route: toggles one per-user favorite and optionally relays the new state to AnimaDex.</summary>
    [API.APIDescription("Toggles one TagDex favorite for the caller.", "\"success\": true, \"favorited\": true")]
    public async Task<JObject> TagDexToggleFavorite(Session session,
        [API.APIParameter("Dataset ID.")] string source,
        [API.APIParameter("Canonical booru entry slug.")] string name,
        [API.APIParameter("Desired state for an idempotent relay, or empty to toggle interactively.")] string favorited = "",
        [API.APIParameter("Whether to relay the change to AnimaDex. False breaks an inbound relay loop.")] bool syncBack = true)
    {
        TagDexList list = TagDexData.EnsureLoaded(source);
        name = name?.Trim();
        if (list is null)
        {
            return new JObject() { ["error"] = $"Dataset '{source}' is not downloaded yet." };
        }
        if (string.IsNullOrWhiteSpace(name) || !list.ByName.ContainsKey(name))
        {
            return new JObject() { ["error"] = $"Unknown entry '{name}' in dataset '{source}'." };
        }
        bool finalState;
        if (!string.IsNullOrWhiteSpace(favorited))
        {
            if (!bool.TryParse(favorited, out finalState))
            {
                return new JObject() { ["error"] = "Favorite state must be true or false." };
            }
            TagDexFavorites.Set(session, source, name, finalState);
        }
        else
        {
            finalState = TagDexFavorites.Toggle(session, source, name);
        }
        if (syncBack)
        {
            TagDexAnimaDex.PushFavoriteAsync(source, name, finalState);
        }
        return new JObject() { ["success"] = true, ["favorited"] = finalState };
    }

    /// <summary>API route: lists the caller's favorited slugs for one dataset.</summary>
    [API.APIDescription("Lists the caller's TagDex favorites for one dataset.", "\"favorites\": [\"hatsune_miku\"]")]
    public async Task<JObject> TagDexListFavorites(Session session,
        [API.APIParameter("Dataset ID.")] string source)
    {
        if (TagDexData.SourceFor(source) is null)
        {
            return new JObject() { ["error"] = $"Unknown dataset '{source}'." };
        }
        HashSet<string> names = TagDexFavorites.ForSource(TagDexFavorites.For(session), source);
        return new JObject() { ["favorites"] = new JArray(names.OrderBy(name => name, StringComparer.Ordinal)) };
    }

    /// <summary>API route: unions the caller's local favorites with the configured AnimaDex instance.</summary>
    [API.APIDescription("Reconciles TagDex and AnimaDex favorites by union.", "\"success\": true, \"total\": 42")]
    public async Task<JObject> TagDexReconcileFavorites(Session session,
        [API.APIParameter("Dataset ID. Only danbooru character and artist datasets have AnimaDex counterparts.")] string source)
    {
        return await TagDexAnimaDex.ReconcileFavoritesAsync(session, source);
    }
}
