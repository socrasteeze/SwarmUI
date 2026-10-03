using NUnit.Framework;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Builtin_MobileEnhancementsExtension;
using SwarmUI.WebAPI;
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;

namespace SwarmUITests;

/// <summary>Tests whether output branches contain media that can appear in history.</summary>
[TestFixture]
public class ImageHistoryFolderTests : SwarmUITest
{
    /// <summary>Throwaway filesystem root for each test.</summary>
    private string TempRoot;

    /// <summary>Prepares shared test state.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Creates a fresh filesystem fixture.</summary>
    [SetUp]
    public void CreateFixture()
    {
        TempRoot = Path.Combine(Path.GetTempPath(), $"swarm-history-folders-{Guid.NewGuid():N}");
        Directory.CreateDirectory(TempRoot);
    }

    /// <summary>Removes only the throwaway filesystem fixture.</summary>
    [TearDown]
    public void RemoveFixture()
    {
        Directory.Delete(TempRoot, true);
    }

    /// <summary>Empty branches, nested empty branches, placeholders, and preview sidecars are not history content.</summary>
    [Test]
    public void EmptyAndScratchOnlyBranches_AreHiddenWithoutDeletingAnything()
    {
        string child = Path.Combine(TempRoot, "nested", "empty");
        Directory.CreateDirectory(child);
        string marker = Path.Combine(TempRoot, "_output_images_will_be_put_here");
        File.WriteAllText(marker, "placeholder");
        File.WriteAllText(Path.Combine(child, "orphan.swarmpreview.jpg"), "preview");
        File.WriteAllText(Path.Combine(child, "orphan.swarmpreview.webp"), "preview");
        File.WriteAllText(Path.Combine(child, "orphan.swarm.json"), "{}");
        File.WriteAllText(Path.Combine(child, ".hidden.png"), "hidden");

        Assert.That(ImageHistoryFolders.ContainsMedia(TempRoot, T2IAPI.HistoryExtensions), Is.False);
        Assert.That(File.ReadAllText(marker), Is.EqualTo("placeholder"));
        Assert.That(Directory.Exists(child), Is.True);
        Assert.That(ImageHistoryFolders.ContainsMedia(Path.Combine(TempRoot, "missing"), T2IAPI.HistoryExtensions), Is.False);
    }

    /// <summary>Media below the listing depth still keeps its ancestor folder navigable.</summary>
    [TestCase("PNG")]
    [TestCase("mp4")]
    [TestCase("wav")]
    public void NestedMedia_KeepsAncestorVisible(string extension)
    {
        string child = Path.Combine(TempRoot, "nested", "deeper");
        Directory.CreateDirectory(child);
        File.WriteAllText(Path.Combine(child, $"saved.{extension}"), "media");

        Assert.That(ImageHistoryFolders.ContainsMedia(TempRoot, T2IAPI.HistoryExtensions), Is.True);
    }

    /// <summary>The history response filters both physical and virtual empty branches without using the displayed file limit.</summary>
    [Test]
    public void HistoryListing_FiltersEmptyAndVirtualFoldersButKeepsNestedMedia()
    {
        string root = Path.Combine(TempRoot, "output");
        string nested = Path.Combine(root, "populated", "deeper");
        string scratch = Path.Combine(TempRoot, "backend-output");
        Directory.CreateDirectory(Path.Combine(root, "empty", "child"));
        Directory.CreateDirectory(nested);
        Directory.CreateDirectory(scratch);
        File.WriteAllText(Path.Combine(nested, "saved.png"), "media");
        File.WriteAllText(Path.Combine(scratch, "_output_images_will_be_put_here"), "placeholder");
        string alias = $"_test_{Guid.NewGuid():N}/";
        UserImageHistoryHelper.SharedSpecialFolders[alias] = scratch;
        try
        {
            User user = (User)RuntimeHelpers.GetUninitializedObject(typeof(User));
            user.Data = new User.DatabaseEntry() { ID = "history-folder-test" };
            user.Settings = new SwarmUI.Core.Settings.User() { MaxImagesInHistory = 1, MaxImagesScannedInHistory = 1 };
            Session session = new() { User = user };
            MethodInfo listing = typeof(T2IAPI).GetMethod("GetListAPIInternal", BindingFlags.NonPublic | BindingFlags.Static);
            JObject result = (JObject)listing.Invoke(null, [session, "", root, T2IAPI.HistoryExtensions, (Func<string, bool>)(_ => true), 1, T2IAPI.ImageHistorySortMode.Name, false, null]);

            Assert.That(result["error"], Is.Null);
            Assert.That(result["folders"].Values<string>(), Is.EquivalentTo(new[] { "populated" }));
            Assert.That(Directory.Exists(Path.Combine(root, "empty", "child")), Is.True);
        }
        finally
        {
            UserImageHistoryHelper.SharedSpecialFolders.TryRemove(alias, out _);
        }
    }
}
