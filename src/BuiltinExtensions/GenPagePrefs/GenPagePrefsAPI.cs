using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Utils;
using SwarmUI.WebAPI;

namespace SwarmUI.Builtin_GenPagePrefsExtension;

/// <summary>API routes that read and write the Generate tab's batch-view toggles on the user's account.</summary>
public static class GenPagePrefsAPI
{
    /// <summary>Generic-data bucket these preferences live in.</summary>
    public const string DataName = "genpage_prefs";

    /// <summary>Generic-data entry name inside the bucket. One JSON blob rather than an entry per switch: one
    /// read, one write, and no migration step when a switch is added or dropped.</summary>
    public const string StoreName = "batch_toggles";

    /// <summary>The switches this route will store, named by their existing browser-storage keys so the client can
    /// mirror one to the other without a translation table. Anything else in a submitted object is discarded, so a
    /// stale or hostile client cannot use this route as arbitrary per-user storage.</summary>
    public static readonly string[] KnownKeys = ["autoClearBatch", "autoLoadPreviews", "autoLoadImages", "showLoadSpinners", "separateBatches"];

    /// <summary>Registers every route in this class.</summary>
    public static void Register()
    {
        API.RegisterAPICall(GetGenPagePrefs, false, Permissions.ReadUserSettings);
        API.RegisterAPICall(SetGenPagePrefs, true, Permissions.EditUserSettings);
    }

    /// <summary>Returns the stored batch-view toggles. A user who has never saved any gets an empty object rather
    /// than an error or a server-side default: the client already holds core's defaults, and inventing a second
    /// set here would let the two disagree.</summary>
    public static async Task<JObject> GetGenPagePrefs(Session session)
    {
        string raw = session.User.GetGenericData(DataName, StoreName);
        JObject prefs = new();
        if (!string.IsNullOrWhiteSpace(raw))
        {
            try
            {
                prefs = JObject.Parse(raw);
            }
            catch (JsonReaderException ex)
            {
                // Corrupt blob: report defaults rather than failing the page. Logged, because silently discarding
                // a user's saved settings is worth a line in the server log.
                Logs.Warning($"GenPagePrefs: could not parse stored toggles for user {session.User.UserID}, ignoring them: {ex.ReadableString()}");
                prefs = new();
            }
        }
        return new JObject() { ["prefs"] = prefs };
    }

    /// <summary>Stores the batch-view toggles. Filters to <see cref="KnownKeys"/> and coerces each to a bool, so
    /// the stored blob is always exactly the shape the client expects to read back.
    /// <para>The toggles are sent FLAT, not wrapped in a <c>prefs</c> field. A <see cref="JObject"/> API parameter
    /// is handed the whole request payload with <c>session_id</c> stripped (see <c>APICallReflectBuilder</c>), not
    /// the field that happens to share the parameter's name. Nesting them would hand this route an object whose
    /// only key is <c>prefs</c>, every known key would miss, and it would cheerfully store <c>{}</c>.</para></summary>
    public static async Task<JObject> SetGenPagePrefs(Session session,
        [API.APIParameter("The toggles as flat top-level fields, eg `{\"autoLoadPreviews\": true}`.")] JObject prefs)
    {
        JObject clean = new();
        for (int i = 0; i < KnownKeys.Length; i++)
        {
            string key = KnownKeys[i];
            if (prefs is not null && prefs.TryGetValue(key, out JToken value) && (value.Type == JTokenType.Boolean || value.Type == JTokenType.String))
            {
                clean[key] = value.ToString().ToLowerFast() == "true";
            }
        }
        session.User.SaveGenericData(DataName, StoreName, clean.ToString(Formatting.None));
        return new JObject() { ["success"] = true };
    }
}
