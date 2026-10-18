using System.Collections.Generic;
using NUnit.Framework;
using SwarmUI.Text2Image;

namespace SwarmUITests;

/// <summary>Model tags are split, deduped by a loose key, and capped without rewriting the first spelling.</summary>
[TestFixture]
public class ModelTagCleanTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Null means no tags.</summary>
    [Test]
    public static void TestNullIsNull()
    {
        Assert.That(T2IModel.CleanTags(null), Is.Null);
    }

    /// <summary>An empty list, or only blank pieces, leaves nothing.</summary>
    [Test]
    public static void TestEmptyAndWhitespaceAreDropped()
    {
        Assert.That(T2IModel.CleanTags(new List<string>()), Is.Null);
        Assert.That(T2IModel.CleanTags(["", "   ", "\n", "\r\n", ",", ",,", " \t "]), Is.Null);
        Assert.That(T2IModel.CleanTags(["", "  blue eyes  ", " , "]), Is.EqualTo(new[] { "blue eyes" }));
    }

    /// <summary>The same spelling is kept once, in first-seen order.</summary>
    [Test]
    public static void TestExactDuplicatesKeepOrder()
    {
        string[] cleaned = T2IModel.CleanTags(["white hair", "blue eyes", "white hair", "blue eyes"]);
        Assert.That(cleaned, Is.EqualTo(new[] { "white hair", "blue eyes" }));
    }

    /// <summary>Underscores, hyphens, and case share one key. The first display spelling stays.</summary>
    [Test]
    public static void TestLooseKeyKeepsFirstSpelling()
    {
        Assert.That(T2IModel.CleanTags(["foot_fetish", "foot fetish"]), Is.EqualTo(new[] { "foot_fetish" }));
        Assert.That(T2IModel.CleanTags(["dark-skinned female", "dark skinned female"]), Is.EqualTo(new[] { "dark-skinned female" }));
        Assert.That(T2IModel.CleanTags(["White Hair", "white hair"]), Is.EqualTo(new[] { "White Hair" }));
        Assert.That(T2IModel.CleanTags(["white   hair", "white hair"]), Is.EqualTo(new[] { "white   hair" }));
        Assert.That(T2IModel.CleanTags(["white hair", "white   hair", "White_Hair"]), Is.EqualTo(new[] { "white hair" }));
    }

    /// <summary>One stored entry can hold several tags joined by commas or newlines.</summary>
    [Test]
    public static void TestCommaAndNewlineSplits()
    {
        Assert.That(T2IModel.CleanTags(["loafers\nakiyama mio"]), Is.EqualTo(new[] { "loafers", "akiyama mio" }));
        Assert.That(T2IModel.CleanTags(["loafers\r\nakiyama mio"]), Is.EqualTo(new[] { "loafers", "akiyama mio" }));
        Assert.That(T2IModel.CleanTags(["loafers, akiyama mio"]), Is.EqualTo(new[] { "loafers", "akiyama mio" }));
        Assert.That(T2IModel.CleanTags(["loafers,\n akiyama mio, loafers"]), Is.EqualTo(new[] { "loafers", "akiyama mio" }));
    }

    /// <summary>Anima depth names stay literal and do not collapse into each other.</summary>
    [Test]
    public static void TestAnimaNamesStayDistinct()
    {
        string[] cleaned = T2IModel.CleanTags(["anima-base", "anima-2.9b", "anima-3.8b", "anima base", "anima_base", "ANIMA-BASE"]);
        Assert.That(cleaned, Is.EqualTo(new[] { "anima-base", "anima-2.9b", "anima-3.8b" }));
    }

    /// <summary>The cap runs after dedupe and keeps the earliest unique tags.</summary>
    [Test]
    public static void TestCapAppliesAfterDedupe()
    {
        List<string> doubled = new(200);
        for (int i = 0; i < 100; i++)
        {
            doubled.Add($"tag{i}");
            doubled.Add($"tag{i}");
        }
        string[] uniqueHundred = T2IModel.CleanTags(doubled);
        Assert.That(uniqueHundred, Has.Length.EqualTo(100));
        Assert.That(uniqueHundred[0], Is.EqualTo("tag0"));
        Assert.That(uniqueHundred[99], Is.EqualTo("tag99"));
        List<string> many = new(300);
        for (int i = 0; i < 300; i++)
        {
            many.Add($"unique{i}");
        }
        string[] capped = T2IModel.CleanTags(many);
        Assert.That(capped, Has.Length.EqualTo(128));
        Assert.That(capped[0], Is.EqualTo("unique0"));
        Assert.That(capped[127], Is.EqualTo("unique127"));
        List<string> dupesThenMore = ["repeat", "repeat", "REPEAT"];
        for (int i = 0; i < 200; i++)
        {
            dupesThenMore.Add($"later{i}");
        }
        string[] filled = T2IModel.CleanTags(dupesThenMore);
        Assert.That(filled, Has.Length.EqualTo(128));
        Assert.That(filled[0], Is.EqualTo("repeat"));
        Assert.That(filled[1], Is.EqualTo("later0"));
        Assert.That(filled[127], Is.EqualTo("later126"));
    }
}
