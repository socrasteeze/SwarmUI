using NUnit.Framework;
using SwarmUI.WebAPI;

namespace SwarmUITests;

/// <summary>Tests the Image History browser's folder hiding (the 'HiddenHistoryFolders' user setting), as parsed by
/// <see cref="T2IAPI.ParseHiddenFolders(string)"/> and matched against the path built by
/// <see cref="T2IAPI.JoinHistoryPath(string[])"/>. A bare entry must still only hide a top-level folder, while a path
/// entry hides a nested scratch dir such as the Comfy input mapping at 'inputs/_comfy0'.</summary>
[TestFixture]
public class HiddenHistoryFolderTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>A blank setting hides nothing.</summary>
    [Test]
    public static void ParseHiddenFolders_Blank()
    {
        Assert.That(T2IAPI.ParseHiddenFolders(""), Is.Empty);
        Assert.That(T2IAPI.ParseHiddenFolders(null), Is.Empty);
    }

    /// <summary>Entries are split on commas, trimmed, and normalized to forward slashes without surrounding slashes.</summary>
    [Test]
    public static void ParseHiddenFolders_NormalizesEntries()
    {
        Assert.That(T2IAPI.ParseHiddenFolders(" _comfy0 , inputs\\_comfy0/ ,, /VNCCS"),
            Is.EquivalentTo(new[] { "_comfy0", "inputs/_comfy0", "VNCCS" }));
    }

    /// <summary>Matching ignores case, as the setting documents.</summary>
    [Test]
    public static void ParseHiddenFolders_CaseInsensitive()
    {
        Assert.That(T2IAPI.ParseHiddenFolders("Inputs/_Comfy0").Contains("inputs/_comfy0"), Is.True);
    }

    /// <summary>A bare entry matches the top-level folder only - a same-named folder deeper in the tree stays visible.</summary>
    [Test]
    public static void BareEntry_HidesOnlyTopLevel()
    {
        System.Collections.Generic.HashSet<string> hidden = T2IAPI.ParseHiddenFolders("_comfy0");
        Assert.That(hidden.Contains(T2IAPI.JoinHistoryPath("", "", "_comfy0")), Is.True);
        Assert.That(hidden.Contains(T2IAPI.JoinHistoryPath("", "inputs", "_comfy0")), Is.False);
        Assert.That(hidden.Contains(T2IAPI.JoinHistoryPath("inputs", "", "_comfy0")), Is.False);
    }

    /// <summary>A path entry hides that nested folder, whether the walk reaches it from the output root or from inside
    /// the folder being browsed, and leaves the same-named top-level folder visible.</summary>
    [Test]
    public static void PathEntry_HidesNestedFolder()
    {
        System.Collections.Generic.HashSet<string> hidden = T2IAPI.ParseHiddenFolders("inputs/_comfy0");
        Assert.That(hidden.Contains(T2IAPI.JoinHistoryPath("", "inputs", "_comfy0")), Is.True);
        Assert.That(hidden.Contains(T2IAPI.JoinHistoryPath("inputs", "", "_comfy0")), Is.True);
        Assert.That(hidden.Contains(T2IAPI.JoinHistoryPath("", "", "_comfy0")), Is.False);
    }

    /// <summary>The shared special-folder keys ('inputs/_comfy0/') are matched after the same normalization.</summary>
    [Test]
    public static void SpecialFolderKey_MatchesAfterTrim()
    {
        System.Collections.Generic.HashSet<string> hidden = T2IAPI.ParseHiddenFolders("inputs/_comfy0,_comfy0");
        Assert.That(hidden.Contains("inputs/_comfy0/".Replace('\\', '/').Trim('/')), Is.True);
        Assert.That(hidden.Contains("_comfy0/".Replace('\\', '/').Trim('/')), Is.True);
    }
}
