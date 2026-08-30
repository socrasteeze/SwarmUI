using SwarmUI.Accounts;
using SwarmUI.Core;

namespace SwarmUI.Builtin_InterrogateExtension;

/// <summary>Fork-owned extension adding image interrogation - drop in an image, get back booru tags or a
/// descriptive prompt.
/// <para>Swarm has no image-to-text feature of its own; the LLM subsystem under <c>src/LLMs</c> is an explicit
/// placeholder with no vision input at all. Rather than build a second model runtime, this drives the ComfyUI
/// backend that is already running, using the existing <c>SwarmLoadImageB64</c> input node and the
/// <c>SwarmAddSaveMetadataWS</c> text-return channel.</para>
/// <para>Everything ships as new files so upstream merges stay clean. Zero core-file edits: the node-to-feature
/// map, the installable-feature registry, and the object_info parser list are all public static collections that
/// the Comfy extension exposes for extensions to append to.</para></summary>
public class InterrogateExtension : Extension
{
    /// <summary>Permission to interrogate an image. Defaults to USER: it reads one image the user can already
    /// see and spends a few seconds of an already-running backend, which is no more than a normal generation.</summary>
    public static PermInfo PermUseInterrogate = Permissions.Register(new("interrogate_use", "[Interrogate] Interrogate Images",
        "Allows generating tags or a text prompt from an image.", PermissionDefault.USER, Permissions.GroupUser, PermSafetyLevel.SAFE));

    /// <inheritdoc/>
    public override void OnPreInit()
    {
        ScriptFiles.Add("Assets/interrogate.js");
        StyleSheetFiles.Add("Assets/interrogate.css");
    }

    /// <inheritdoc/>
    public override void OnInit()
    {
        InterrogateBackends.Init();
        InterrogateAPI.Register();
    }
}
