using SwarmUI.Text2Image;

namespace SwarmUI.Builtin_CharacterSheetExtension;

/// <summary>Per-model-family adapters for the character sheet builder.
/// <para>The families differ in two ways that matter here: how many reference images they will actually accept,
/// and whether the prompt can point at a specific one. Both are properties of Swarm's existing workflow
/// generator, not of this extension, so the numbers below are read off that code rather than guessed.</para></summary>
public static class SheetEngines
{
    /// <summary>One model family's sheet-building rules.</summary>
    /// <param name="ID">Stable identifier reported to the frontend.</param>
    /// <param name="Display">Human-readable family name.</param>
    /// <param name="ReferenceCap">Maximum reference images this family will accept in one generation.</param>
    /// <param name="CapReason">Why the cap is what it is, shown in the UI when references are dropped.</param>
    /// <param name="NumberedReferences">True when the prompt can address a specific image by number.</param>
    /// <param name="PrefersOneShot">True when a single generation holding every view beats one generation per view.</param>
    /// <param name="StillFrames">Frame count to force for video models used as image generators, or null for a normal image model.</param>
    public record class SheetEngine(string ID, string Display, int ReferenceCap, string CapReason, bool NumberedReferences, bool PrefersOneShot, int? StillFrames)
    {
        /// <summary>How the prompt should refer to reference image <paramref name="index"/> (zero-based).
        /// <para>MiniMax H3 resolves literal <c>&lt;Picture N&gt;</c> tokens through its text encoder. The edit
        /// models have no such token, so the prompt has to describe the images positionally instead.</para></summary>
        public string ReferencePhrase(int index)
        {
            if (NumberedReferences)
            {
                return $"<Picture {index + 1}>";
            }
            return index switch
            {
                0 => "the first reference image",
                1 => "the second reference image",
                2 => "the third reference image",
                3 => "the fourth reference image",
                _ => $"reference image {index + 1}"
            };
        }
    }

    /// <summary>MiniMax H3 reference model. Nine images per the loop in the Comfy workflow generator, and it is a
    /// video model, so it needs an explicit still-frame count to emit a single image.</summary>
    public static SheetEngine MiniMaxH3 = new("minimax_h3", "MiniMax H3 (reference)", 9,
        "MiniMax H3 accepts up to 9 reference images.", true, true, 2);

    /// <summary>Flux Kontext. References chain as ReferenceLatent nodes with no fixed ceiling; the cap here is a
    /// practical one rather than a hard limit.</summary>
    public static SheetEngine Kontext = new("kontext", "Flux Kontext", 4,
        "Kontext has no hard limit, but more than 4 references tends to muddy the result.", false, false, null);

    /// <summary>Flux.2, same reference chaining as Kontext.</summary>
    public static SheetEngine Flux2 = new("flux2", "Flux.2", 4,
        "Flux.2 has no hard limit, but more than 4 references tends to muddy the result.", false, false, null);

    /// <summary>OmniGen, same reference chaining as Kontext.</summary>
    public static SheetEngine OmniGen = new("omnigen", "OmniGen", 4,
        "OmniGen has no hard limit, but more than 4 references tends to muddy the result.", false, false, null);

    /// <summary>Qwen Image Edit Plus. Hard-capped at three: its text-encode path takes exactly image1/image2/image3.</summary>
    public static SheetEngine QwenImageEditPlus = new("qwen_image_edit_plus", "Qwen Image Edit Plus", 3,
        "Qwen Image Edit Plus accepts exactly 3 reference images - its text encoder has three image slots.", false, false, null);

    /// <summary>Qwen Image Edit (non-Plus), which takes a single reference.</summary>
    public static SheetEngine QwenImageEdit = new("qwen_image_edit", "Qwen Image Edit", 1,
        "Qwen Image Edit takes a single reference image.", false, false, null);

    /// <summary>Anything else. Reference images may do nothing at all, so the UI says so rather than pretending.</summary>
    public static SheetEngine Generic = new("generic", "Other model", 1,
        "This model is not a known edit or reference model, so reference images may have little or no effect.", false, false, null);

    /// <summary>Identifies which family a model belongs to.
    /// <para>Ordering matters: Qwen Image Edit Plus must be tested before plain Qwen Image Edit, since the Plus
    /// class ID starts with the non-Plus one.</para></summary>
    public static SheetEngine Detect(T2IModel model)
    {
        string clazz = model?.ModelClass?.ID;
        string compat = model?.ModelClass?.CompatClass?.ID;
        if (compat == T2IModelClassSorter.CompatMiniMaxH3.ID)
        {
            return MiniMaxH3;
        }
        if (clazz is not null && clazz.StartsWith("qwen-image-edit-plus"))
        {
            return QwenImageEditPlus;
        }
        if (clazz is not null && clazz.StartsWith("qwen-image-edit"))
        {
            return QwenImageEdit;
        }
        if (clazz is not null && clazz.EndsWith("/kontext"))
        {
            return Kontext;
        }
        if (compat is not null && compat.StartsWith("flux-2"))
        {
            return Flux2;
        }
        if (compat is not null && compat.StartsWith("omnigen-"))
        {
            return OmniGen;
        }
        return Generic;
    }
}
