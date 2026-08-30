using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;

namespace SwarmUI.Builtin_FilenamePrefixExtension;

/// <summary>Fork extension that adds a short user-typed prefix to saved image filenames, for tagging a working session.
/// The parameter is registered here; the actual insertion is done by <see cref="SwarmUI.Accounts.User.BuildImageOutputPath"/>,
/// which looks this parameter up by its string ID (see <see cref="ParamId"/>).</summary>
public class FilenamePrefixExtension : Extension
{
    /// <summary>The registered ID of the filename-prefix parameter, derived from the parameter name below by
    /// <see cref="T2IParamTypes.CleanTypeName(string)"/> (which lowercases and strips non-letters).
    /// COUPLING: <see cref="SwarmUI.Accounts.User.BuildImageOutputPath"/> hardcodes this same string in the fork's
    /// prefix-injection block, and reads it as the '[filenameprefix]' opt-out tag. Renaming the parameter below
    /// silently disables the feature - update that block in src/Accounts/User.cs to match.</summary>
    public const string ParamId = "filenameprefix";

    /// <summary>Maximum characters kept from a user-supplied prefix, matching the spirit of the per-part cap that
    /// <see cref="SwarmUI.Accounts.User.BuildImageOutputPath"/> applies to every filled tag.</summary>
    public const int MaxPrefixLength = 40;

    /// <summary>Parameter group holding the output-naming parameters.</summary>
    public static T2IParamGroup OutputNamingGroup;

    /// <summary>The user-typed prefix applied to the start of the saved image's filename.</summary>
    public static T2IRegisteredParam<string> FilenamePrefix;

    /// <summary>Strips anything that would change the shape of the output path, then length-caps the result.
    /// Returns an empty string for input that is blank or that sanitizes away entirely.
    /// Note the path builder repeats this defensively - it is the actual security boundary, because a role with
    /// 'AllowUnsafeOutpaths' skips the final path clean altogether.</summary>
    public static string SanitizePrefix(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return "";
        }
        // Brackets would be read as outpath tag syntax; slashes would turn a filename prefix into a folder.
        string clean = raw.Replace("[", "").Replace("]", "").Replace('\\', '/').Replace("/", "");
        // Interior dots are kept ('v1.0' stays 'v1.0'); dot runs collapse and edge dots are trimmed, so '..' can never survive.
        // Note the final path clean for roles without 'AllowUnsafeOutpaths' (User.BuildImageOutputPath) still strips every dot - upstream policy for the whole outpath.
        clean = Utilities.StrictFilenameCleanKeepDots(clean).Trim();
        if (clean.Length > MaxPrefixLength)
        {
            int cut = MaxPrefixLength;
            // Never cut between the halves of a surrogate pair - that would emit a lone surrogate.
            if (char.IsHighSurrogate(clean[cut - 1]))
            {
                cut--;
            }
            clean = clean[..cut].Trim();
        }
        return clean;
    }

    /// <summary>Registers the output-naming parameter group and the filename prefix parameter.</summary>
    public override void OnInit()
    {
        // OrderPriority -49 sits immediately after "Core Parameters" (-50). Open and non-advanced deliberately:
        // this is a set-often field, so it must be reachable without opening a group or enabling Advanced Options.
        OutputNamingGroup = new("Output Naming", Toggles: false, Open: true, OrderPriority: -49,
            Description: "Controls how saved files are named. Does not modify your Outpath Format setting.");
        // Clean runs before the IgnoreIf check when a value is set, so a prefix that sanitizes away to nothing is
        // dropped entirely rather than stored as junk - and every entry path (UI, API, preset, metadata) gets
        // sanitized once, server-side, instead of trusting each caller.
        FilenamePrefix = T2IParamTypes.Register<string>(new("Filename Prefix", "Optional short text added to the start of the saved image's filename.\nFor example a prefix of 'OC01' with an outpath format of '[model]/[year][month]' saves as '[model]/OC01[year][month]'.\nApplies no matter which outpath format is active, so it keeps working when a preset overrides the format.\nFor manual placement instead, put a '[filenameprefix]' tag in your outpath format - the automatic insertion is then skipped.\nDoes not affect which folders the image is saved into. Slashes and square brackets are removed, dots are kept except at the start or end, and the text is capped at 40 characters.\nNote: unless your role allows unsafe outpaths, the server's normal output-path cleaning still removes dots from the final filename.",
            "", IgnoreIf: "", Group: OutputNamingGroup, AlwaysRetain: true, Nonreusable: true, OrderPriority: 0, IntentionalUnused: true,
            Clean: (_, val) => SanitizePrefix(val),
            Examples: ["OC01", "session2", "wip"]
            ));
    }
}
