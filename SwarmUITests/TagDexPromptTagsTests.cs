using NUnit.Framework;
using SwarmUI.Builtin_TagDexExtension;

namespace SwarmUITests;

/// <summary>Tests the pure helpers behind <c>&lt;characters:...&gt;</c> and <c>&lt;artists:...&gt;</c>.</summary>
[TestFixture]
public class TagDexPromptTagsTests
{
    /// <summary>Builds an entry with gender bits parsed the same way the dataset loader sets them.</summary>
    public static TagDexEntry Entry(string name, string coreTags)
    {
        TagDexEntry entry = new() { Name = name, Trigger = TagDexNames.Humanize(name), CoreTags = coreTags };
        foreach (string tag in (coreTags ?? "").Split(','))
        {
            int bit = TagDexVocab.BitFor(TagDexVocab.Genders, tag.Trim());
            if (bit >= 0)
            {
                entry.Genders |= (byte)(1 << bit);
            }
        }
        return entry;
    }

    /// <summary>Only 1girl-without-1boy entries are eligible characters; untagged entries never are.</summary>
    [Test]
    public void CharacterPoolIsFemaleOnly()
    {
        Assert.That(TagDexPromptTags.IsEligible(Entry("a", "1girl, blue eyes"), TagDexKind.Character), Is.True);
        Assert.That(TagDexPromptTags.IsEligible(Entry("b", "1boy, black hair"), TagDexKind.Character), Is.False);
        Assert.That(TagDexPromptTags.IsEligible(Entry("c", "1girl, 1boy"), TagDexKind.Character), Is.False);
        Assert.That(TagDexPromptTags.IsEligible(Entry("d", "1other"), TagDexKind.Character), Is.False);
        Assert.That(TagDexPromptTags.IsEligible(Entry("e", null), TagDexKind.Character), Is.False);
    }

    /// <summary>Characters render as escaped name plus every core tag, without the series.</summary>
    [Test]
    public void CharacterFormatHasNameAndAllTags()
    {
        TagDexEntry saber = Entry("saber_(fate)", "1girl, green eyes, blonde hair, ahoge");
        saber.Copyright = "fate_(series)";
        Assert.That(TagDexPromptTags.Format(saber, TagDexKind.Character), Is.EqualTo(@"saber \(fate\), 1girl, green eyes, blonde hair, ahoge"));
    }

    /// <summary>Already-escaped triggers (anima_styles) are not double-escaped; meta artists are excluded.</summary>
    [Test]
    public void ArtistFormatAndExclusions()
    {
        TagDexEntry styled = new() { Name = "hammer_(sunset_beach)", Trigger = @"hammer \(sunset beach\)" };
        Assert.That(TagDexPromptTags.Format(styled, TagDexKind.Artist), Is.EqualTo(@"hammer \(sunset beach\)"));
        Assert.That(TagDexPromptTags.IsEligible(new TagDexEntry() { Name = "banned_artist" }, TagDexKind.Artist), Is.False);
        Assert.That(TagDexPromptTags.IsEligible(new TagDexEntry() { Name = "ebifurya" }, TagDexKind.Artist), Is.True);
    }
}
