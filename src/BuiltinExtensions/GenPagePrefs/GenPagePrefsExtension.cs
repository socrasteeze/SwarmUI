using SwarmUI.Core;

namespace SwarmUI.Builtin_GenPagePrefsExtension;

/// <summary>Fork-owned extension that stores the Generate tab's batch-view toggles on the user's account instead
/// of leaving them in browser storage.
/// <para>Core keeps those six switches in <c>localStorage</c> (<c>currentimagehandler.js</c> reads each key back
/// into <c>.checked</c> at script time). Browser storage is per-origin and is wiped by any "clear site data on
/// exit" setting, so the same user reaches the same server over a second address, or simply closes the browser,
/// and the switches read as defaults again. Account storage follows the user instead of the browser profile.</para>
/// <para>Zero core-file edits. The script attaches to the existing checkboxes after session-ready, which lands
/// after core's own script-time read, so the stored value wins without core needing to know this exists.</para></summary>
public class GenPagePrefsExtension : Extension
{
    /// <inheritdoc/>
    public override void OnPreInit()
    {
        ScriptFiles.Add("Assets/genpage_prefs.js");
    }

    /// <inheritdoc/>
    public override void OnInit()
    {
        GenPagePrefsAPI.Register();
    }
}
