using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Builtin_ComfyUIBackend;
using SwarmUI.Core;
using SwarmUI.Utils;

namespace SwarmUI.Builtin_InterrogateExtension;

/// <summary>Registry of image-interrogation backends, and the ComfyUI workflows that drive them.
/// <para>A backend is just a recipe for turning one base64 image into one string. Each one names the ComfyUI
/// feature flag its nodes come from, so the API can hide backends whose node pack is not installed rather than
/// letting the user pick something that will fail at execution time.</para></summary>
public static class InterrogateBackends
{
    /// <summary>Metadata key every interrogation workflow reports its text under.
    /// <para>Must survive <c>CustomMetaKeyCleaner</c> in <see cref="ComfyUIAPIAbstractBackend"/>, which strips
    /// everything but letters and underscores, so keep it plain lowercase.</para></summary>
    public const string ResultKey = "interrogate";

    /// <summary>One registered way to turn an image into text.</summary>
    /// <param name="ID">Short lowercase identifier, used as the API value and the stored user preference.</param>
    /// <param name="Display">Human-readable name for the dropdown.</param>
    /// <param name="Description">One-line explanation shown under the dropdown.</param>
    /// <param name="FeatureFlag">ComfyUI feature ID that must be present for this backend to work.</param>
    /// <param name="InstallFeatureID">Installable-feature ID offered when <see cref="FeatureFlag"/> is missing, or null if it cannot be auto-installed.</param>
    /// <param name="OutputKind">Either <c>tags</c> (comma-separated booru tags) or <c>prose</c> (a natural-language caption). Drives how the frontend renders the result.</param>
    /// <param name="BuildWorkflow">Builds the raw ComfyUI API-format workflow for one image. Takes the base64 image and the user's options blob.</param>
    public record class InterrogateBackend(string ID, string Display, string Description, string FeatureFlag, string InstallFeatureID, string OutputKind, Func<string, JObject, JObject> BuildWorkflow);

    /// <summary>All registered backends, by ID. Other extensions may add to this.</summary>
    public static Dictionary<string, InterrogateBackend> Backends = [];

    /// <summary>Registers a new interrogation backend. Safe to call from another extension's <c>OnInit</c>.</summary>
    public static void Register(InterrogateBackend backend)
    {
        Backends[backend.ID] = backend;
    }

    /// <summary>Model names offered by the WD14 tagger node on the connected backend, newest read wins.
    /// <para>Read from the live <c>object_info</c> rather than hardcoded, because the node's list grows with
    /// whatever ONNX files the user has actually downloaded, and a hardcoded name that is not in the enum fails
    /// Comfy's input validation before the job ever runs.</para></summary>
    public static volatile string[] WD14Models = [];

    /// <summary>ComfyUI node class ID for the WD14 tagger.</summary>
    public const string WD14NodeID = "WD14Tagger|pysssss";

    /// <summary>Feature flag mapped to <see cref="WD14NodeID"/>.</summary>
    public const string WD14Feature = "wd14tagger";

    /// <summary>Registers the built-in backends, the node-to-feature mapping, and the installable node packs.
    /// <para>Everything here mutates public static collections that the Comfy extension exposes for exactly this
    /// purpose, so no core file needs editing.</para></summary>
    public static void Init()
    {
        ComfyUIBackendExtension.NodeToFeatureMap[WD14NodeID] = WD14Feature;
        InstallableFeatures.RegisterInstallableFeature(new("WD14 Tagger", WD14Feature, "https://github.com/pythongosssss/ComfyUI-WD14-Tagger", "pythongosssss"));
        ComfyUIBackendExtension.RawObjectInfoParsers.Add(rawObjectInfo =>
        {
            if (ComfyUIBackendExtension.TryGetRequiredInputs(rawObjectInfo, WD14NodeID, "model", out JToken models))
            {
                WD14Models = [.. models.Select(m => $"{m}")];
            }
        });
        Register(new(WD14Feature, "WD14 Tagger", "Booru-style comma-separated tags. Fast, small, ideal for prompt reuse and dataset captioning.", WD14Feature, WD14Feature, "tags", BuildWD14Workflow));
    }

    /// <summary>Picks the WD14 model to run: the user's choice when it is actually available on the backend,
    /// otherwise the standard default, otherwise whatever the backend does have.</summary>
    public static string ResolveWD14Model(string requested)
    {
        string[] available = WD14Models;
        if (!string.IsNullOrWhiteSpace(requested) && available.Contains(requested))
        {
            return requested;
        }
        string standard = available.FirstOrDefault(m => m.StartsWith("wd-v1-4-moat-tagger-v2"));
        return standard ?? available.FirstOrDefault() ?? "wd-v1-4-moat-tagger-v2.onnx";
    }

    /// <summary>Builds the WD14 tagger workflow: load the image, tag it, ship the string back over the websocket.</summary>
    public static JObject BuildWD14Workflow(string imageB64, JObject options)
    {
        SpokeModePolicy.AssertModelTreeWriteAllowed("run an auto-downloading WD14 model loader");
        return new JObject()
        {
            ["1"] = new JObject()
            {
                ["class_type"] = "SwarmLoadImageB64",
                ["inputs"] = new JObject() { ["image_base64"] = imageB64 }
            },
            ["2"] = new JObject()
            {
                ["class_type"] = WD14NodeID,
                ["inputs"] = new JObject()
                {
                    ["image"] = new JArray() { "1", 0 },
                    ["model"] = ResolveWD14Model($"{options?["model"]}"),
                    ["threshold"] = options?["threshold"]?.Value<double>() ?? 0.35,
                    ["character_threshold"] = options?["character_threshold"]?.Value<double>() ?? 0.85,
                    // Underscores are how the tagger's own vocabulary spells multi-word tags, but prompts want
                    // spaces, and TagDex indexes the spaced form. Default this on where the node defaults it off.
                    ["replace_underscore"] = options?["replace_underscore"]?.Value<bool>() ?? true,
                    ["trailing_comma"] = options?["trailing_comma"]?.Value<bool>() ?? false,
                    ["exclude_tags"] = $"{options?["exclude_tags"]}"
                }
            },
            ["3"] = new JObject()
            {
                ["class_type"] = "SwarmAddSaveMetadataWS",
                ["inputs"] = new JObject()
                {
                    ["key"] = ResultKey,
                    ["value"] = new JArray() { "2", 0 }
                }
            }
        };
    }

    /// <summary>Lists the backends usable right now, ie those whose feature flag a running backend reports.</summary>
    public static IEnumerable<InterrogateBackend> AvailableBackends()
    {
        HashSet<string> features = Program.Backends.GetAllSupportedFeatures();
        return Backends.Values.Where(b => features.Contains(b.FeatureFlag));
    }
}
