using ImageMagick;
using NUnit.Framework;
using SwarmUI.Accounts;
using SwarmUI.Builtin_MobileEnhancementsExtension;
using SwarmUI.Builtin_TiffDecodeGuardExtension;
using SwarmUI.WebAPI;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;

namespace SwarmUITests;

/// <summary>Tests the server filesystem image browser's bounded listing and recursive Drives image listing.</summary>
[TestFixture]
public class SimpleImageBrowserTests : SwarmUITest
{
    /// <summary>Temporary filesystem root for the current test.</summary>
    private string TempRoot;

    /// <summary>Prepares the shared SwarmUI test state.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Creates a fresh root before each test.</summary>
    [SetUp]
    public void SetupTempRoot()
    {
        TempRoot = Path.Combine(Path.GetTempPath(), $"swarm-simple-browser-{Guid.NewGuid():N}");
        Directory.CreateDirectory(TempRoot);
    }

    /// <summary>Removes the fresh root after each test.</summary>
    [TearDown]
    public void CleanupTempRoot()
    {
        try
        {
            Directory.Delete(TempRoot, true);
        }
        catch (Exception)
        {
            // A locked throwaway directory must not hide the primary assertion failure.
        }
    }

    /// <summary>Creates a valid small PNG file.</summary>
    private static byte[] WriteValidPng(string path, int width = 8, int height = 4)
    {
        using MagickImage image = new(MagickColors.Black, (uint)width, (uint)height);
        byte[] bytes = image.ToByteArray(MagickFormat.Png);
        File.WriteAllBytes(path, bytes);
        return bytes;
    }

    /// <summary>Folder results are direct children, deterministic, filtered, and paged over folders then files.</summary>
    [Test]
    public void ListFolder_SortsFiltersAndPagesDirectChildren()
    {
        Directory.CreateDirectory(Path.Combine(TempRoot, "beta"));
        Directory.CreateDirectory(Path.Combine(TempRoot, "Alpha"));
        Directory.CreateDirectory(Path.Combine(TempRoot, "Alpha", "nested"));
        WriteValidPng(Path.Combine(TempRoot, "zeta.png"));
        WriteValidPng(Path.Combine(TempRoot, "Bravo.PNG"));
        File.WriteAllText(Path.Combine(TempRoot, "notes.txt"), "not an image");

        Newtonsoft.Json.Linq.JObject first = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 3);
        Newtonsoft.Json.Linq.JObject second = SimpleImageBrowserAPI.ListFolder(TempRoot, 3, 3);

        Assert.That((int)first["total"], Is.EqualTo(4));
        Assert.That((int)first["next_offset"], Is.EqualTo(3));
        Assert.That(first["folders"].Select(row => (string)row["name"]), Is.EqualTo(new[] { "Alpha", "beta" }));
        Assert.That(first["files"].Select(row => (string)row["name"]), Is.EqualTo(new[] { "Bravo.PNG" }));
        Assert.That(second["folders"].Count(), Is.EqualTo(0));
        Assert.That(second["files"].Select(row => (string)row["name"]), Is.EqualTo(new[] { "zeta.png" }));
        Assert.That(second["next_offset"].Type, Is.EqualTo(Newtonsoft.Json.Linq.JTokenType.Null));
        Assert.That((string)first["parent"], Is.EqualTo(Directory.GetParent(Path.GetFullPath(TempRoot))?.FullName));
        Assert.That((string)SimpleImageBrowserAPI.ListFolder(TempRoot, -1, 1)["error_id"], Is.EqualTo("bad_page"));
        Assert.That((string)SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 0)["error_id"], Is.EqualTo("bad_page"));
        Assert.That((string)SimpleImageBrowserAPI.ListFolder(TempRoot, 0, SimpleImageBrowserAPI.MaximumPageSize + 1, "", true)["error_id"], Is.EqualTo("bad_page"));
        Assert.That(SimpleImageBrowserAPI.ListFolder(TempRoot, int.MaxValue, 100)["next_offset"].Type, Is.EqualTo(Newtonsoft.Json.Linq.JTokenType.Null));
        Assert.That(SimpleImageBrowserAPI.ListFolder("", 0, 1)["parent"].Type, Is.EqualTo(Newtonsoft.Json.Linq.JTokenType.Null));
        Newtonsoft.Json.Linq.JObject drives = SimpleImageBrowserAPI.ListFolder("", 999, 1, "ignored", true);
        Assert.That((int)drives["total"], Is.EqualTo(0));
        Assert.That(drives["files"].Count(), Is.EqualTo(0));
        Assert.That(drives["next_offset"].Type, Is.EqualTo(Newtonsoft.Json.Linq.JTokenType.Null));
        Assert.That(drives["folders"].Count(), Is.EqualTo(DriveInfo.GetDrives().Length));
    }

    /// <summary>Image-only pages keep folder navigation while paging every matching direct filename.</summary>
    [Test]
    public void ListFolder_ImagePagesSearchAcrossAllDirectFiles()
    {
        Directory.CreateDirectory(Path.Combine(TempRoot, "NavigateHere"));
        for (int i = 0; i < 102; i++)
        {
            WriteValidPng(Path.Combine(TempRoot, $"Needle-{i:000}.png"));
        }
        WriteValidPng(Path.Combine(TempRoot, "other.png"));

        Newtonsoft.Json.Linq.JObject first = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 48, "needle", true);
        Newtonsoft.Json.Linq.JObject middle = SimpleImageBrowserAPI.ListFolder(TempRoot, 48, 48, "NEEDLE", true);
        Newtonsoft.Json.Linq.JObject last = SimpleImageBrowserAPI.ListFolder(TempRoot, 96, 48, "needle", true);

        Assert.That(first["folders"].Select(row => (string)row["name"]), Is.EqualTo(new[] { "NavigateHere" }));
        Assert.That(first["files"].Count(), Is.EqualTo(48));
        Assert.That((string)first["files"][0]["name"], Is.EqualTo("Needle-000.png"));
        Assert.That((int)first["total"], Is.EqualTo(102));
        Assert.That((int)first["next_offset"], Is.EqualTo(48));
        Assert.That((string)middle["files"][0]["name"], Is.EqualTo("Needle-048.png"));
        Assert.That((int)middle["next_offset"], Is.EqualTo(96));
        Assert.That(last["files"].Count(), Is.EqualTo(6));
        Assert.That((string)last["files"][0]["name"], Is.EqualTo("Needle-096.png"));
        Assert.That(last["next_offset"].Type, Is.EqualTo(Newtonsoft.Json.Linq.JTokenType.Null));
    }

    /// <summary>Machine image pages sort the full match set before paging and keep Name A-Z as the default.</summary>
    [Test]
    public void ListFolder_ImagePagesSupportAllSortDirections()
    {
        string alpha = Path.Combine(TempRoot, "alpha.png");
        string beta = Path.Combine(TempRoot, "beta.png");
        string gamma = Path.Combine(TempRoot, "gamma.png");
        string mixedUpper = Path.Combine(TempRoot, "Mixed.png");
        WriteValidPng(alpha);
        WriteValidPng(beta);
        WriteValidPng(gamma);
        WriteValidPng(mixedUpper);
        File.SetLastWriteTimeUtc(alpha, DateTime.UnixEpoch.AddSeconds(10));
        File.SetLastWriteTimeUtc(beta, DateTime.UnixEpoch.AddSeconds(30));
        File.SetLastWriteTimeUtc(gamma, DateTime.UnixEpoch.AddSeconds(20));
        File.SetLastWriteTimeUtc(mixedUpper, DateTime.UnixEpoch.AddSeconds(5));

        string[] Names(Newtonsoft.Json.Linq.JObject result) => result["files"].Select(row => (string)row["name"]).ToArray();
        Assert.That(Names(SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 48, "", true)), Is.EqualTo(new[] { "alpha.png", "beta.png", "gamma.png", "Mixed.png" }));
        Assert.That(Names(SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 48, "", true, "Name", false)), Is.EqualTo(new[] { "Mixed.png", "gamma.png", "beta.png", "alpha.png" }));
        Assert.That(Names(SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 3, "", true, "Date", false)), Is.EqualTo(new[] { "beta.png", "gamma.png", "alpha.png" }));
        Assert.That(Names(SimpleImageBrowserAPI.ListFolder(TempRoot, 2, 3, "", true, "Date", true)).Take(1), Is.EqualTo(new[] { "gamma.png" }));
        Assert.That((string)SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 48, "", true, "Bogus", false)["error_id"], Is.EqualTo("bad_sort"));
        Assert.That((string)SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 48, "", true, "42", false)["error_id"], Is.EqualTo("bad_sort"));
    }

    /// <summary>Recursive search finds image file names at every depth, ignores folder names, and sorts before paging.</summary>
    [Test]
    public void ListFolder_RecursiveSearchMatchesNestedFileNames()
    {
        string levelOne = Path.Combine(TempRoot, "level-one");
        string levelTwo = Path.Combine(levelOne, "level-two");
        string levelThree = Path.Combine(levelTwo, "level-three");
        string folderNamedNeedle = Path.Combine(TempRoot, "needle-folder");
        Directory.CreateDirectory(levelThree);
        Directory.CreateDirectory(folderNamedNeedle);
        string direct = Path.Combine(TempRoot, "also-needle.png");
        string mid = Path.Combine(levelOne, "CaseNeedle.JPG");
        string deep = Path.Combine(levelTwo, "deep-needle.png");
        string buried = Path.Combine(levelThree, "buried-needle.png");
        WriteValidPng(direct);
        WriteValidPng(mid);
        WriteValidPng(deep);
        WriteValidPng(buried);
        WriteValidPng(Path.Combine(folderNamedNeedle, "plain.png"));
        WriteValidPng(Path.Combine(levelOne, "other.png"));
        File.WriteAllText(Path.Combine(levelTwo, "notes-needle.txt"), "not an image");
        File.SetLastWriteTimeUtc(direct, DateTime.UnixEpoch.AddMinutes(1));
        File.SetLastWriteTimeUtc(mid, DateTime.UnixEpoch.AddMinutes(2));
        File.SetLastWriteTimeUtc(deep, DateTime.UnixEpoch.AddMinutes(3));
        File.SetLastWriteTimeUtc(buried, DateTime.UnixEpoch.AddMinutes(4));

        string[] Names(Newtonsoft.Json.Linq.JObject result) => result["files"].Select(row => (string)row["name"]).ToArray();
        string[] Folders(Newtonsoft.Json.Linq.JObject result) => result["files"].Select(row => (string)row["rel_dir"]).ToArray();
        Newtonsoft.Json.Linq.JObject matches = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "needle", true, "Name", true, true);
        Newtonsoft.Json.Linq.JObject upper = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "NEEDLE", true, "Name", true, true);
        Newtonsoft.Json.Linq.JObject nameDesc = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "needle", true, "Name", false, true);
        Newtonsoft.Json.Linq.JObject newest = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "needle", true, "Date", false, true);
        Newtonsoft.Json.Linq.JObject oldest = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "needle", true, "Date", true, true);
        Newtonsoft.Json.Linq.JObject directOnly = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "needle", true);
        Newtonsoft.Json.Linq.JObject folderName = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "needle-folder", true, "Name", true, true);
        Newtonsoft.Json.Linq.JObject page = SimpleImageBrowserAPI.ListFolder(TempRoot, 2, 1, "needle", true, "Name", true, true);

        Assert.That(Names(matches), Is.EqualTo(new[] { "also-needle.png", "buried-needle.png", "CaseNeedle.JPG", "deep-needle.png" }));
        Assert.That(Folders(matches), Is.EqualTo(new[] { "", "level-one/level-two/level-three", "level-one", "level-one/level-two" }));
        Assert.That(Names(upper), Is.EqualTo(Names(matches)));
        Assert.That(Names(nameDesc), Is.EqualTo(new[] { "deep-needle.png", "CaseNeedle.JPG", "buried-needle.png", "also-needle.png" }));
        Assert.That(Names(newest), Is.EqualTo(new[] { "buried-needle.png", "deep-needle.png", "CaseNeedle.JPG", "also-needle.png" }));
        Assert.That(Names(oldest), Is.EqualTo(new[] { "also-needle.png", "CaseNeedle.JPG", "deep-needle.png", "buried-needle.png" }));
        Assert.That((int)matches["total"], Is.EqualTo(4));
        Assert.That(matches["truncated"], Is.Null);
        Assert.That(matches["folders"].Select(row => (string)row["name"]), Is.EqualTo(new[] { "level-one", "needle-folder" }));
        Assert.That(Names(directOnly), Is.EqualTo(new[] { "also-needle.png" }));
        Assert.That(directOnly["files"][0]["rel_dir"], Is.Null);
        Assert.That(directOnly["truncated"], Is.Null);
        Assert.That(folderName["files"].Count(), Is.EqualTo(0));
        Assert.That((int)folderName["total"], Is.EqualTo(0));
        Assert.That(Names(page), Is.EqualTo(new[] { "CaseNeedle.JPG" }));
        Assert.That((int)page["next_offset"], Is.EqualTo(3));
    }

    /// <summary>Recursive search sorts the whole match set, then keeps 5000 and marks the page truncated.</summary>
    [Test]
    public void ListFolder_RecursiveSearchCapsSortedMatches()
    {
        string batchA = Path.Combine(TempRoot, "batch-a");
        string batchB = Path.Combine(batchA, "batch-b");
        Directory.CreateDirectory(batchB);
        int count = SimpleImageBrowserAPI.RecursiveMatchCap + 1;
        for (int i = 0; i < count; i++)
        {
            string directory = i < 200 ? TempRoot : i < 400 ? batchA : batchB;
            File.WriteAllBytes(Path.Combine(directory, $"match-{i:0000}.png"), new byte[] { 1 });
        }
        File.WriteAllText(Path.Combine(batchB, "match-notes.txt"), "not an image");

        Newtonsoft.Json.Linq.JObject first = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 48, "match", true, "Name", true, true);
        Newtonsoft.Json.Linq.JObject nested = SimpleImageBrowserAPI.ListFolder(TempRoot, 200, 1, "match", true, "Name", true, true);
        Newtonsoft.Json.Linq.JObject deeper = SimpleImageBrowserAPI.ListFolder(TempRoot, 400, 1, "match", true, "Name", true, true);
        int tailOffset = SimpleImageBrowserAPI.RecursiveMatchCap - 20;
        Newtonsoft.Json.Linq.JObject tail = SimpleImageBrowserAPI.ListFolder(TempRoot, tailOffset, 48, "match", true, "Name", true, true);
        Newtonsoft.Json.Linq.JObject direct = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 250, "match", true);

        Assert.That((int)first["total"], Is.EqualTo(SimpleImageBrowserAPI.RecursiveMatchCap));
        Assert.That((int)first["match_cap"], Is.EqualTo(SimpleImageBrowserAPI.RecursiveMatchCap));
        Assert.That((bool)first["truncated"], Is.True);
        Assert.That((string)first["files"][0]["name"], Is.EqualTo("match-0000.png"));
        Assert.That((string)first["files"][0]["rel_dir"], Is.EqualTo(""));
        Assert.That(first["folders"].Select(row => (string)row["name"]), Is.EqualTo(new[] { "batch-a" }));
        Assert.That((string)nested["files"][0]["name"], Is.EqualTo("match-0200.png"));
        Assert.That((string)nested["files"][0]["rel_dir"], Is.EqualTo("batch-a"));
        Assert.That((string)deeper["files"][0]["name"], Is.EqualTo("match-0400.png"));
        Assert.That((string)deeper["files"][0]["rel_dir"], Is.EqualTo("batch-a/batch-b"));
        Assert.That(tail["files"].Count(), Is.EqualTo(20));
        Assert.That((string)tail["files"].Last()["name"], Is.EqualTo($"match-{SimpleImageBrowserAPI.RecursiveMatchCap - 1:0000}.png"));
        Assert.That(tail["files"].Select(row => (string)row["name"]), Does.Not.Contain($"match-{SimpleImageBrowserAPI.RecursiveMatchCap:0000}.png"));
        Assert.That(tail["next_offset"].Type, Is.EqualTo(Newtonsoft.Json.Linq.JTokenType.Null));
        Assert.That((int)direct["total"], Is.EqualTo(200));
        Assert.That(direct["truncated"], Is.Null);
        Assert.That(direct["match_cap"], Is.Null);
        Assert.That(direct["files"][0]["rel_dir"], Is.Null);
    }

    /// <summary>An empty recursive listing returns images from every level, sorts across that set, and still leaves a non-recursive call on the current folder. An empty path stays the drive list.</summary>
    [Test]
    public void ListFolder_RecursiveEmptySearchListsNestedFiles()
    {
        string levelOne = Path.Combine(TempRoot, "level-one");
        string levelTwo = Path.Combine(levelOne, "level-two");
        string levelThree = Path.Combine(levelTwo, "level-three");
        string folderNamedNeedle = Path.Combine(TempRoot, "needle-folder");
        string dotFolder = Path.Combine(TempRoot, ".reference");
        Directory.CreateDirectory(levelThree);
        Directory.CreateDirectory(folderNamedNeedle);
        Directory.CreateDirectory(dotFolder);
        string direct = Path.Combine(TempRoot, "also-needle.png");
        string mid = Path.Combine(levelOne, "CaseNeedle.JPG");
        string deep = Path.Combine(levelTwo, "deep-needle.png");
        string buried = Path.Combine(levelThree, "buried-needle.png");
        string other = Path.Combine(levelOne, "other.png");
        string plain = Path.Combine(folderNamedNeedle, "plain.png");
        string reference = Path.Combine(dotFolder, "ref.png");
        WriteValidPng(direct);
        WriteValidPng(mid);
        WriteValidPng(deep);
        WriteValidPng(buried);
        WriteValidPng(other);
        WriteValidPng(plain);
        WriteValidPng(reference);
        File.WriteAllText(Path.Combine(levelTwo, "notes-needle.txt"), "not an image");
        File.SetLastWriteTimeUtc(direct, DateTime.UnixEpoch.AddMinutes(1));
        File.SetLastWriteTimeUtc(mid, DateTime.UnixEpoch.AddMinutes(2));
        File.SetLastWriteTimeUtc(deep, DateTime.UnixEpoch.AddMinutes(3));
        File.SetLastWriteTimeUtc(buried, DateTime.UnixEpoch.AddMinutes(4));
        File.SetLastWriteTimeUtc(other, DateTime.UnixEpoch.AddMinutes(5));
        File.SetLastWriteTimeUtc(plain, DateTime.UnixEpoch.AddMinutes(6));
        File.SetLastWriteTimeUtc(reference, DateTime.UnixEpoch.AddMinutes(7));

        string[] Names(Newtonsoft.Json.Linq.JObject result) => result["files"].Select(row => (string)row["name"]).ToArray();
        string[] Folders(Newtonsoft.Json.Linq.JObject result) => result["files"].Select(row => (string)row["rel_dir"]).ToArray();
        string[] expectedNames = new[] { "also-needle.png", "buried-needle.png", "CaseNeedle.JPG", "deep-needle.png", "other.png", "plain.png", "ref.png" };
        string[] expectedDirs = new[] { "", "level-one/level-two/level-three", "level-one", "level-one/level-two", "level-one", "needle-folder", ".reference" };
        Newtonsoft.Json.Linq.JObject all = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "", true, "Name", true, true);
        Newtonsoft.Json.Linq.JObject whitespace = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "   ", true, "Name", true, true);
        Newtonsoft.Json.Linq.JObject nameDesc = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "", true, "Name", false, true);
        Newtonsoft.Json.Linq.JObject newest = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "", true, "Date", false, true);
        Newtonsoft.Json.Linq.JObject oldest = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "", true, "Date", true, true);
        Newtonsoft.Json.Linq.JObject directOnly = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "", true);
        Newtonsoft.Json.Linq.JObject drives = SimpleImageBrowserAPI.ListFolder("", 0, 5, "", true, "Name", true, true);
        Newtonsoft.Json.Linq.JObject drivesSearched = SimpleImageBrowserAPI.ListFolder("", 0, 5, "needle", true, "Name", false, true);

        Assert.That(Names(all), Is.EqualTo(expectedNames));
        Assert.That(Folders(all), Is.EqualTo(expectedDirs));
        Assert.That(Names(whitespace), Is.EqualTo(expectedNames));
        Assert.That(Folders(whitespace), Is.EqualTo(expectedDirs));
        Assert.That((int)all["total"], Is.EqualTo(7));
        Assert.That((int)all["match_cap"], Is.EqualTo(SimpleImageBrowserAPI.RecursiveMatchCap));
        Assert.That(all["truncated"], Is.Null);
        Assert.That(all["folders"].Select(row => (string)row["name"]), Is.EqualTo(new[] { ".reference", "level-one", "needle-folder" }));
        Assert.That(Names(nameDesc), Is.EqualTo(new[] { "ref.png", "plain.png", "other.png", "deep-needle.png", "CaseNeedle.JPG", "buried-needle.png", "also-needle.png" }));
        Assert.That(Names(newest), Is.EqualTo(new[] { "ref.png", "plain.png", "other.png", "buried-needle.png", "deep-needle.png", "CaseNeedle.JPG", "also-needle.png" }));
        Assert.That(Folders(newest), Is.EqualTo(new[] { ".reference", "needle-folder", "level-one", "level-one/level-two/level-three", "level-one/level-two", "level-one", "" }));
        Assert.That(Names(oldest), Is.EqualTo(new[] { "also-needle.png", "CaseNeedle.JPG", "deep-needle.png", "buried-needle.png", "other.png", "plain.png", "ref.png" }));
        Assert.That(Names(directOnly), Is.EqualTo(new[] { "also-needle.png" }));
        Assert.That(directOnly["files"][0]["rel_dir"], Is.Null);
        Assert.That(directOnly["truncated"], Is.Null);
        Assert.That(directOnly["match_cap"], Is.Null);
        Assert.That((int)directOnly["total"], Is.EqualTo(1));
        Assert.That(drives["parent"].Type, Is.EqualTo(Newtonsoft.Json.Linq.JTokenType.Null));
        Assert.That(drives["files"].Count(), Is.EqualTo(0));
        Assert.That((int)drives["total"], Is.EqualTo(0));
        Assert.That(drives["truncated"], Is.Null);
        Assert.That(drives["folders"].Count(), Is.EqualTo(DriveInfo.GetDrives().Length));
        Assert.That(drivesSearched["files"].Count(), Is.EqualTo(0));
        Assert.That((int)drivesSearched["total"], Is.EqualTo(0));
        Assert.That(drivesSearched["truncated"], Is.Null);
        Assert.That(drivesSearched["folders"].Count(), Is.EqualTo(DriveInfo.GetDrives().Length));
    }

    /// <summary>An empty recursive listing sorts the whole tree, then keeps 5000 and marks the page truncated. recursive false stays on the current folder.</summary>
    [Test]
    public void ListFolder_RecursiveEmptySearchCapsSortedFiles()
    {
        string batchA = Path.Combine(TempRoot, "batch-a");
        string batchB = Path.Combine(batchA, "batch-b");
        Directory.CreateDirectory(batchB);
        int count = SimpleImageBrowserAPI.RecursiveMatchCap + 1;
        for (int i = 0; i < count; i++)
        {
            string directory = i < 200 ? TempRoot : i < 400 ? batchA : batchB;
            File.WriteAllBytes(Path.Combine(directory, $"img-{i:0000}.png"), new byte[] { 1 });
        }
        File.WriteAllText(Path.Combine(batchB, "notes.txt"), "not an image");

        string[] NamesOf(Newtonsoft.Json.Linq.JObject result) => result["files"].Select(row => (string)row["name"]).ToArray();
        Newtonsoft.Json.Linq.JObject first = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 48, "", true, "Name", true, true);
        Newtonsoft.Json.Linq.JObject whitespace = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 48, " ", true, "Name", true, true);
        Newtonsoft.Json.Linq.JObject nested = SimpleImageBrowserAPI.ListFolder(TempRoot, 200, 1, "", true, "Name", true, true);
        Newtonsoft.Json.Linq.JObject deeper = SimpleImageBrowserAPI.ListFolder(TempRoot, 400, 1, "", true, "Name", true, true);
        int tailOffset = SimpleImageBrowserAPI.RecursiveMatchCap - 20;
        Newtonsoft.Json.Linq.JObject tail = SimpleImageBrowserAPI.ListFolder(TempRoot, tailOffset, 48, "", true, "Name", true, true);
        Newtonsoft.Json.Linq.JObject direct = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 250, "", true);

        Assert.That((int)first["total"], Is.EqualTo(SimpleImageBrowserAPI.RecursiveMatchCap));
        Assert.That((int)first["match_cap"], Is.EqualTo(SimpleImageBrowserAPI.RecursiveMatchCap));
        Assert.That((bool)first["truncated"], Is.True);
        Assert.That((string)first["files"][0]["name"], Is.EqualTo("img-0000.png"));
        Assert.That((string)first["files"][0]["rel_dir"], Is.EqualTo(""));
        Assert.That(NamesOf(whitespace), Is.EqualTo(NamesOf(first)));
        Assert.That((bool)whitespace["truncated"], Is.True);
        Assert.That(first["folders"].Select(row => (string)row["name"]), Is.EqualTo(new[] { "batch-a" }));
        Assert.That((string)nested["files"][0]["name"], Is.EqualTo("img-0200.png"));
        Assert.That((string)nested["files"][0]["rel_dir"], Is.EqualTo("batch-a"));
        Assert.That((string)deeper["files"][0]["name"], Is.EqualTo("img-0400.png"));
        Assert.That((string)deeper["files"][0]["rel_dir"], Is.EqualTo("batch-a/batch-b"));
        Assert.That(tail["files"].Count(), Is.EqualTo(20));
        Assert.That((string)tail["files"].Last()["name"], Is.EqualTo($"img-{SimpleImageBrowserAPI.RecursiveMatchCap - 1:0000}.png"));
        Assert.That(tail["files"].Select(row => (string)row["name"]), Does.Not.Contain($"img-{SimpleImageBrowserAPI.RecursiveMatchCap:0000}.png"));
        Assert.That(tail["next_offset"].Type, Is.EqualTo(Newtonsoft.Json.Linq.JTokenType.Null));
        Assert.That((int)direct["total"], Is.EqualTo(200));
        Assert.That(direct["truncated"], Is.Null);
        Assert.That(direct["files"][0]["rel_dir"], Is.Null);
    }

    /// <summary>Output paging filters media before paging and keeps direct virtual folders visible.</summary>
    [Test]
    public void ListOutputImagePage_PagesFilesAndKeepsVirtualFolders()
    {
        string outputRoot = Path.Combine(TempRoot, "output");
        string specialRoot = Path.Combine(TempRoot, "special");
        Directory.CreateDirectory(outputRoot);
        Directory.CreateDirectory(specialRoot);
        Directory.CreateDirectory(Path.Combine(outputRoot, "physical"));
        WriteValidPng(Path.Combine(outputRoot, "physical", "child.png"));
        WriteValidPng(Path.Combine(specialRoot, "shared.png"));
        for (int i = 0; i < 102; i++)
        {
            string file = Path.Combine(outputRoot, $"needle-{i:000}.png");
            WriteValidPng(file);
            File.SetLastWriteTimeUtc(file, DateTime.UnixEpoch.AddSeconds(i));
        }
        File.WriteAllText(Path.Combine(outputRoot, "movie.mp4"), "video");
        string alias = $"inputs/_test_{Guid.NewGuid():N}/";
        UserImageHistoryHelper.SharedSpecialFolders[alias] = specialRoot;
        try
        {
            User user = RuntimeHelpers.GetUninitializedObject(typeof(User)) as User;
            user.Data = new User.DatabaseEntry() { ID = "simple-output-page-test" };
            user.Settings = new SwarmUI.Core.Settings.User();
            Session session = new() { User = user };
            Newtonsoft.Json.Linq.JObject first = SimpleImageBrowserAPI.ListOutputImagePage(session, "", outputRoot, 0, 48, "Date", true, "NEEDLE", new[] { "image" });
            Newtonsoft.Json.Linq.JObject middle = SimpleImageBrowserAPI.ListOutputImagePage(session, "", outputRoot, 48, 48, "Date", true, "needle", new[] { "image" });
            Newtonsoft.Json.Linq.JObject last = SimpleImageBrowserAPI.ListOutputImagePage(session, "", outputRoot, 96, 48, "Date", true, "needle", new[] { "image" });
            Newtonsoft.Json.Linq.JObject virtualParent = SimpleImageBrowserAPI.ListOutputImagePage(session, "inputs", outputRoot, 0, 48, "Name", false, "", new[] { "image" });
            Newtonsoft.Json.Linq.JObject dotRoot = SimpleImageBrowserAPI.ListOutputImagePage(session, ".", outputRoot, 0, 1, "Name", false, "", new[] { "image" });

            Assert.That(first["error"], Is.Null);
            Assert.That(first["folders"].Values<string>(), Does.Contain("physical"));
            Assert.That(first["folders"].Values<string>(), Does.Contain("inputs"));
            Assert.That(virtualParent["folders"].Values<string>(), Does.Contain(alias.Split('/')[1]));
            Assert.That(dotRoot["folders"].Values<string>(), Does.Contain("inputs"));
            Assert.That((int)first["total"], Is.EqualTo(102));
            Assert.That((string)first["files"][0]["src"], Is.EqualTo("needle-000.png"));
            Assert.That((string)middle["files"][0]["src"], Is.EqualTo("needle-048.png"));
            Assert.That(last["files"].Count(), Is.EqualTo(6));
            Assert.That(last["next_offset"].Type, Is.EqualTo(Newtonsoft.Json.Linq.JTokenType.Null));
            Assert.That((string)SimpleImageBrowserAPI.ListOutputImagePage(session, "../outside", outputRoot, 0, 1, "Name", false, "", new[] { "image" })["error_id"], Is.EqualTo("missing_folder"));
            Assert.That((string)SimpleImageBrowserAPI.ListOutputImagePage(session, "", outputRoot, -1, 1, "Name", false, "", new[] { "image" })["error_id"], Is.EqualTo("bad_page"));
        }
        finally
        {
            UserImageHistoryHelper.SharedSpecialFolders.TryRemove(alias, out _);
        }
    }

    /// <summary>Invalid, relative, stream, missing, and oversized paths fail without returning source data.</summary>
    [Test]
    public void ReadImage_RejectsUnsafeAndInvalidInputs()
    {
        string corrupt = Path.Combine(TempRoot, "corrupt.png");
        string large = Path.Combine(TempRoot, "large.png");
        string imageDirectory = Path.Combine(TempRoot, "directory.png");
        File.WriteAllText(corrupt, "not an image");
        Directory.CreateDirectory(imageDirectory);
        using (FileStream stream = new(large, FileMode.CreateNew, FileAccess.Write))
        {
            stream.SetLength(SimpleImageBrowserAPI.MaximumImageBytes + 1);
        }

        Assert.That((string)SimpleImageBrowserAPI.ReadImage("relative.png", false)["error_id"], Is.EqualTo("bad_path"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage(corrupt + ":stream", false)["error_id"], Is.EqualTo("bad_path"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage("//?/C:/bypass.png", false)["error_id"], Is.EqualTo("bad_path"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage(Path.Combine(TempRoot, "notes.txt"), false)["error_id"], Is.EqualTo("bad_path"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage(imageDirectory, false)["error_id"], Is.EqualTo("missing_image"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage(Path.Combine(TempRoot, "missing.png"), false)["error_id"], Is.EqualTo("missing_image"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage(corrupt, false)["error_id"], Is.EqualTo("unsupported_image"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage(large, false)["error_id"], Is.EqualTo("image_too_large"));
        Assert.That((string)SimpleImageBrowserAPI.ListFolder(Path.Combine(TempRoot, "missing"), 0, 10)["error_id"], Is.EqualTo("missing_folder"));
    }

    /// <summary>Full reads preserve valid source bytes and previews are decodable JPEG data URIs.</summary>
    [Test]
    public void ReadImage_ReturnsOriginalBytesAndJpegPreview()
    {
        string path = Path.Combine(TempRoot, "valid.png");
        byte[] expected = WriteValidPng(path, 1024, 512);

        string original = (string)SimpleImageBrowserAPI.ReadImage(path, false)["image"];
        string preview = (string)SimpleImageBrowserAPI.ReadImage(path, true)["image"];
        byte[] originalBytes = Convert.FromBase64String(original.Split(',')[1]);
        byte[] previewBytes = Convert.FromBase64String(preview.Split(',')[1]);

        Assert.That(original.StartsWith("data:image/png;base64,", StringComparison.Ordinal), Is.True);
        Assert.That(originalBytes, Is.EqualTo(expected));
        Assert.That(preview.StartsWith("data:image/jpeg;base64,", StringComparison.Ordinal), Is.True);
        using MagickImage previewImage = new(previewBytes);
        Assert.That(previewImage.Width, Is.LessThanOrEqualTo(256));
        Assert.That(previewImage.Height, Is.LessThanOrEqualTo(256));
        Assert.That(previewImage.Width, Is.EqualTo(256));
        Assert.That(previewImage.Height, Is.EqualTo(128));
    }

    /// <summary>TIFF selections become lossless browser-readable PNG attachments without changing the source.</summary>
    [Test]
    public void ReadImage_ConvertsTiffToPngWithoutChangingSource()
    {
        string path = Path.Combine(TempRoot, "valid.tiff");
        using MagickImage source = new(MagickColors.Transparent, 8, 4);
        using MagickImage dot = new(new MagickColor((ushort)(12 * 257), (ushort)(34 * 257), (ushort)(56 * 257), Quantum.Max), 1, 1);
        source.Composite(dot, 2, 1, CompositeOperator.Over);
        source.Write(path, MagickFormat.Tiff);
        byte[] originalBytes = File.ReadAllBytes(path);

        string selected = (string)SimpleImageBrowserAPI.ReadImage(path, false)["image"];
        Assert.That(selected.StartsWith("data:image/png;base64,", StringComparison.Ordinal), Is.True);
        byte[] selectedBytes = Convert.FromBase64String(selected.Split(',')[1]);
        using MagickImage decoded = new(selectedBytes);
        Assert.That(decoded.Width, Is.EqualTo(source.Width));
        Assert.That(decoded.Height, Is.EqualTo(source.Height));
        using IMagickImage<ushort> pixel = decoded.Clone();
        pixel.Crop(new MagickGeometry(2, 1, 1, 1));
        pixel.ResetPage();
        pixel.Depth = 8;
        byte[] rgba = pixel.ToByteArray(MagickFormat.Rgba);
        Assert.That(rgba.Length, Is.GreaterThanOrEqualTo(4));
        Assert.That(rgba[0], Is.EqualTo(12));
        Assert.That(rgba[1], Is.EqualTo(34));
        Assert.That(rgba[2], Is.EqualTo(56));
        Assert.That(rgba[3], Is.EqualTo(255));
        Assert.That(File.ReadAllBytes(path), Is.EqualTo(originalBytes));
    }

    /// <summary>With the guard active, a listed TIFF is refused and the source file stays unchanged.</summary>
    [Test]
    public void ReadImage_RefusesTiffWhenGuardIsActive()
    {
        string path = Path.Combine(TempRoot, "guarded.tiff");
        using (MagickImage source = new(MagickColors.Red, 8, 4))
        {
            source.Write(path, MagickFormat.Tiff);
        }
        byte[] originalBytes = File.ReadAllBytes(path);
        bool prior = TiffDecodeGuardExtension.Active;
        try
        {
            TiffDecodeGuardExtension.Active = true;
            Newtonsoft.Json.Linq.JObject result = SimpleImageBrowserAPI.ReadImage(path, false);
            Assert.That((string)result["error_id"], Is.EqualTo("unsupported_image"));
            Assert.That(File.ReadAllBytes(path), Is.EqualTo(originalBytes));
        }
        finally
        {
            TiffDecodeGuardExtension.Active = prior;
        }
    }

    /// <summary>Direct API entry points deny callers before they inspect a path.</summary>
    [Test]
    public async System.Threading.Tasks.Task Api_DeniesUsersWithoutBrowsePermission()
    {
        User user = RuntimeHelpers.GetUninitializedObject(typeof(User)) as User;
        user.CalculatedRole = new Role("browser-test");
        Session session = new() { User = user };

        Newtonsoft.Json.Linq.JObject readDenied = await SimpleImageBrowserAPI.ReadSimpleImage(session, Path.Combine(TempRoot, "never-read.png"));
        Newtonsoft.Json.Linq.JObject listDenied = await SimpleImageBrowserAPI.ListSimpleImageFolder(session, TempRoot);
        Newtonsoft.Json.Linq.JObject nullReadDenied = await SimpleImageBrowserAPI.ReadSimpleImage(null, Path.Combine(TempRoot, "never-read.png"));
        Newtonsoft.Json.Linq.JObject nullListDenied = await SimpleImageBrowserAPI.ListSimpleImageFolder(null, TempRoot);
        Newtonsoft.Json.Linq.JObject searchedListDenied = await SimpleImageBrowserAPI.ListSimpleImageFolder(session, TempRoot, 48, 48, "needle", true);

        Assert.That((string)readDenied["error_id"], Is.EqualTo("bad_permissions"));
        Assert.That((string)listDenied["error_id"], Is.EqualTo("bad_permissions"));
        Assert.That((string)nullReadDenied["error_id"], Is.EqualTo("bad_permissions"));
        Assert.That((string)nullListDenied["error_id"], Is.EqualTo("bad_permissions"));
        Assert.That((string)searchedListDenied["error_id"], Is.EqualTo("bad_permissions"));
    }

    /// <summary>Negative output page limits are rejected instead of using the legacy recursive listing.</summary>
    [Test]
    public async System.Threading.Tasks.Task ListImages_RejectsNegativePageLimit()
    {
        User user = RuntimeHelpers.GetUninitializedObject(typeof(User)) as User;
        user.Data = new User.DatabaseEntry() { ID = "negative-output-page-test" };
        user.Settings = new SwarmUI.Core.Settings.User();
        Session session = new() { User = user };

        Newtonsoft.Json.Linq.JObject result = await T2IAPI.ListImages(session, "", 1, limit: -1);

        Assert.That((string)result["error_id"], Is.EqualTo("bad_page"));
    }

    /// <summary>The recursive listing cache reuses a fresh page, expires on its clock, and evicts the least recently used entry.</summary>
    [Test]
    public void RecursiveListingCache_ExpiresAndEvictsLeastRecentlyUsed()
    {
        long now = 0;
        RecursiveListingCache cache = new(2, RecursiveListingCache.DefaultTtlMilliseconds, () => now);
        T2IAPI.ImageHistorySortMode name = T2IAPI.ImageHistorySortMode.Name;
        RecursiveListingCache.Key Key(string user, string path, string search, bool reverse = true)
        {
            return RecursiveListingCache.CreateKey(user, path, search, name, reverse);
        }
        string folder = OperatingSystem.IsWindows() ? @"C:\Photos" : "/photos";
        string folderSlash = OperatingSystem.IsWindows() ? @"C:\Photos\" : "/photos/";
        string otherCase = OperatingSystem.IsWindows() ? @"c:\photos" : "/Photos";
        string otherFolder = OperatingSystem.IsWindows() ? @"C:\Elsewhere" : "/elsewhere";
        List<string> alpha = new() { "a.png" };
        List<string> beta = new() { "b.png" };
        List<string> gamma = new() { "c.png" };

        cache.Store(Key("user-a", folderSlash, "Needle"), alpha, false);
        Assert.That(cache.TryGet(Key("user-a", folder, "needle"), out List<string> same, out bool truncated), Is.True);
        Assert.That(same, Is.EqualTo(alpha));
        Assert.That(truncated, Is.False);
        Assert.That(cache.TryGet(Key("user-a", folder, " needle "), out _, out _), Is.False);
        Assert.That(cache.TryGet(Key("user-a", folder, "   "), out _, out _), Is.False);
        Assert.That(cache.TryGet(Key("user-b", folder, "needle"), out _, out _), Is.False);
        Assert.That(cache.TryGet(Key("user-a", otherCase, "NEEDLE"), out _, out _), Is.EqualTo(OperatingSystem.IsWindows()));
        Assert.That(cache.CountEntries(), Is.EqualTo(1));

        now = RecursiveListingCache.DefaultTtlMilliseconds - 1;
        Assert.That(cache.TryGet(Key("user-a", folder, "needle"), out _, out _), Is.True);
        now = RecursiveListingCache.DefaultTtlMilliseconds;
        Assert.That(cache.TryGet(Key("user-a", folder, "needle"), out _, out _), Is.False);
        Assert.That(cache.CountEntries(), Is.EqualTo(0));

        now = 0;
        cache.Store(Key("user-a", folder, ""), alpha, true);
        now = 50_000;
        cache.Store(Key("user-a", folder, ""), beta, false);
        now = 100_000;
        Assert.That(cache.TryGet(Key("user-a", folder, ""), out List<string> refreshed, out truncated), Is.True);
        Assert.That(refreshed, Is.EqualTo(beta));
        Assert.That(truncated, Is.False);
        now = 110_000;
        Assert.That(cache.TryGet(Key("user-a", folder, ""), out _, out _), Is.False);

        now = 200_000;
        cache.Store(Key("user-a", folder, ""), alpha, false);
        cache.Store(Key("user-a", otherFolder, ""), beta, false);
        Assert.That(cache.TryGet(Key("user-a", folder, ""), out _, out _), Is.True);
        cache.Store(Key("user-a", folder + "-c", ""), gamma, true);
        Assert.That(cache.TryGet(Key("user-a", otherFolder, ""), out _, out _), Is.False);
        Assert.That(cache.TryGet(Key("user-a", folder, ""), out _, out _), Is.True);
        Assert.That(cache.TryGet(Key("user-a", folder + "-c", ""), out List<string> kept, out truncated), Is.True);
        Assert.That(kept, Is.EqualTo(gamma));
        Assert.That(truncated, Is.True);

        cache.Clear();
        now = 300_000;
        cache.Store(Key("user-a", folder, ""), alpha, false);
        cache.Store(Key("user-b", folder, ""), beta, false);
        Assert.That(cache.CountEntries(), Is.EqualTo(2));
        cache.Invalidate(null, folder);
        Assert.That(cache.CountEntries(), Is.EqualTo(0));
        Assert.That(cache.TryGet(Key("user-a", folder, ""), out _, out _), Is.False);
        Assert.That(cache.TryGet(Key("user-b", folder, ""), out _, out _), Is.False);
        cache.Store(Key("user-a", folder, ""), alpha, false);
        cache.Store(Key("user-a", otherFolder, ""), beta, false);
        cache.Invalidate("user-a", null);
        Assert.That(cache.CountEntries(), Is.EqualTo(0));
        cache.Store(Key("user-a", folder, ""), alpha, false);
        cache.Invalidate(null, null);
        Assert.That(cache.CountEntries(), Is.EqualTo(1));
        cache.Clear();
        Assert.That(cache.CountEntries(), Is.EqualTo(0));

        RecursiveListingCache concurrent = new(16, RecursiveListingCache.DefaultTtlMilliseconds, () => Environment.TickCount64);
        System.Threading.Tasks.Parallel.For(0, 64, i =>
        {
            RecursiveListingCache.Key key = RecursiveListingCache.CreateKey("user-" + (i % 4), folder + "/" + (i % 8), i % 2 == 0 ? "a" : "A", name, true);
            concurrent.Store(key, new List<string>() { "f" + i }, false);
            concurrent.TryGet(key, out List<string> files, out bool hitTruncated);
            Assert.That(hitTruncated, Is.False);
            if (files is not null)
            {
                Assert.That(files.Count, Is.EqualTo(1));
            }
            if (i % 5 == 0)
            {
                concurrent.Invalidate("user-" + (i % 4), folder + "/" + (i % 8));
            }
        });
    }

    /// <summary>A later Drives page reuses the cached scan. The first page, another user, another sort, expiry, and invalidation scan again. A missing or invalid path never reads the cache.</summary>
    [Test]
    public void ListFolder_RecursiveLaterPageReusesCachedListing()
    {
        RecursiveListingCache previous = SimpleImageBrowserAPI.RecursiveListings;
        long now = 1_000_000;
        SimpleImageBrowserAPI.RecursiveListings = new RecursiveListingCache(clock: () => now);
        try
        {
            WriteValidPng(Path.Combine(TempRoot, "a.png"));
            WriteValidPng(Path.Combine(TempRoot, "b.png"));
            Assert.That(SimpleImageBrowserAPI.RecursiveListings.CountEntries(), Is.EqualTo(0));
            Newtonsoft.Json.Linq.JObject direct = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "", true, "Name", true, false, "user-a");
            Assert.That((int)direct["total"], Is.EqualTo(2));
            Assert.That(direct["match_cap"], Is.Null);
            Assert.That(SimpleImageBrowserAPI.RecursiveListings.CountEntries(), Is.EqualTo(0));

            Newtonsoft.Json.Linq.JObject first = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 1, "", true, "Name", true, true, "user-a");
            Assert.That((int)first["total"], Is.EqualTo(2));
            Assert.That((int)first["match_cap"], Is.EqualTo(SimpleImageBrowserAPI.RecursiveMatchCap));
            Assert.That((string)first["files"][0]["name"], Is.EqualTo("a.png"));
            WriteValidPng(Path.Combine(TempRoot, "c.png"));
            Newtonsoft.Json.Linq.JObject reused = SimpleImageBrowserAPI.ListFolder(TempRoot, 1, 1, "", true, "Name", true, true, "user-a");
            Assert.That((int)reused["total"], Is.EqualTo(2));
            Assert.That((string)reused["files"][0]["name"], Is.EqualTo("b.png"));
            if (OperatingSystem.IsWindows())
            {
                Newtonsoft.Json.Linq.JObject cased = SimpleImageBrowserAPI.ListFolder(FlipPathCase(TempRoot), 1, 1, "", true, "Name", true, true, "user-a");
                Assert.That((int)cased["total"], Is.EqualTo(2));
                Assert.That((string)cased["files"][0]["name"], Is.EqualTo("b.png"));
            }
            Newtonsoft.Json.Linq.JObject otherUser = SimpleImageBrowserAPI.ListFolder(TempRoot, 1, 1, "", true, "Name", true, true, "user-b");
            Assert.That((int)otherUser["total"], Is.EqualTo(3));
            Newtonsoft.Json.Linq.JObject refreshed = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 1, "", true, "Name", true, true, "user-a");
            Assert.That((int)refreshed["total"], Is.EqualTo(3));
            Assert.That((string)refreshed["files"][0]["name"], Is.EqualTo("a.png"));

            WriteValidPng(Path.Combine(TempRoot, "d.png"));
            Newtonsoft.Json.Linq.JObject otherSort = SimpleImageBrowserAPI.ListFolder(TempRoot, 1, 1, "", true, "Date", false, true, "user-a");
            Assert.That((int)otherSort["total"], Is.EqualTo(4));
            Newtonsoft.Json.Linq.JObject stillCached = SimpleImageBrowserAPI.ListFolder(TempRoot, 1, 1, "", true, "Name", true, true, "user-a");
            Assert.That((int)stillCached["total"], Is.EqualTo(3));

            WriteValidPng(Path.Combine(TempRoot, "only-a.png"));
            Newtonsoft.Json.Linq.JObject search = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 10, "only-a", true, "Name", true, true, "user-a");
            Assert.That((int)search["total"], Is.EqualTo(1));
            WriteValidPng(Path.Combine(TempRoot, "only-a-2.png"));
            Newtonsoft.Json.Linq.JObject searchReuse = SimpleImageBrowserAPI.ListFolder(TempRoot, 1, 10, "ONLY-A", true, "Name", true, true, "user-a");
            Assert.That((int)searchReuse["total"], Is.EqualTo(1));
            Assert.That(searchReuse["files"].Count(), Is.EqualTo(0));
            now += RecursiveListingCache.DefaultTtlMilliseconds;
            Newtonsoft.Json.Linq.JObject expired = SimpleImageBrowserAPI.ListFolder(TempRoot, 1, 10, "ONLY-A", true, "Name", true, true, "user-a");
            Assert.That((int)expired["total"], Is.EqualTo(2));

            WriteValidPng(Path.Combine(TempRoot, "only-a-3.png"));
            SimpleImageBrowserAPI.RecursiveListings.Invalidate(null, TempRoot);
            Newtonsoft.Json.Linq.JObject afterInvalidate = SimpleImageBrowserAPI.ListFolder(TempRoot, 1, 10, "only-a", true, "Name", true, true, "user-a");
            Assert.That((int)afterInvalidate["total"], Is.EqualTo(3));
            Assert.That((string)SimpleImageBrowserAPI.ListFolder("not-absolute", 1, 10, "", true, "Name", true, true, "user-a")["error_id"], Is.EqualTo("bad_path"));
            Directory.Delete(TempRoot, true);
            Assert.That((string)SimpleImageBrowserAPI.ListFolder(TempRoot, 1, 10, "", true, "Name", true, true, "user-a")["error_id"], Is.EqualTo("missing_folder"));
        }
        finally
        {
            SimpleImageBrowserAPI.RecursiveListings = previous;
        }
    }

    /// <summary>Flips the first letter so a Windows path differs only by case.</summary>
    private static string FlipPathCase(string path)
    {
        char[] chars = path.ToCharArray();
        for (int i = 0; i < chars.Length; i++)
        {
            if (char.IsLetter(chars[i]))
            {
                chars[i] = char.IsUpper(chars[i]) ? char.ToLowerInvariant(chars[i]) : char.ToUpperInvariant(chars[i]);
                return new string(chars);
            }
        }
        return path;
    }
}
