using FreneticUtilities.FreneticExtensions;
using SwarmUI.Utils;

namespace SwarmUI.Text2Image;

/// <summary>Maps Civitai / StabilityMatrix <c>BaseModel</c> strings onto Swarm LoRA class IDs.
/// Swarm has no Illustrious or Pony LoRA class, so those flatten to SDXL plus a usage-hint label.
/// Anima, Krea, Flux, Qwen, and similar families have real LoRA classes and must win over a generic
/// SD1/SDXL tensor guess, which is what the Civitai metadata scan was stamping into headers.</summary>
public static class T2ICivitaiBaseModelMap
{
    /// <summary>LoRA class IDs that are the tensor-sorter fallback, not a real family identity.</summary>
    public static readonly HashSet<string> GenericLoraClassIds =
    [
        "stable-diffusion-v1/lora",
        "stable-diffusion-xl-v1-base/lora",
        "stable-diffusion-v2-768-v/lora"
    ];

    /// <summary>Civitai/SM BaseModel (lowercased) to Swarm LoRA class ID.</summary>
    public static readonly Dictionary<string, string> LoraClassIdsByBaseModel = new()
    {
        ["anima"] = "anima/lora",
        ["illustrious"] = "stable-diffusion-xl-v1-base/lora",
        ["pony"] = "stable-diffusion-xl-v1-base/lora",
        ["noobai"] = "stable-diffusion-xl-v1-base/lora",
        ["sdxl 1.0"] = "stable-diffusion-xl-v1-base/lora",
        ["sd 1.5"] = "stable-diffusion-v1/lora",
        ["krea 2"] = "krea-2/lora",
        ["flux.2 klein 9b"] = "flux.2-klein-9b/lora",
        ["flux.2 klein 9b-base"] = "flux.2-klein-9b/lora",
        ["flux.2 klein 4b"] = "flux.2-klein-4b/lora",
        ["flux.2 klein 4b-base"] = "flux.2-klein-4b/lora",
        ["flux.2 d"] = "flux.2-dev/lora",
        ["flux.1 d"] = "flux.1-dev/lora",
        ["flux.1 kontext"] = "flux.1-dev/lora",
        ["qwen"] = "qwen-image/lora",
        ["wan video 2.2 i2v-a14b"] = "wan-2_1-text2video-14b/lora",
        ["wan video 2.2 t2v-a14b"] = "wan-2_1-text2video-14b/lora",
        ["wan video 14b i2v 720p"] = "wan-2_1-text2video-14b/lora",
        ["wan video 14b i2v 480p"] = "wan-2_1-text2video-14b/lora",
        ["zimageturbo"] = "z-image/lora",
        ["minimax h3"] = "minimax-h3/lora",
        ["ltxv"] = "lightricks-ltx-video-2/lora"
    };

    /// <summary>Family labels Swarm cannot express as a LoRA class, plus Anima (which does have a class,
    /// but the label still belongs in usage_hint so it survives a later SDXL-looking tensor match).</summary>
    public static readonly Dictionary<string, string> UsageHintByBaseModel = new()
    {
        ["anima"] = "Anima",
        ["illustrious"] = "Illustrious",
        ["pony"] = "Pony",
        ["noobai"] = "NoobAI"
    };

    /// <summary>Returns the Swarm LoRA class for a Civitai/SM BaseModel string, or null if unknown.</summary>
    public static T2IModelClass TryGetLoraClass(string baseModel)
    {
        string key = Normalize(baseModel);
        if (key is null)
        {
            return null;
        }
        if (!LoraClassIdsByBaseModel.TryGetValue(key, out string classId))
        {
            return null;
        }
        return T2IModelClassSorter.ModelClasses.GetValueOrDefault(classId.ToLowerFast());
    }

    /// <summary>Usage-hint label for families the class sorter flattens, or null when BaseModel is not one of those.</summary>
    public static string UsageHintFromBaseModel(string baseModel)
    {
        string key = Normalize(baseModel);
        if (key is null)
        {
            return null;
        }
        return UsageHintByBaseModel.GetValueOrDefault(key);
    }

    /// <summary>True when the mapped class should replace the architecture already read from the header.
    /// Specific tensor identities (Anima, Krea, Flux, ...) are kept. Generic SD1/SDXL stamps are not.</summary>
    public static bool ShouldPreferMappedLoraClass(T2IModelClass current, T2IModelClass mapped)
    {
        if (mapped is null)
        {
            return false;
        }
        if (current is null)
        {
            return true;
        }
        if (current.ID.ToLowerFast() == mapped.ID.ToLowerFast())
        {
            return false;
        }
        return IsGenericLoraClass(current);
    }

    /// <summary>True when this class is the SD1/SDXL/SD2 LoRA fallback rather than a named family.</summary>
    public static bool IsGenericLoraClass(T2IModelClass clazz)
    {
        if (clazz?.ID is null)
        {
            return false;
        }
        return GenericLoraClassIds.Contains(clazz.ID.ToLowerFast());
    }

    /// <summary>True when <paramref name="title"/> is empty or is just the file name / stem.</summary>
    public static bool TitleIsFilename(string title, string fileName)
    {
        if (string.IsNullOrWhiteSpace(title))
        {
            return true;
        }
        if (string.IsNullOrWhiteSpace(fileName))
        {
            return false;
        }
        string shortName = fileName.Replace('\\', '/').AfterLast('/');
        string stem = shortName.Contains('.') ? shortName.BeforeLast('.') : shortName;
        return title.Equals(shortName, StringComparison.OrdinalIgnoreCase)
            || title.Equals(stem, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Lowercases and trims a BaseModel string. Null for blank input.</summary>
    public static string Normalize(string baseModel)
    {
        if (string.IsNullOrWhiteSpace(baseModel))
        {
            return null;
        }
        return baseModel.Trim().ToLowerFast();
    }
}
