using SwarmUI.Accounts;
using SwarmUI.Core;

namespace SwarmUI.Builtin_CharacterSheetExtension;

/// <summary>Fork-owned extension that builds multi-view character reference sheets from a set of reference images.
/// <para>Inspired by the two-stage MiniMax H3 character-sheet ComfyUI workflows going around, but built on what
/// Swarm already has rather than on third-party nodes: H3's reference model, its nine-image prompt-image channel,
/// and its still-image frame handling are all native here, so the only genuinely missing pieces were prompt
/// templating, fanning several generations out of one request, and compositing the result.</para>
/// <para>Model-agnostic on purpose. H3 gives the best cross-view coherence, but Kontext, Flux.2, OmniGen and Qwen
/// Image Edit all work through the same reference-image channel, so the tool adapts its reference slot count and
/// default mode to whichever model is loaded rather than demanding a 33B install.</para>
/// <para>Everything ships as new files so upstream merges stay clean. Zero core-file edits.</para></summary>
public class CharacterSheetExtension : Extension
{
    /// <summary>Permission to build character sheets.
    /// <para>Defaults to USER and sits in the user group: a sheet is several ordinary image generations, already
    /// budgeted through the same generation claim, so it grants nothing image generation does not.</para></summary>
    public static PermInfo PermUseCharacterSheet = Permissions.Register(new("charactersheet_use", "[Character Sheet] Build Character Sheets",
        "Allows using the Character Sheet tool to generate multi-view reference sheets.", PermissionDefault.USER, Permissions.GroupUser, PermSafetyLevel.SAFE));

    /// <inheritdoc/>
    public override void OnPreInit()
    {
        ScriptFiles.Add("Assets/charsheet.js");
        StyleSheetFiles.Add("Assets/charsheet.css");
    }

    /// <inheritdoc/>
    public override void OnInit()
    {
        CharacterSheetAPI.Register();
    }
}
