using NUnit.Framework;
using SwarmUI.Builtin_TagDexExtension;

namespace SwarmUITests;

/// <summary>A standalone series tag is removed from a character trigger only when it repeats the name's qualifier.</summary>
[TestFixture]
public class TagDexSeriesDedupeTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>The series after the qualified name is the redundant part.</summary>
    [Test]
    public static void TestDropsStandaloneSeries()
    {
        Assert.That(TagDexNames.DropRedundantSeries("nessa (pokemon), pokemon"), Is.EqualTo("nessa (pokemon)"));
    }

    /// <summary>A name with no parenthesized qualifier keeps every later part, including the series.</summary>
    [Test]
    public static void TestNoQualifierIsUnchanged()
    {
        string input = "tifa lockhart, final fantasy";
        Assert.That(TagDexNames.DropRedundantSeries(input), Is.SameAs(input));
    }

    /// <summary>Only the later part that equals a qualifier is removed. Qualifiers that are not repeated stay in the name.</summary>
    [Test]
    public static void TestDropsOnlyTheRepeatedQualifier()
    {
        Assert.That(TagDexNames.DropRedundantSeries("aria (robot) (zenless zone zero), zenless zone zero, pink hair"), Is.EqualTo("aria (robot) (zenless zone zero), pink hair"));
        string already = "aria (robot) (zenless zone zero), pink hair";
        Assert.That(TagDexNames.DropRedundantSeries(already), Is.SameAs(already));
    }

    /// <summary>Each parenthesized group is its own qualifier.</summary>
    [Test]
    public static void TestMultiQualifier()
    {
        Assert.That(TagDexNames.DropRedundantSeries("jackal (class troublemaker) (nikke), nikke"), Is.EqualTo("jackal (class troublemaker) (nikke)"));
    }

    /// <summary>Escaped and bare parentheses name the same qualifier, and case does not count.</summary>
    [Test]
    public static void TestEscapedParens()
    {
        Assert.That(TagDexNames.DropRedundantSeries("saber \\(fate\\), fate"), Is.EqualTo("saber \\(fate\\)"));
        Assert.That(TagDexNames.DropRedundantSeries("saber (fate), Fate"), Is.EqualTo("saber (fate)"));
    }

    /// <summary>Underscores, spaces, and case share one key.</summary>
    [Test]
    public static void TestUnderscoreSpaceAndCase()
    {
        Assert.That(TagDexNames.DropRedundantSeries("hk416 (girls' frontline), Girls'_Frontline"), Is.EqualTo("hk416 (girls' frontline)"));
    }

    /// <summary>A shorter or different series is not the qualifier, so it stays.</summary>
    [Test]
    public static void TestPartialSeriesIsKept()
    {
        string shortSeries = "ganyu (genshin impact), genshin";
        Assert.That(TagDexNames.DropRedundantSeries(shortSeries), Is.SameAs(shortSeries));
        string otherSeries = "2b (nier:automata), nier (series)";
        Assert.That(TagDexNames.DropRedundantSeries(otherSeries), Is.SameAs(otherSeries));
    }

    /// <summary>The name stays, and the parts that are not the qualifier keep their order.</summary>
    [Test]
    public static void TestFirstPartStaysAndOrderIsKept()
    {
        Assert.That(TagDexNames.DropRedundantSeries("x (a), b, a, c"), Is.EqualTo("x (a), b, c"));
    }

    /// <summary>Blank input and a trigger with nothing to drop come back as the same string.</summary>
    [Test]
    public static void TestNullWhitespaceAndNoMatchAreTheSameString()
    {
        Assert.That(TagDexNames.DropRedundantSeries(null), Is.Null);
        string empty = "";
        Assert.That(TagDexNames.DropRedundantSeries(empty), Is.SameAs(empty));
        string spaces = "   ";
        Assert.That(TagDexNames.DropRedundantSeries(spaces), Is.SameAs(spaces));
        string noMatch = "tifa lockhart, final fantasy";
        Assert.That(TagDexNames.DropRedundantSeries(noMatch), Is.SameAs(noMatch));
    }

    /// <summary>The index URL fingerprint changes with the format version, so browsers fetch the new blob.</summary>
    [Test]
    public static void TestFingerprintIncludesFormatVersion()
    {
        TagDexList list = new()
        {
            Entries = [],
            FileModifiedUtc = 0x5A
        };
        string fingerprint = TagDexIndexBlob.Fingerprint(list, 500);
        Assert.That(fingerprint, Does.Contain(TagDexIndexBlob.FormatVersion));
    }
}
