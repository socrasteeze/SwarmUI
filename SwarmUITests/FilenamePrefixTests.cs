using NUnit.Framework;
using SwarmUI.Accounts;
using SwarmUI.Builtin_FilenamePrefixExtension;
using SwarmUI.Text2Image;

namespace SwarmUITests;

/// <summary>Tests <see cref="FilenamePrefixExtension.SanitizePrefix(string)"/> and <see cref="User.InsertFilenamePrefix(string, string, int)"/>,
/// the two pieces of the FilenamePrefix feature's insertion + sanitization logic. This recovers, as real executable tests, the 13 cases the
/// original fork work only simulated statically (no .NET SDK was available in that authoring environment) - see the FilenamePrefix entry in
/// AGENTS.md's Fork Delta for the case list: no-slash format, trailing slash, '[number]' interaction, a prefix containing '/'/'['/'.',
/// a 200-char prefix, 'MaxLenPerPart = 0', and a truncation boundary landing mid-surrogate-pair - plus the explicit-tag opt-out and the
/// empty-after-sanitize case. Also covers the two fixes made alongside these tests: interior dots surviving the sanitizer, and an explicit
/// '[filenameprefix]' tag being recognized under every spelling that resolves.</summary>
[TestFixture]
public class FilenamePrefixTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    // ---- FilenamePrefixExtension.SanitizePrefix ----

    /// <summary>Case 1: a plain prefix passes through untouched.</summary>
    [Test]
    public static void TestSanitizePrefix_Plain()
    {
        Assert.That(FilenamePrefixExtension.SanitizePrefix("OC01"), Is.EqualTo("OC01"));
    }

    /// <summary>Case 2: blank/whitespace-only input sanitizes to empty.</summary>
    [Test]
    public static void TestSanitizePrefix_Blank()
    {
        Assert.That(FilenamePrefixExtension.SanitizePrefix(""), Is.EqualTo(""));
        Assert.That(FilenamePrefixExtension.SanitizePrefix("   "), Is.EqualTo(""));
        Assert.That(FilenamePrefixExtension.SanitizePrefix(null), Is.EqualTo(""));
    }

    /// <summary>Case 3: a prefix containing '/' has the slash stripped, not turned into a folder.</summary>
    [Test]
    public static void TestSanitizePrefix_Slash()
    {
        Assert.That(FilenamePrefixExtension.SanitizePrefix("a/b"), Is.EqualTo("ab"));
        Assert.That(FilenamePrefixExtension.SanitizePrefix("a\\b"), Is.EqualTo("ab"));
    }

    /// <summary>Case 4: a prefix containing '[' or ']' has the brackets stripped, so it cannot be read as outpath tag syntax.</summary>
    [Test]
    public static void TestSanitizePrefix_Brackets()
    {
        Assert.That(FilenamePrefixExtension.SanitizePrefix("a[b]c"), Is.EqualTo("abc"));
        Assert.That(FilenamePrefixExtension.SanitizePrefix("[filenameprefix]"), Is.EqualTo("filenameprefix"));
    }

    /// <summary>Case 5 (fix): a prefix containing an interior '.' keeps it - 'v1.0' must not become 'v10'.</summary>
    [Test]
    public static void TestSanitizePrefix_KeepsInteriorDot()
    {
        Assert.That(FilenamePrefixExtension.SanitizePrefix("v1.0"), Is.EqualTo("v1.0"));
    }

    /// <summary>Case 6: leading/trailing dots are trimmed and '..' runs collapse, so traversal-shaped input cannot survive.</summary>
    [Test]
    public static void TestSanitizePrefix_RejectsTraversalAndEdgeDots()
    {
        Assert.That(FilenamePrefixExtension.SanitizePrefix(".hidden."), Is.EqualTo("hidden"));
        Assert.That(FilenamePrefixExtension.SanitizePrefix("..").Contains(".."), Is.False);
        Assert.That(FilenamePrefixExtension.SanitizePrefix(".."), Is.EqualTo(""));
    }

    /// <summary>Case 7: a 200-character prefix is capped to the documented 40-character max.</summary>
    [Test]
    public static void TestSanitizePrefix_LongPrefixTruncates()
    {
        string longPrefix = new('a', 200);
        string result = FilenamePrefixExtension.SanitizePrefix(longPrefix);
        Assert.That(result.Length, Is.EqualTo(FilenamePrefixExtension.MaxPrefixLength));
        Assert.That(result, Is.EqualTo(new string('a', FilenamePrefixExtension.MaxPrefixLength)));
    }

    /// <summary>Case 8: truncation never splits a surrogate pair - it backs off one extra character rather than emit a lone surrogate.</summary>
    [Test]
    public static void TestSanitizePrefix_TruncationAvoidsSurrogateSplit()
    {
        // U+1F600 (an emoji) is a surrogate pair in UTF-16. Place it so the cap would otherwise land in the middle of it.
        string emoji = "\U0001F600";
        string prefix = new string('a', FilenamePrefixExtension.MaxPrefixLength - 1) + emoji;
        string result = FilenamePrefixExtension.SanitizePrefix(prefix);
        Assert.That(result, Is.EqualTo(new string('a', FilenamePrefixExtension.MaxPrefixLength - 1)));
        Assert.That(char.IsHighSurrogate(result[^1]), Is.False);
        Assert.That(char.IsLowSurrogate(result[^1]), Is.False);
    }

    // ---- User.InsertFilenamePrefix ----

    /// <summary>Case 9: no-slash format - a bare filename with no directories gets the prefix at the very start.</summary>
    [Test]
    public static void TestInsertFilenamePrefix_NoSlash()
    {
        Assert.That(User.InsertFilenamePrefix("image", "OC01", 40), Is.EqualTo("OC01image"));
    }

    /// <summary>Case 10: with directories present, the prefix lands right after the last '/', not at the very start of the path.</summary>
    [Test]
    public static void TestInsertFilenamePrefix_WithFolders()
    {
        Assert.That(User.InsertFilenamePrefix("model/2026-09-06-1", "OC01", 40), Is.EqualTo("model/OC012026-09-06-1"));
    }

    /// <summary>Case 11: trailing slash (an empty filename segment) still gets the prefix inserted right after the last '/'.</summary>
    [Test]
    public static void TestInsertFilenamePrefix_TrailingSlash()
    {
        Assert.That(User.InsertFilenamePrefix("model/", "OC01", 40), Is.EqualTo("model/OC01"));
    }

    /// <summary>Case 12: a literal '[number]' tag left in the filled path (eg an unresolved/unrelated tag) is untouched by the insertion -
    /// it is just more filename text sitting to the right of the prefix.</summary>
    [Test]
    public static void TestInsertFilenamePrefix_NumberTagInteraction()
    {
        Assert.That(User.InsertFilenamePrefix("image[number]", "OC01", 40), Is.EqualTo("OC01image[number]"));
        Assert.That(User.InsertFilenamePrefix("model/image[number]", "OC01", 40), Is.EqualTo("model/OC01image[number]"));
    }

    /// <summary>Case 13: 'MaxLenPerPart = 0' is legal config - the cap must not index the prefix at [-1], and a zero cap means
    /// the sanitized-but-then-zero-length prefix leaves the path untouched.</summary>
    [Test]
    public static void TestInsertFilenamePrefix_MaxLenZero()
    {
        Assert.That(() => User.InsertFilenamePrefix("image", "OC01", 0), Throws.Nothing);
        Assert.That(User.InsertFilenamePrefix("image", "OC01", 0), Is.EqualTo("image"));
    }

    /// <summary>A prefix containing '/', '[', and '.' together is stripped of the path-shape characters but keeps the interior dot,
    /// then gets inserted normally.</summary>
    [Test]
    public static void TestInsertFilenamePrefix_MixedUnsafeCharsAndDot()
    {
        Assert.That(User.InsertFilenamePrefix("image", "v1.0/[final]", 40), Is.EqualTo("v1.0finalimage"));
    }

    /// <summary>A 200-character prefix is truncated to the given maxLen before insertion.</summary>
    [Test]
    public static void TestInsertFilenamePrefix_LongPrefixTruncatesToMaxLen()
    {
        string longPrefix = new('b', 200);
        string result = User.InsertFilenamePrefix("image", longPrefix, 40);
        Assert.That(result, Is.EqualTo(new string('b', 40) + "image"));
    }

    /// <summary>Truncation at the insertion step also avoids splitting a surrogate pair.</summary>
    [Test]
    public static void TestInsertFilenamePrefix_TruncationAvoidsSurrogateSplit()
    {
        string emoji = "\U0001F600";
        string prefix = new string('a', 4) + emoji;
        string result = User.InsertFilenamePrefix("image", prefix, 5);
        Assert.That(result, Is.EqualTo(new string('a', 4) + "image"));
    }

    /// <summary>A prefix that sanitizes away to nothing (eg only brackets/slashes) leaves the path completely untouched, rather than
    /// inserting an empty segment.</summary>
    [Test]
    public static void TestInsertFilenamePrefix_SanitizesToNothing()
    {
        Assert.That(User.InsertFilenamePrefix("model/image", "///[[]]", 40), Is.EqualTo("model/image"));
        Assert.That(User.InsertFilenamePrefix("model/image", "", 40), Is.EqualTo("model/image"));
    }

    /// <summary>A format written with backslashes still gets the prefix on the filename, not glued onto the last folder's name -
    /// the documented promise is that the prefix never affects which folders the image is saved into.</summary>
    [Test]
    public static void TestInsertFilenamePrefix_BackslashFormatPrefixesFilenameNotFolder()
    {
        Assert.That(User.InsertFilenamePrefix(@"model\2026-09-06-1", "OC01", 40), Is.EqualTo(@"model\OC012026-09-06-1"));
        Assert.That(User.InsertFilenamePrefix(@"a/b\image", "OC01", 40), Is.EqualTo(@"a/b\OC01image"));
    }

    /// <summary>The explicit-tag opt-out is keyed off <see cref="T2IParamTypes.CleanTypeName(string)"/>, tested with the same
    /// normalization the resolver uses, so every spelling that actually resolves to the param is caught by the same check.</summary>
    [Test]
    public static void TestExplicitPrefixTag_RecognizedAcrossSpellings()
    {
        Assert.That(T2IParamTypes.CleanTypeName("filenameprefix"), Is.EqualTo("filenameprefix"));
        Assert.That(T2IParamTypes.CleanTypeName("Filename Prefix"), Is.EqualTo("filenameprefix"));
        Assert.That(T2IParamTypes.CleanTypeName("FILENAME_PREFIX"), Is.EqualTo("filenameprefix"));
        Assert.That(T2IParamTypes.CleanTypeName(" filename-prefix "), Is.EqualTo("filenameprefix"));
        Assert.That(T2IParamTypes.CleanTypeName("model"), Is.Not.EqualTo("filenameprefix"));
    }
}
