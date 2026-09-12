using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Text2Image;

namespace SwarmUI.Builtin_PromptEnhanceExtension;

/// <summary>Fork-owned extension that rewrites the user's typed idea into a prompt shaped for the currently
/// loaded image model, using a local writer LLM reached from the hub over HTTP. See
/// <c>docs/PromptEnhance-Design.md</c>.
/// <para>Selection and transport only - the per-architecture writer profiles are authored and graded upstream
/// in the ComfyUI fork's <c>fork_tools/prompt_guides/</c> tree and shipped here as versioned copies. Everything
/// ships as new files so upstream merges stay clean: zero core-file edits.</para></summary>
public class PromptEnhanceExtension : Extension
{
    /// <summary>Permission to send a prompt to the configured local writer model for rewriting. Defaults to
    /// USER: it is no more sensitive than a normal generation request, just routed to a different local
    /// backend.</summary>
    public static PermInfo PermUsePromptEnhance = Permissions.Register(new("prompt_enhance_use", "[Prompt Enhance] Enhance Prompts",
        "Allows sending a prompt to the configured local writer model for rewriting.", PermissionDefault.USER, Permissions.GroupUser, PermSafetyLevel.SAFE));

    /// <inheritdoc/>
    public override void OnPreInit()
    {
        ScriptFiles.Add("Assets/promptenhance.js");
        StyleSheetFiles.Add("Assets/promptenhance.css");
    }

    /// <inheritdoc/>
    public override void OnInit()
    {
        PromptEnhanceProfiles.Init(this);
        PromptEnhanceEndpoints.Init();
        PromptEnhanceAPI.Register();
        // Hidden provenance param: records what enhancement (if any) produced the prompt this generation used.
        // VisibleNormally: false routes it into the hidden inputs area (still built and readable by JS) rather
        // than the main params list; it is still written to image metadata, since T2IParamInput.GenParameterMetadata
        // only skips a param when HideFromMetadata is set, not for VisibleNormally alone. No server code ever
        // calls Get() on this param (JS writes it directly), so it is never added to ParamsQueried; without
        // IntentionalUnused: true, T2IParamInput.GenFullMetadataObject would strip it back out of the metadata
        // it exists to populate, as an "unused parameter".
        T2IParamTypes.Register<string>(new("Prompt Enhance Provenance",
            "Internal: JSON record of the prompt enhancement applied to this generation.", "",
            Toggleable: false, VisibleNormally: false, Nonreusable: true, IntentionalUnused: true));
    }
}
