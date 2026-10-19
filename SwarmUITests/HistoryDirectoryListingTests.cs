using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using SwarmUI.Accounts;
using SwarmUI.WebAPI;

namespace SwarmUITests;

/// <summary>Tests history directory enumeration when a folder is missing, dangling, or dot-prefixed.</summary>
[TestFixture]
[NonParallelizable]
public class HistoryDirectoryListingTests : SwarmUITest
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
        TempRoot = Path.Combine(Path.GetTempPath(), "swarm-history-list-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(TempRoot);
    }

    /// <summary>Removes only the throwaway filesystem fixture.</summary>
    [TearDown]
    public void RemoveFixture()
    {
        if (Directory.Exists(TempRoot))
        {
            Directory.Delete(TempRoot, true);
        }
    }

    /// <summary>A directory that is not on disk is an empty listing, not an exception.</summary>
    [Test]
    public void TryEnumerate_MissingDirectory_IsEmpty()
    {
        string missing = Path.Combine(TempRoot, "missing");
        Assert.That(UserImageHistoryHelper.TryEnumerateDirectories(missing), Is.Empty);
        Assert.That(UserImageHistoryHelper.TryEnumerateFiles(missing), Is.Empty);
    }

    /// <summary>A real directory returns its immediate children, and the file cap stops early.</summary>
    [Test]
    public void TryEnumerate_RealDirectory_ReturnsImmediateChildren()
    {
        Directory.CreateDirectory(Path.Combine(TempRoot, "child"));
        File.WriteAllText(Path.Combine(TempRoot, "one.png"), "media");
        File.WriteAllText(Path.Combine(TempRoot, "two.png"), "media");
        File.WriteAllText(Path.Combine(TempRoot, "three.png"), "media");

        Assert.That(Names(UserImageHistoryHelper.TryEnumerateDirectories(TempRoot)), Is.EquivalentTo(new[] { "child" }));
        Assert.That(Names(UserImageHistoryHelper.TryEnumerateFiles(TempRoot)), Is.EquivalentTo(new[] { "one.png", "two.png", "three.png" }));
        Assert.That(UserImageHistoryHelper.TryEnumerateFiles(TempRoot, 1).Length, Is.EqualTo(1));
    }

    /// <summary>Unrelated argument failures still propagate.</summary>
    [Test]
    public void TryEnumerate_NullPath_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => UserImageHistoryHelper.TryEnumerateDirectories(null));
        Assert.Throws<ArgumentNullException>(() => UserImageHistoryHelper.TryEnumerateFiles(null));
    }

    /// <summary>A link whose target was removed is an empty listing, not an exception.</summary>
    [Test]
    public void TryEnumerate_DanglingDirectoryLink_IsEmpty()
    {
        string target = Path.Combine(TempRoot, "target");
        string link = Path.Combine(TempRoot, "link");
        Directory.CreateDirectory(target);
        bool created = false;
        try
        {
            created = TryCreateDirectoryLink(link, target);
            if (!created)
            {
                Assert.Ignore("Directory link creation is not permitted in this environment.");
            }
            Directory.Delete(target, true);
            Assert.That(UserImageHistoryHelper.TryEnumerateDirectories(link), Is.Empty);
            Assert.That(UserImageHistoryHelper.TryEnumerateFiles(link), Is.Empty);
        }
        finally
        {
            if (created)
            {
                DeleteLink(link);
            }
        }
    }

    /// <summary>Dot-prefixed history names and paths are excluded. Underscore folders are not.</summary>
    [Test]
    public void DotPrefixedHistoryNames_AreExcluded()
    {
        Assert.That(UserImageHistoryHelper.IsDotPrefixedHistoryName(".trash"), Is.True);
        Assert.That(UserImageHistoryHelper.IsDotPrefixedHistoryName(".starred"), Is.True);
        Assert.That(UserImageHistoryHelper.IsDotPrefixedHistoryName("_trash"), Is.False);
        Assert.That(UserImageHistoryHelper.IsDotPrefixedHistoryName("kept"), Is.False);
        Assert.That(UserImageHistoryHelper.IsDotPrefixedHistoryName(""), Is.False);
        Assert.That(UserImageHistoryHelper.IsDotPrefixedHistoryName(null), Is.False);
        Assert.That(UserImageHistoryHelper.IsDotPrefixedHistoryPath("kept/.trash"), Is.True);
        Assert.That(UserImageHistoryHelper.IsDotPrefixedHistoryPath(".starred/inner"), Is.True);
        Assert.That(UserImageHistoryHelper.IsDotPrefixedHistoryPath("inputs/_comfy0"), Is.False);
        Assert.That(UserImageHistoryHelper.IsDotPrefixedHistoryPath("_trash"), Is.False);
    }

    /// <summary>History listing skips dot-prefixed folders and a dangling child without failing the rest of the folder.</summary>
    [Test]
    public void HistoryListing_SkipsDotFoldersAndDanglingDirectories()
    {
        string root = Path.Combine(TempRoot, "output");
        Directory.CreateDirectory(Path.Combine(root, "kept", "deeper"));
        Directory.CreateDirectory(Path.Combine(root, ".trash"));
        Directory.CreateDirectory(Path.Combine(root, "_trash", "deeper"));
        File.WriteAllText(Path.Combine(root, "kept", "deeper", "saved.png"), "media");
        File.WriteAllText(Path.Combine(root, ".trash", "secret.png"), "media");
        File.WriteAllText(Path.Combine(root, "_trash", "deeper", "kept.png"), "media");
        string target = Path.Combine(TempRoot, "target");
        string link = Path.Combine(root, "dangling");
        Directory.CreateDirectory(target);
        bool linked = TryCreateDirectoryLink(link, target);
        if (linked)
        {
            Directory.Delete(target, true);
        }
        string starred = Path.Combine(TempRoot, "starred");
        Directory.CreateDirectory(starred);
        File.WriteAllText(Path.Combine(starred, "star.png"), "media");
        string alias = ".starred-" + Guid.NewGuid().ToString("N") + "/";
        UserImageHistoryHelper.SharedSpecialFolders[alias] = Path.GetFullPath(starred);
        try
        {
            User user = (User)RuntimeHelpers.GetUninitializedObject(typeof(User));
            user.Data = new User.DatabaseEntry() { ID = "history-listing-test" };
            user.Settings = new SwarmUI.Core.Settings.User() { MaxImagesInHistory = 20, MaxImagesScannedInHistory = 20 };
            Session session = new() { User = user };
            MethodInfo listing = typeof(T2IAPI).GetMethod("GetListAPIInternal", BindingFlags.NonPublic | BindingFlags.Static);
            JObject result = (JObject)listing.Invoke(null, [session, "", root, T2IAPI.HistoryExtensions, (Func<string, bool>)(_ => true), 2, T2IAPI.ImageHistorySortMode.Name, false, null]);
            List<string> folders = result["folders"].Values<string>().ToList();

            Assert.That(result["error"], Is.Null);
            Assert.That(folders, Does.Contain("kept"));
            Assert.That(folders, Does.Contain("_trash"));
            Assert.That(folders, Does.Not.Contain(".trash"));
            Assert.That(folders.Any(UserImageHistoryHelper.IsDotPrefixedHistoryPath), Is.False);
        }
        finally
        {
            UserImageHistoryHelper.SharedSpecialFolders.TryRemove(alias, out _);
            if (linked)
            {
                DeleteLink(link);
            }
        }
    }

    /// <summary>Returns the file name of each path.</summary>
    private static string[] Names(IEnumerable<string> paths)
    {
        return paths.Select(Path.GetFileName).ToArray();
    }

    /// <summary>Creates a directory link to <paramref name="target"/>. On Windows a junction is preferred because a dangling junction still reports that it exists.</summary>
    private static bool TryCreateDirectoryLink(string link, string target)
    {
        if (OperatingSystem.IsWindows() && TryCreateJunction(link, target))
        {
            return true;
        }
        try
        {
            Directory.CreateSymbolicLink(link, target);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or PlatformNotSupportedException or NotSupportedException)
        {
            DeleteLink(link);
            return false;
        }
    }

    /// <summary>Creates a Windows directory junction. Returns false when the process cannot create one.</summary>
    private static bool TryCreateJunction(string link, string target)
    {
        try
        {
            ProcessStartInfo start = new()
            {
                FileName = "cmd.exe",
                Arguments = "/c mklink /J \"" + link + "\" \"" + target + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using Process process = Process.Start(start);
            if (process is null)
            {
                return false;
            }
            Task<string> outputTask = process.StandardOutput.ReadToEndAsync();
            Task<string> errorTask = process.StandardError.ReadToEndAsync();
            bool exited = process.WaitForExit(10000);
            outputTask.GetAwaiter().GetResult();
            errorTask.GetAwaiter().GetResult();
            if (!exited)
            {
                process.Kill(true);
                return false;
            }
            return process.ExitCode == 0;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    /// <summary>Removes a directory link without following it into the target.</summary>
    private static void DeleteLink(string link)
    {
        try
        {
            if (Directory.Exists(link))
            {
                Directory.Delete(link, false);
                return;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or DirectoryNotFoundException)
        {
        }
        try
        {
            if (File.Exists(link))
            {
                File.Delete(link);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }
}
