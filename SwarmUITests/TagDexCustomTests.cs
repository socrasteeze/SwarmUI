using Newtonsoft.Json.Linq;
using NUnit.Framework;
using SixLabors.ImageSharp.PixelFormats;
using SwarmUI.Builtin_TagDexExtension;
using SwarmUI.Media;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using ISImage = SixLabors.ImageSharp.Image<SixLabors.ImageSharp.PixelFormats.Rgba32>;
using SwarmImage = SwarmUI.Utils.Image;

namespace SwarmUITests;

/// <summary>Tests the user's own TagDex characters: slug, entry mapping, validation, the store round trip, and the
/// search / index / prompt-tag paths that must treat a count-less dataset correctly.</summary>
[TestFixture]
public class TagDexCustomTests : SwarmUITest
{
    /// <summary>Throwaway root used in place of <c>Data/TagDex</c>, so these tests never touch the real data.</summary>
    private string TempRoot;

    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Points <see cref="TagDexData"/> at a fresh temp directory before every test.</summary>
    [SetUp]
    public void SetupTempRoot()
    {
        TempRoot = Path.Combine(Path.GetTempPath(), $"swarmui-tagdex-custom-{Guid.NewGuid():N}");
        Directory.CreateDirectory(TempRoot);
        TagDexData.FolderPath = TempRoot;
        TagDexData.ThumbsPath = Path.Combine(TempRoot, "thumbs");
        Directory.CreateDirectory(TagDexData.ThumbsPath);
        TagDexData.Unload(TagDexCustom.SourceId);
        TagDexData.InvalidateThumbs(TagDexCustom.SourceId);
    }

    /// <summary>Removes the temp directory and the loaded list after every test.</summary>
    [TearDown]
    public void CleanupTempRoot()
    {
        TagDexData.Unload(TagDexCustom.SourceId);
        try
        {
            Directory.Delete(TempRoot, true);
        }
        catch (Exception)
        {
            // Best-effort cleanup of a throwaway directory.
        }
    }

    /// <summary>Builds a record with the given pieces.</summary>
    private static TagDexCustomCharacter Make(string name, string series = "", string tags = "", params TagDexCustomLora[] loras)
    {
        return new(name, series, tags, [.. loras]);
    }

    /// <summary>Slugs are trimmed, lowercase, with whitespace runs turned into one underscore.</summary>
    [Test]
    public void TestSlug()
    {
        Assert.That(TagDexCustom.Slug("  Aria   Two "), Is.EqualTo("aria_two"));
        Assert.That(TagDexCustom.Slug("Aria (ZZZ)"), Is.EqualTo("aria_(zzz)"));
        Assert.That(TagDexCustom.Slug("ARIA"), Is.EqualTo(TagDexCustom.Slug("aria")));
        Assert.That(TagDexCustom.Slug(null), Is.EqualTo(""));
    }

    /// <summary>Tag fields lose line breaks, blanks and stray commas, and keep tag order.</summary>
    [Test]
    public void TestNormalizeTags()
    {
        Assert.That(TagDexCustom.NormalizeTags("1girl,  silver hair\n\nred eyes, ,"), Is.EqualTo("1girl, silver hair, red eyes"));
        Assert.That(TagDexCustom.NormalizeTags("   "), Is.EqualTo(""));
        Assert.That(TagDexCustom.NormalizeTags(null), Is.EqualTo(""));
    }

    /// <summary>Weights format with invariant culture and no trailing zeros, and clamp to +/-2.</summary>
    [Test]
    public void TestWeightFormatAndClamp()
    {
        Assert.That(TagDexCustom.FormatWeight(0.8), Is.EqualTo("0.8"));
        Assert.That(TagDexCustom.FormatWeight(1), Is.EqualTo("1"));
        Assert.That(TagDexCustom.FormatWeight(0.85), Is.EqualTo("0.85"));
        Assert.That(TagDexCustom.FormatWeight(0.12345), Is.EqualTo("0.123"));
        Assert.That(TagDexCustom.FormatWeight(-0.5), Is.EqualTo("-0.5"));
        Assert.That(TagDexCustom.FormatWeight(-0.0001), Is.EqualTo("0"));
        Assert.That(TagDexCustom.ClampWeight(5), Is.EqualTo(2));
        Assert.That(TagDexCustom.ClampWeight(-9), Is.EqualTo(-2));
        Assert.That(TagDexCustom.ClampWeight(0.3), Is.EqualTo(0.3));
        Assert.That(TagDexCustom.ClampWeight(double.NaN), Is.EqualTo(1));
        Assert.That(TagDexCustom.ClampWeight(double.PositiveInfinity), Is.EqualTo(1));
    }

    /// <summary>Clean trims the name, drops a .safetensors suffix, clamps weights and normalizes every tag field.</summary>
    [Test]
    public void TestClean()
    {
        TagDexCustomCharacter cleaned = TagDexCustom.Clean(Make("  Aria   Two ", " ZZZ ", "1girl,\nsilver hair",
            new TagDexCustomLora(" folder/aria.safetensors ", 9, "a,, b")));
        Assert.That(cleaned.Name, Is.EqualTo("Aria Two"));
        Assert.That(cleaned.Series, Is.EqualTo("ZZZ"));
        Assert.That(cleaned.Tags, Is.EqualTo("1girl, silver hair"));
        Assert.That(cleaned.Loras[0].Name, Is.EqualTo("folder/aria"));
        Assert.That(cleaned.Loras[0].Weight, Is.EqualTo(2));
        Assert.That(cleaned.Loras[0].Tags, Is.EqualTo("a, b"));
    }

    /// <summary>A character maps to a row whose trigger is the user's tags and whose core tags are each LoRA tag
    /// followed by that LoRA's own tags, in order.</summary>
    [Test]
    public void TestToEntryMapsTagsAndLoras()
    {
        TagDexCustomCharacter record = TagDexCustom.Clean(Make("Aria Two", "Zenless Zone Zero", "1girl, silver hair",
            new TagDexCustomLora("folder/aria", 0.8, "aria_zzz, silver dress"),
            new TagDexCustomLora("style/flat", 1, ""),
            new TagDexCustomLora("detail", -0.5, "detailed")));
        TagDexEntry entry = TagDexCustom.ToEntry(record);
        Assert.That(entry.Name, Is.EqualTo("aria_two"));
        Assert.That(entry.Trigger, Is.EqualTo("1girl, silver hair"));
        Assert.That(entry.Copyright, Is.EqualTo("Zenless Zone Zero"));
        Assert.That(entry.Count, Is.EqualTo(0));
        Assert.That(entry.CoreTags, Is.EqualTo("<lora:folder/aria:0.8>, aria_zzz, silver dress, <lora:style/flat:1>, <lora:detail:-0.5>, detailed"));
        Assert.That(entry.Genders & (1 << TagDexVocab.BitFor(TagDexVocab.Genders, "1girl")), Is.Not.EqualTo(0), "facets come from the user's tags");
    }

    /// <summary>Empty tags fall back to the humanized, paren-escaped name; no LoRAs and no series mean null fields.</summary>
    [Test]
    public void TestToEntryFallbacks()
    {
        TagDexEntry entry = TagDexCustom.ToEntry(TagDexCustom.Clean(Make("Aria (ZZZ)")));
        Assert.That(entry.Trigger, Is.EqualTo(@"aria \(zzz\)"));
        Assert.That(entry.CoreTags, Is.Null);
        Assert.That(entry.Copyright, Is.Null);
    }

    /// <summary>Every validation rule rejects, and a valid record passes.</summary>
    [Test]
    public void TestValidateRejections()
    {
        List<TagDexCustomCharacter> none = [];
        Assert.That(TagDexCustom.Validate(TagDexCustom.Clean(Make("Aria", "", "1girl", new TagDexCustomLora("a/b", 1, "x"))), "", none), Is.Null);
        Assert.That(TagDexCustom.Validate(TagDexCustom.Clean(Make("   ")), "", none), Does.Contain("name is required"));
        Assert.That(TagDexCustom.Validate(TagDexCustom.Clean(Make(new string('n', TagDexCustom.MaxNameLength + 1))), "", none), Does.Contain("name is too long"));
        Assert.That(TagDexCustom.Validate(TagDexCustom.Clean(Make("A", new string('s', TagDexCustom.MaxSeriesLength + 1))), "", none), Does.Contain("series is too long"));
        Assert.That(TagDexCustom.Validate(TagDexCustom.Clean(Make("A", "", new string('t', TagDexCustom.MaxTagsLength + 1))), "", none), Does.Contain("tags are too long"));
        TagDexCustomLora[] many = [.. Enumerable.Range(0, TagDexCustom.MaxLoras + 1).Select(i => new TagDexCustomLora($"l{i}", 1, ""))];
        Assert.That(TagDexCustom.Validate(TagDexCustom.Clean(Make("A", "", "", many)), "", none), Does.Contain("Too many LoRAs"));
        Assert.That(TagDexCustom.Validate(TagDexCustom.Clean(Make("A", "", "", new TagDexCustomLora("  ", 1, ""))), "", none), Does.Contain("needs a name"));
        foreach (string bad in new[] { "a<b", "a>b", "a,b" })
        {
            Assert.That(TagDexCustom.Validate(TagDexCustom.Clean(Make("A", "", "", new TagDexCustomLora(bad, 1, ""))), "", none), Does.Contain("not a valid LoRA name"), bad);
        }
        Assert.That(TagDexCustom.Validate(TagDexCustom.Clean(Make("A", "", "", new TagDexCustomLora("ok", 1, new string('t', TagDexCustom.MaxLoraTagsLength + 1)))), "", none), Does.Contain("tags for 'ok' are too long"));
    }

    /// <summary>A slug is unique case-insensitively on create; an edit may keep its own slug but not take another's.</summary>
    [Test]
    public void TestValidateUniqueness()
    {
        List<TagDexCustomCharacter> store = [Make("Aria"), Make("Bea Two")];
        Assert.That(TagDexCustom.Validate(Make("ARIA"), "", store), Does.Contain("already exists"));
        Assert.That(TagDexCustom.Validate(Make("bea  two"), "", store), Does.Contain("already exists"), "whitespace runs collapse into the same slug");
        Assert.That(TagDexCustom.Validate(Make("Aria"), "Aria", store), Is.Null, "editing a record in place is not a duplicate");
        Assert.That(TagDexCustom.Validate(Make("ARIA"), "aria", store), Is.Null, "the edit's own slug may change case");
        Assert.That(TagDexCustom.Validate(Make("Bea Two"), "Aria", store), Does.Contain("already exists"), "an edit cannot take another record's slug");
        Assert.That(TagDexCustom.Validate(Make("Cleo"), "Aria", store), Is.Null, "a rename to a free slug is fine");
    }

    /// <summary>API and stored JSON shapes parse leniently and round trip.</summary>
    [Test]
    public void TestJsonRoundTrip()
    {
        JObject payload = JObject.Parse("""
            { "original": "x", "name": "Aria", "series": "S", "tags": "1girl",
              "loras": [ { "name": "a", "weight": "0.5", "tags": "t" }, { "name": "b" }, { "name": "c", "weight": "junk" }, "notanobject" ] }
            """);
        TagDexCustomCharacter record = TagDexCustom.FromJson(payload);
        Assert.That(record.Name, Is.EqualTo("Aria"));
        Assert.That(record.Loras.Count, Is.EqualTo(3));
        Assert.That(record.Loras[0].Weight, Is.EqualTo(0.5));
        Assert.That(record.Loras[1].Weight, Is.EqualTo(1), "a missing weight defaults to 1");
        Assert.That(record.Loras[2].Weight, Is.EqualTo(1), "an unparseable weight defaults to 1");
        TagDexCustomCharacter again = TagDexCustom.FromJson(TagDexCustom.ToJson(record));
        Assert.That(again.Loras.Select(l => (l.Name, l.Weight, l.Tags)), Is.EqualTo(record.Loras.Select(l => (l.Name, l.Weight, l.Tags))));
    }

    /// <summary>Save creates the file, the loaded list is sorted by name, and a duplicate is refused without touching it.</summary>
    [Test]
    public void TestSaveCreateAndDuplicate()
    {
        (string slug, string error) = TagDexCustom.Save("", Make("Zed", "S1", "1girl", new TagDexCustomLora("a", 1, "")));
        Assert.That(error, Is.Null);
        Assert.That(slug, Is.EqualTo("zed"));
        (string slugB, _) = TagDexCustom.Save("", Make("Aria", "s1"));
        Assert.That(slugB, Is.EqualTo("aria"));
        (string dupSlug, string dupError) = TagDexCustom.Save("", Make("ARIA"));
        Assert.That(dupSlug, Is.Null);
        Assert.That(dupError, Does.Contain("already exists"));
        TagDexList list = TagDexData.EnsureLoaded(TagDexCustom.SourceId);
        Assert.That(list, Is.Not.Null);
        Assert.That(list.Entries.Select(e => e.Name), Is.EqualTo(new[] { "aria", "zed" }));
        Assert.That(list.Copyrights.Length, Is.EqualTo(1), "series that differ only by case share one folder");
        Assert.That(list.Copyrights[0].Count, Is.EqualTo(2));
        Assert.That(TagDexCustom.RecordFor("zed").Loras[0].Name, Is.EqualTo("a"));
    }

    /// <summary>Editing a missing record fails; a rename moves the thumbnail, and delete removes record and thumbnail.</summary>
    [Test]
    public void TestSaveRenameMovesThumbnailAndDeleteCleansUp()
    {
        (string missing, string missingError) = TagDexCustom.Save("ghost", Make("Ghost"));
        Assert.That(missing, Is.Null);
        Assert.That(missingError, Does.Contain("No character named"));
        TagDexCustom.Save("", Make("Aria"));
        TagDexList list = TagDexData.EnsureLoaded(TagDexCustom.SourceId);
        TagDexEntry entry = list.Entries[0];
        using ISImage img = new(4, 4);
        string written = TagDexExtension.WriteThumb(list, in entry, (ImageFile)new SwarmImage(img));
        Assert.That(written, Is.Not.Null);
        string thumbs = Path.Combine(TagDexData.ThumbsPath, TagDexCustom.SourceId);
        Assert.That(File.Exists(Path.Combine(thumbs, "aria.webp")), Is.True);

        (string renamed, string renameError) = TagDexCustom.Save("Aria", Make("Aria Two"));
        Assert.That(renameError, Is.Null);
        Assert.That(renamed, Is.EqualTo("aria_two"));
        Assert.That(File.Exists(Path.Combine(thumbs, "aria.webp")), Is.False);
        Assert.That(File.Exists(Path.Combine(thumbs, "aria_two.webp")), Is.True, "the reference image follows the rename");
        Assert.That(TagDexData.EnsureLoaded(TagDexCustom.SourceId).Entries.Select(e => e.Name), Is.EqualTo(new[] { "aria_two" }));

        Assert.That(TagDexCustom.Delete("Aria Two"), Is.True);
        Assert.That(File.Exists(Path.Combine(thumbs, "aria_two.webp")), Is.False, "delete removes the reference image");
        Assert.That(TagDexData.EnsureLoaded(TagDexCustom.SourceId).Entries.Length, Is.EqualTo(0));
        Assert.That(TagDexCustom.Delete("Aria Two"), Is.False);
    }

    /// <summary>Custom rows have no post count: the search count floor must not hide them (the route passes floor 0),
    /// and an entry serializes with the user's casing, the raw record, and no booru link.</summary>
    [Test]
    public void TestSearchAndDescribe()
    {
        TagDexCustom.Save("", Make("Aria Two", "Zenless Zone Zero", "1girl, blue eyes", new TagDexCustomLora("folder/aria", 0.8, "aria_zzz")));
        TagDexList list = TagDexData.EnsureLoaded(TagDexCustom.SourceId);
        TagDexQuery hidden = TagDexSearch.BuildQuery("", "", "", "", "", "", 20);
        Assert.That(TagDexSearch.Run(list, hidden, "relevance", false, 0, 50).Total, Is.EqualTo(0), "a normal count floor would hide custom rows");
        TagDexQuery query = TagDexSearch.BuildQuery("aria two", "", "", "", "", "1girl", 0);
        TagDexResults results = TagDexSearch.Run(list, query, "relevance", false, 0, 50);
        Assert.That(results.Total, Is.EqualTo(1));
        JObject described = TagDexExtension.DescribeEntry(list, results.Indices[0]);
        Assert.That((string)described["display"], Is.EqualTo("Aria Two"));
        Assert.That((string)described["name"], Is.EqualTo("aria_two"));
        Assert.That((string)described["copyright_display"], Is.EqualTo("Zenless Zone Zero"));
        Assert.That(described.ContainsKey("url"), Is.False, "no booru link for a custom character");
        Assert.That((string)described["custom"]["tags"], Is.EqualTo("1girl, blue eyes"));
        Assert.That((double)described["custom"]["loras"][0]["weight"], Is.EqualTo(0.8));
        Assert.That(described["core_tags"].Select(t => (string)t), Is.EqualTo(new[] { "<lora:folder/aria:0.8>", "aria_zzz" }));
    }

    /// <summary>The typeahead index includes custom rows despite their zero count, and prompt tag pools never draw them.</summary>
    [Test]
    public void TestIndexBlobAndPromptPool()
    {
        TagDexCustom.Save("", Make("Aria", "", "1girl, silver hair"));
        TagDexList list = TagDexData.EnsureLoaded(TagDexCustom.SourceId);
        string blob = TagDexIndexBlob.Build(list, TagDexPrefs.DefaultLeanMinCount);
        Assert.That(blob, Does.StartWith("aria\t1girl, silver hair\t"));
        Assert.That(TagDexPromptTags.BuildPool(TagDexKind.Character, null), Is.Empty);
        Assert.That(TagDexPromptTags.BuildPool(TagDexKind.Character, new HashSet<string> { "custom_character:aria" }), Is.Empty);
    }
}
