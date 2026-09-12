using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using System.IO;
using System.Text.RegularExpressions;

namespace SwarmUI.Builtin_PromptEnhanceExtension;

/// <summary>One per-architecture writer profile: the system prompt that shapes the writer LLM's output for a
/// specific image model, plus the display metadata the frontend needs to offer it.</summary>
/// <param name="ID">Short lowercase identifier, matching the profile asset's filename stem (eg <c>anima</c>).</param>
/// <param name="Display">Human-readable name for the dropdown (eg "FLUX.2 klein 4B").</param>
/// <param name="TargetModel">The pack name this profile is written for, as used in <c>output.schema.json</c>
/// (eg "FLUX.2-klein-4B"). Not necessarily identical to <see cref="Display"/>.</param>
/// <param name="Text">The full non-interactive system prompt, verbatim from the profile asset file.</param>
public record class PromptEnhanceProfile(string ID, string Display, string TargetModel, string Text);

/// <summary>Registry of per-architecture writer profiles, and the selection logic that picks one for a loaded
/// model.
/// <para>The profiles themselves are not this extension's IP - they are authored and graded upstream in the
/// ComfyUI fork's <c>fork_tools/prompt_guides/</c> tree and shipped here as versioned copies. This class only
/// does selection: which profile fits the model that is actually loaded.</para></summary>
public static class PromptEnhanceProfiles
{
    /// <summary>Version string of the shipped profile pack, read verbatim (trimmed) from
    /// <c>Assets/profiles/VERSION</c>. Used in cache keys and provenance so a stale copy of the profiles is
    /// detectable.</summary>
    public static string PackVersion;

    /// <summary>All registered profiles, by <see cref="PromptEnhanceProfile.ID"/>. Public so another extension
    /// can register additional profiles.</summary>
    public static Dictionary<string, PromptEnhanceProfile> Profiles = [];

    /// <summary>Display name for each known profile ID. Filled in alongside <see cref="TargetModels"/> as
    /// profiles are loaded from disk.</summary>
    private static readonly Dictionary<string, string> DisplayNames = new()
    {
        ["anima"] = "Anima",
        ["flux2-klein-4b"] = "FLUX.2 klein 4B",
        ["flux2-klein-9b"] = "FLUX.2 klein 9B",
        ["illustriousxl"] = "IllustriousXL",
        ["krea-2"] = "Krea 2",
        ["qwen-image-edit-2511"] = "Qwen Image Edit 2511"
    };

    /// <summary>Pack name each known profile ID targets, as used in <c>output.schema.json</c>.</summary>
    private static readonly Dictionary<string, string> TargetModels = new()
    {
        ["anima"] = "Anima",
        ["flux2-klein-4b"] = "FLUX.2-klein-4B",
        ["flux2-klein-9b"] = "FLUX.2-klein-9B",
        ["illustriousxl"] = "IllustriousXL",
        ["krea-2"] = "Krea-2",
        ["qwen-image-edit-2511"] = "Qwen-Image-Edit-2511"
    };

    /// <summary>Built-in filename-fragment regex fallback, consulted after <see cref="ConfiguredFilenameOverrides"/>
    /// and before any model-class map. Handles model families that a checkpoint's class ID cannot disambiguate
    /// on its own (eg Illustrious/NoobAI checkpoints outside a configured folder, which sort under the shared
    /// <c>stable-diffusion-xl-v1</c> class). Checked against the model's lowercased <see cref="T2IModel.Name"/>.
    /// Anchored on a word-ish boundary (start of string, or a path/word separator) rather than a bare substring
    /// match, so eg "illustrious" does not also match inside an unrelated longer name.</summary>
    private static readonly (string Pattern, string ProfileID)[] FilenameOverrides =
    [
        (@"(^|[\/_ -])(illustrious|noob)", "illustriousxl")
    ];

    /// <summary>User-editable folder/filename override rules, loaded from <see cref="OverridesConfigPath"/> and
    /// consulted before <see cref="FilenameOverrides"/> in <see cref="Resolve"/> - a checkpoint library
    /// organised by folder (eg <c>ill/</c>, <c>anima/</c>) can map an entire folder to a profile without
    /// depending on any filename convention within it. Populated by <see cref="LoadOverrides"/>.</summary>
    private static readonly List<(Regex Pattern, string ProfileID)> ConfiguredFilenameOverrides = [];

    /// <summary>Full path to the user-editable filename/folder override config file.</summary>
    public static string OverridesConfigPath => $"{Program.DataDir}/PromptEnhance/overrides.json";

    /// <summary>Maps a loaded model's <see cref="T2IModelClass.ID"/> directly to a profile, for classes that
    /// unambiguously identify one writer target on their own.</summary>
    private static readonly Dictionary<string, string> ModelClassMap = new()
    {
        ["qwen-image-edit"] = "qwen-image-edit-2511",
        ["qwen-image-edit-plus"] = "qwen-image-edit-2511"
    };

    /// <summary>Maps a loaded model's <see cref="T2IModelCompatClass.ID"/> to a profile, only for compat
    /// classes that are exactly one architecture wide. Never map <c>qwen-image</c> (spans both edit and non-edit
    /// classes, already covered by <see cref="ModelClassMap"/>) or <c>stable-diffusion-xl-v1</c> (spans
    /// IllustriousXL and vanilla SDXL - the filename override map handles IllustriousXL, and vanilla SDXL has
    /// no profile at all). Anima and Krea 2 each have their own distinct compat class (<c>anima</c>,
    /// <c>krea-2</c>, see <c>T2IModelClassSorter.cs</c>) and so are mapped here directly rather than via a
    /// filename guess.</summary>
    private static readonly Dictionary<string, string> CompatClassMap = new()
    {
        ["flux-2-klein-4b"] = "flux2-klein-4b",
        ["flux-2-klein-9b"] = "flux2-klein-9b",
        ["anima"] = "anima",
        ["krea-2"] = "krea-2"
    };

    /// <summary>Registers a profile. Safe to call from another extension's <c>OnInit</c>.</summary>
    public static void Register(PromptEnhanceProfile profile)
    {
        Profiles[profile.ID] = profile;
    }

    /// <summary>Loads every <c>*.system.md</c> file under <c>Assets/profiles</c> (relative to the owning
    /// extension's own folder) and registers it as a profile, then reads <c>Assets/profiles/VERSION</c> into
    /// <see cref="PackVersion"/>. Call once from the extension's <c>OnInit</c>.</summary>
    public static void Init(Extension owner)
    {
        string dir = $"{owner.FilePath}Assets/profiles";
        string versionPath = $"{dir}/VERSION";
        try
        {
            PackVersion = File.ReadAllText(versionPath).Trim();
        }
        catch (Exception ex)
        {
            Logs.Error($"[PromptEnhance] Failed to read profile pack version from '{versionPath}': {ex.ReadableString()}");
            PackVersion = "(unknown)";
        }
        int loaded = 0;
        foreach (string file in Directory.EnumerateFiles(dir, "*.system.md"))
        {
            string fileName = Path.GetFileName(file);
            string id = fileName[..^".system.md".Length];
            try
            {
                string text = File.ReadAllText(file);
                string display = DisplayNames.GetValueOrDefault(id) ?? id;
                string targetModel = TargetModels.GetValueOrDefault(id) ?? id;
                Register(new(id, display, targetModel, text));
                loaded++;
            }
            catch (Exception ex)
            {
                Logs.Error($"[PromptEnhance] Failed to read profile '{file}': {ex.ReadableString()}");
            }
        }
        Logs.Init($"[PromptEnhance] Loaded {loaded} writer profile(s), pack version {PackVersion}");
        LoadOverrides();
    }

    /// <summary>Loads <see cref="ConfiguredFilenameOverrides"/> from <see cref="OverridesConfigPath"/>, writing
    /// a default config file (the shipped folder-based Illustrious/Anima mapping) on first run. Never throws:
    /// a missing or malformed file leaves the list empty, and a single malformed regex pattern within an
    /// otherwise-valid file is logged and skipped rather than discarding every other entry. Public (like
    /// <see cref="PromptEnhanceEndpoints.Init"/>) so it can be re-run against a redirected config path.</summary>
    public static void LoadOverrides()
    {
        ConfiguredFilenameOverrides.Clear();
        try
        {
            string path = OverridesConfigPath;
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            if (!File.Exists(path))
            {
                File.WriteAllText(path, BuildDefaultOverridesConfig().ToString(Formatting.Indented));
            }
            JObject data = JObject.Parse(File.ReadAllText(path));
            if (data["overrides"] is JArray array)
            {
                foreach (JToken token in array)
                {
                    if (token is not JObject entry)
                    {
                        continue;
                    }
                    string pattern = entry.Value<string>("pattern");
                    string profileId = entry.Value<string>("profile");
                    if (string.IsNullOrWhiteSpace(pattern) || string.IsNullOrWhiteSpace(profileId))
                    {
                        continue;
                    }
                    try
                    {
                        Regex regex = new(pattern);
                        ConfiguredFilenameOverrides.Add((regex, profileId));
                    }
                    catch (Exception ex)
                    {
                        Logs.Error($"[PromptEnhance] Override config has an invalid regex pattern '{pattern}': {ex.ReadableString()} - skipping it.");
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Logs.Error($"[PromptEnhance] Could not load override config '{OverridesConfigPath}': {ex.ReadableString()}");
        }
    }

    /// <summary>Builds the default override config written on first run: the shipped folder-based mapping for
    /// the fork owner's IllustriousXL and Anima checkpoint folders.</summary>
    private static JObject BuildDefaultOverridesConfig()
    {
        return new JObject()
        {
            ["_comment"] = "User-editable folder/filename overrides, consulted before the built-in Illustrious/NoobAI filename fallback. 'pattern' is a regex matched against the model's lowercased, subfolder-relative name (eg 'ill/Auralis_v3.safetensors' starts with 'ill/'). A malformed pattern is logged and skipped rather than disabling the rest of the file.",
            ["overrides"] = new JArray()
            {
                new JObject() { ["pattern"] = "^ill/", ["profile"] = "illustriousxl" },
                new JObject() { ["pattern"] = "^anima/", ["profile"] = "anima" }
            }
        };
    }

    /// <summary>Picks the profile to use for the given loaded model.
    /// <para>Resolution order: an explicit <paramref name="manualOverride"/> naming a known profile wins over
    /// everything; then the user-editable <see cref="ConfiguredFilenameOverrides"/> folder/filename map; then
    /// the built-in <see cref="FilenameOverrides"/> filename fallback (for classes a checkpoint's own class ID
    /// cannot disambiguate); then the model's own class ID; then its compat class ID; then no profile at all,
    /// with a human-readable reason. A non-empty <paramref name="manualOverride"/> that names no known profile
    /// is a hard miss - it does not fall through to automatic selection.</para></summary>
    /// <param name="model">The currently loaded T2I model, or null if none is loaded.</param>
    /// <param name="manualOverride">A user-specified profile ID to force, or null/empty for automatic
    /// selection.</param>
    /// <param name="reason">Set to a human-readable explanation when no profile could be resolved; left null
    /// otherwise.</param>
    public static PromptEnhanceProfile Resolve(T2IModel model, string manualOverride, out string reason)
    {
        reason = null;
        if (!string.IsNullOrWhiteSpace(manualOverride))
        {
            if (Profiles.TryGetValue(manualOverride, out PromptEnhanceProfile forced))
            {
                return forced;
            }
            reason = $"Unknown profile override '{manualOverride}'";
            return null;
        }
        if (model is null)
        {
            reason = "No model selected";
            return null;
        }
        string lowerName = (model.Name ?? "").ToLowerFast();
        for (int i = 0; i < ConfiguredFilenameOverrides.Count; i++)
        {
            (Regex pattern, string profileId) = ConfiguredFilenameOverrides[i];
            if (pattern.IsMatch(lowerName) && Profiles.TryGetValue(profileId, out PromptEnhanceProfile byConfig))
            {
                return byConfig;
            }
        }
        for (int i = 0; i < FilenameOverrides.Length; i++)
        {
            (string pattern, string profileId) = FilenameOverrides[i];
            if (Regex.IsMatch(lowerName, pattern) && Profiles.TryGetValue(profileId, out PromptEnhanceProfile byName))
            {
                return byName;
            }
        }
        string classId = model.ModelClass?.ID;
        if (!string.IsNullOrWhiteSpace(classId) && ModelClassMap.TryGetValue(classId, out string classProfileId) && Profiles.TryGetValue(classProfileId, out PromptEnhanceProfile byClass))
        {
            return byClass;
        }
        string compatId = model.ModelClass?.CompatClass?.ID;
        if (!string.IsNullOrWhiteSpace(compatId) && CompatClassMap.TryGetValue(compatId, out string compatProfileId) && Profiles.TryGetValue(compatProfileId, out PromptEnhanceProfile byCompat))
        {
            return byCompat;
        }
        reason = $"No writer profile for model class '{classId ?? compatId ?? "unknown"}'";
        return null;
    }
}
