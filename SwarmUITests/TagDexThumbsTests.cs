using NUnit.Framework;
using SixLabors.ImageSharp.PixelFormats;
using SwarmUI.Builtin_TagDexExtension;
using SwarmUI.Media;
using System;
using System.IO;
using ISImage = SixLabors.ImageSharp.Image<SixLabors.ImageSharp.PixelFormats.Rgba32>;
using SwarmImage = SwarmUI.Utils.Image;

namespace SwarmUITests;

/// <summary>Tests <see cref="TagDexExtension.ThumbnailFor(TagDexList, in TagDexEntry)"/> for entries that carry a
/// pre-set <see cref="TagDexEntry.ThumbPath"/> (the shape every <c>anima_styles</c> row has). Before this fix,
/// an entry with a pre-set <c>ThumbPath</c> ignored any thumbnail written for it through
/// <see cref="TagDexExtension.WriteThumb(TagDexList, in TagDexEntry, ImageFile)"/> - the same route
/// <c>TagDexSetThumbnail</c>/<c>TagDexGenerateThumbnail</c> use - so a push from AnimaDex landed on disk, was
/// reported as a success, and was never served. <see cref="TagDexExtension.ThumbnailFor(TagDexList, in TagDexEntry)"/>
/// now checks the sanitized-name stem first for every dataset (a written/imported override), falling back to the
/// pre-set <c>ThumbPath</c> only when no override exists.</summary>
[TestFixture]
public class TagDexThumbsTests : SwarmUITest
{
    /// <summary>Throwaway root used in place of <c>Data/TagDex</c>, so these tests never touch the real dataset.</summary>
    private string TempRoot;

    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Points <see cref="TagDexData"/>'s static paths at a fresh temp directory before every test, so
    /// nothing here ever reads or writes the live <c>Data/TagDex</c> folder.</summary>
    [SetUp]
    public void SetupTempRoot()
    {
        TempRoot = Path.Combine(Path.GetTempPath(), $"swarmui-tagdex-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(TempRoot);
        TagDexData.FolderPath = TempRoot;
        TagDexData.ThumbsPath = Path.Combine(TempRoot, "thumbs");
        Directory.CreateDirectory(TagDexData.ThumbsPath);
    }

    /// <summary>Removes the temp directory after every test.</summary>
    [TearDown]
    public void CleanupTempRoot()
    {
        try
        {
            Directory.Delete(TempRoot, true);
        }
        catch (Exception)
        {
            // Best-effort - a stray open handle on a throwaway temp dir is not worth failing the test over.
        }
    }

    /// <summary>Builds a minimal <see cref="TagDexSource"/> shaped like <c>anima_styles</c>: locally supplied,
    /// pre-resolved thumbnail paths, no download URL.</summary>
    private static TagDexSource AnimaStylesLikeSource(string id)
    {
        return new(id, TagDexKind.Artist, "Test Anima Styles", null, "https://danbooru.donmai.us/posts?tags=", TagDexFormat.AnimaStyles);
    }

    /// <summary>A tiny in-memory image, enough to round-trip through <see cref="TagDexExtension.WriteThumb(TagDexList, in TagDexEntry, ImageFile)"/>.</summary>
    private static ImageFile MakeTestImage()
    {
        using ISImage img = new(4, 4);
        return new SwarmImage(img);
    }

    /// <summary>Writes the pre-set <see cref="TagDexEntry.ThumbPath"/> file onto disk, mimicking the gallery
    /// export's own shipped image.</summary>
    private void WritePresetFile(string sourceId, string relativePath)
    {
        string fullPath = Path.Combine(TagDexData.ThumbsPath, sourceId, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
        File.WriteAllBytes(fullPath, [1, 2, 3, 4]);
    }

    /// <summary>A thumbnail written through the same code path the API's set/generate routes use is preferred
    /// over the entry's pre-set <see cref="TagDexEntry.ThumbPath"/>, and lands where the lookup will find it.</summary>
    [Test]
    public void TestThumbnailFor_WrittenOverrideIsPreferredOverPresetThumbPath()
    {
        string sourceId = "test_anima_styles_override";
        TagDexSource source = AnimaStylesLikeSource(sourceId);
        TagDexEntry entry = new() { Name = "test_override_entry", Trigger = "test override entry", ThumbPath = "1/87540.webp" };
        TagDexList list = new() { Source = source, Entries = [entry] };

        WritePresetFile(sourceId, entry.ThumbPath);
        TagDexData.InvalidateThumbs(sourceId);

        // Baseline: before any override is written, resolution falls back to the pre-set path.
        string beforeUrl = TagDexExtension.ThumbnailFor(list, in entry);
        Assert.That(beforeUrl, Is.EqualTo(TagDexExtension.ThumbUrl(sourceId, entry.ThumbPath)));

        // Write a thumbnail through the same helper TagDexSetThumbnail/TagDexGenerateThumbnail call.
        string written = TagDexExtension.WriteThumb(list, in entry, MakeTestImage());
        Assert.That(written, Is.Not.Null, "WriteThumb should report a served URL for the written thumbnail.");
        TagDexData.InvalidateThumbs(sourceId);

        string afterUrl = TagDexExtension.ThumbnailFor(list, in entry);
        Assert.That(afterUrl, Is.EqualTo(written), "ThumbnailFor should resolve to the written override, not the pre-set ThumbPath.");
        Assert.That(afterUrl, Is.Not.EqualTo(TagDexExtension.ThumbUrl(sourceId, entry.ThumbPath)));

        // The write must land where the sanitized-name lookup (and thus the serve route) will actually find it.
        string stem = TagDexNames.SafeFileName(entry.Name);
        string expectedPath = Path.Combine(TagDexData.ThumbsPath, sourceId, $"{stem}.webp");
        Assert.That(File.Exists(expectedPath), Is.True, "The written thumbnail should sit at the sanitized-name stem the lookup checks.");
    }

    /// <summary>An entry with a pre-set <see cref="TagDexEntry.ThumbPath"/> and no written override still
    /// resolves to the pre-set path - existing behaviour for every entry that has not received a push.</summary>
    [Test]
    public void TestThumbnailFor_PresetThumbPathUsedWhenNoOverrideExists()
    {
        string sourceId = "test_anima_styles_preset_only";
        TagDexSource source = AnimaStylesLikeSource(sourceId);
        TagDexEntry entry = new() { Name = "test_preset_only_entry", Trigger = "test preset only entry", ThumbPath = "2/54321.webp" };
        TagDexList list = new() { Source = source, Entries = [entry] };

        WritePresetFile(sourceId, entry.ThumbPath);
        TagDexData.InvalidateThumbs(sourceId);

        string url = TagDexExtension.ThumbnailFor(list, in entry);
        Assert.That(url, Is.EqualTo(TagDexExtension.ThumbUrl(sourceId, entry.ThumbPath)));
    }
}
