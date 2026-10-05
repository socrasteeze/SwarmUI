using System;
using System.Collections.Generic;
using System.IO;
using NUnit.Framework;
using SwarmUI.Accounts;
using SwarmUI.Utils;

namespace SwarmUITests;

/// <summary>Tests preset Output Root validation, history folder names, and shared-folder registration.</summary>
[TestFixture]
[NonParallelizable]
public class PresetOutputRootTests : SwarmUITest
{
    static readonly string[] Drives = ["D:\\", "E:\\"];

    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Drops folders this feature registered. Foreign keys are removed by the test that added them.</summary>
    [TearDown]
    public static void ClearOwnedFolders()
    {
        PresetOutputRoot.Refresh([], Drives);
    }

    /// <summary>A blank root is the server output root.</summary>
    [Test]
    public static void TestValidate_Blank()
    {
        Assert.That(PresetOutputRoot.Validate(null, Drives), Is.Null);
        Assert.That(PresetOutputRoot.Validate("", Drives), Is.Null);
        Assert.That(PresetOutputRoot.Validate("   ", Drives), Is.Null);
    }

    /// <summary>A full path is normalized without calling the operating system.</summary>
    [Test]
    public static void TestValidate_Normalizes()
    {
        Assert.That(PresetOutputRoot.Validate("D:/shots/sub", Drives), Is.EqualTo("D:\\shots\\sub"));
        Assert.That(PresetOutputRoot.Validate("d:\\shots", ["d:/"]), Is.EqualTo("D:\\shots"));
        Assert.That(PresetOutputRoot.Validate("D:\\shots\\", Drives), Is.EqualTo("D:\\shots"));
        Assert.That(PresetOutputRoot.Validate("D:\\", Drives), Is.EqualTo("D:\\"));
        Assert.That(PresetOutputRoot.Validate("D:/", Drives), Is.EqualTo("D:\\"));
        Assert.That(PresetOutputRoot.Validate("D:\\shots\\.\\a\\..\\b", Drives), Is.EqualTo("D:\\shots\\b"));
        Assert.That(PresetOutputRoot.Validate("D:\\\\shots\\\\sub", Drives), Is.EqualTo("D:\\shots\\sub"));
        Assert.That(PresetOutputRoot.Validate("D:\\sho~ts", Drives), Is.EqualTo("D:\\sho~ts"));
        Assert.That(PresetOutputRoot.Validate("D:\\shots&more", Drives), Is.EqualTo("D:\\shots&more"));
    }

    /// <summary>A relative path, a list, or a missing drive is refused.</summary>
    [Test]
    public static void TestValidate_Refuses()
    {
        Expect("D:\\shots;E:\\other", "Output Root must be a single path.");
        Expect("shots", "Output Root must be a full path.");
        Expect(".\\shots", "Output Root must be a full path.");
        Expect("..\\shots", "Output Root must be a full path.");
        Expect("/shots", "Output Root must be a full path.");
        Expect("C:shots", "Output Root must be a full path.");
        Expect("D:", "Output Root must be a full path.");
        Expect("D:\\shots\\..\\..", "Output Root must be a full path.");
        Expect("D:\\shots\\a\"b", "Output Root must be a full path.");
        Expect("D:\\shots\\a*b", "Output Root must be a full path.");
        Expect("D:\\sho:ts", "Output Root must be a full path.");
        Expect("D:\\shots\u0001", "Output Root must be a full path.");
        Expect("\\\\server\\share", "Output Root must be on a real drive.");
        Expect("//server/share", "Output Root must be on a real drive.");
        Expect("Z:\\shots\\..\\..", "Output Root must be on a real drive.");
    }

    /// <summary>The last non-blank root wins, and a blank does not clear an earlier one.</summary>
    [Test]
    public static void TestChooseOutputRoot()
    {
        Assert.That(PresetOutputRoot.ChooseOutputRoot(null), Is.Null);
        Assert.That(PresetOutputRoot.ChooseOutputRoot(["", "  ", null]), Is.Null);
        Assert.That(PresetOutputRoot.ChooseOutputRoot(["D:\\a", "", "D:\\b"]), Is.EqualTo("D:\\b"));
        Assert.That(PresetOutputRoot.ChooseOutputRoot(["D:\\a", "  "]), Is.EqualTo("D:\\a"));
    }

    /// <summary>The history path is a folder name plus the format path.</summary>
    [Test]
    public static void TestPrefixHistoryPath()
    {
        Assert.That(PresetOutputRoot.PrefixHistoryPath("flux/shot.png", null), Is.EqualTo("flux/shot.png"));
        Assert.That(PresetOutputRoot.PrefixHistoryPath("flux/shot.png", "  "), Is.EqualTo("flux/shot.png"));
        string prefixed = PresetOutputRoot.PrefixHistoryPath("/flux/shot.png", "shots");
        Assert.That(prefixed, Is.EqualTo("shots/flux/shot.png"));
        Assert.That(prefixed, Does.Not.Contain(":"));
    }

    /// <summary>Same-leaf roots get one bare name and a stable suffix for the rest.</summary>
    [Test]
    public static void TestAssignFolderNames_SameLeafAndCasing()
    {
        string first = "D:\\presetrootshots";
        string second = "E:\\archive\\presetrootshots";
        Dictionary<string, string> names = PresetOutputRoot.AssignFolderNames([second, first]);
        Assert.That(names[first], Is.EqualTo("presetrootshots"));
        Assert.That(names[second], Is.EqualTo("presetrootshots_" + PresetOutputRoot.ShortHash(second)));
        string upper = "D:\\Shots";
        string lower = "E:\\archive\\shots";
        Dictionary<string, string> cased = PresetOutputRoot.AssignFolderNames([lower, upper]);
        Assert.That(cased[upper], Is.EqualTo("Shots"));
        Assert.That(cased[lower], Is.EqualTo("shots_" + PresetOutputRoot.ShortHash(lower)));
        Dictionary<string, string> same = PresetOutputRoot.AssignFolderNames(["D:\\Shots", "D:\\shots"]);
        Assert.That(same.Count, Is.EqualTo(1));
        Assert.That(same["D:\\Shots"], Is.EqualTo("Shots"));
    }

    /// <summary>Bare drives, empty leaves, dots, and a tilde each get a distinct history name.</summary>
    [Test]
    public static void TestAssignFolderNames_SpecialLeaves()
    {
        Dictionary<string, string> drives = PresetOutputRoot.AssignFolderNames(["D:\\", "E:\\"]);
        Assert.That(drives["D:\\"], Is.EqualTo("drive_D"));
        Assert.That(drives["E:\\"], Is.EqualTo("drive_E"));
        string bare = "D:\\";
        string named = "D:\\drive_D";
        Dictionary<string, string> clash = PresetOutputRoot.AssignFolderNames([named, bare]);
        Assert.That(clash[bare], Is.EqualTo("drive_D"));
        Assert.That(clash[named], Is.EqualTo("drive_D_" + PresetOutputRoot.ShortHash(named)));
        string empty = "D:\\???";
        Dictionary<string, string> fallback = PresetOutputRoot.AssignFolderNames([empty]);
        Assert.That(fallback[empty], Is.EqualTo("drive_D_" + PresetOutputRoot.ShortHash(empty)));
        Assert.That(PresetOutputRoot.AssignFolderNames(["D:\\v1.0"])["D:\\v1.0"], Is.EqualTo("v1.0"));
        string plain = "D:\\shots";
        string tilde = "D:\\sho~ts";
        Dictionary<string, string> stripped = PresetOutputRoot.AssignFolderNames([tilde, plain]);
        Assert.That(stripped[plain], Is.EqualTo("shots"));
        Assert.That(stripped[tilde], Is.EqualTo("shots_" + PresetOutputRoot.ShortHash(tilde)));
    }

    /// <summary>The suffix is six lowercase hex characters and ignores path case.</summary>
    [Test]
    public static void TestShortHash()
    {
        string hash = PresetOutputRoot.ShortHash("D:\\shots");
        Assert.That(hash, Does.Match("^[0-9a-f]{6}$"));
        Assert.That(hash.Length, Is.EqualTo(6));
        Assert.That(PresetOutputRoot.ShortHash("D:\\SHOTS"), Is.EqualTo(hash));
    }

    /// <summary>Invalid roots are skipped. An empty refresh removes only keys this feature owns.</summary>
    [Test]
    public static void TestRefresh_OwnsOnlyItsKeys()
    {
        string comfyKey = "_comfy_presetroot_test/";
        UserImageHistoryHelper.SharedSpecialFolders[comfyKey] = "E:\\comfy-presetroot-foreign";
        try
        {
            Dictionary<string, string> map = PresetOutputRoot.Refresh(["D:\\presetrootkeep", "not-a-path", "C:\\shots;D:\\shots"], Drives);
            Assert.That(map["D:\\presetrootkeep"], Is.EqualTo("presetrootkeep"));
            Assert.That(UserImageHistoryHelper.SharedSpecialFolders["presetrootkeep/"], Is.EqualTo("D:\\presetrootkeep"));
            Assert.That(UserImageHistoryHelper.SharedSpecialFolders.ContainsKey(comfyKey), Is.True);
            Assert.That(PresetOutputRoot.OwnedFolderKeys.Contains(comfyKey), Is.False);
            PresetOutputRoot.Refresh([], Drives);
            Assert.That(UserImageHistoryHelper.SharedSpecialFolders.ContainsKey("presetrootkeep/"), Is.False);
            Assert.That(UserImageHistoryHelper.SharedSpecialFolders[comfyKey], Is.EqualTo("E:\\comfy-presetroot-foreign"));
            Assert.That(PresetOutputRoot.OwnedFolderKeys.Contains(comfyKey), Is.False);
        }
        finally
        {
            UserImageHistoryHelper.SharedSpecialFolders.TryRemove(comfyKey, out _);
        }
    }

    /// <summary>A key Comfy already owns is not taken. The preset root is registered beside it.</summary>
    [Test]
    public static void TestRefresh_DoesNotTakeForeignKey()
    {
        string foreign = "presetrootshots/";
        string foreignPath = "E:\\presetroot-foreign";
        UserImageHistoryHelper.SharedSpecialFolders[foreign] = foreignPath;
        try
        {
            string path = "D:\\presetrootshots";
            string hash = PresetOutputRoot.ShortHash(path);
            Dictionary<string, string> map = PresetOutputRoot.Refresh([path], Drives);
            Assert.That(UserImageHistoryHelper.SharedSpecialFolders[foreign], Is.EqualTo(foreignPath));
            string expectedKey = "presetrootshots_" + hash + "/";
            Assert.That(UserImageHistoryHelper.SharedSpecialFolders.ContainsKey(expectedKey), Is.True);
            Assert.That(UserImageHistoryHelper.SharedSpecialFolders[expectedKey], Is.EqualTo(path));
            Assert.That(PresetOutputRoot.OwnedFolderKeys.Contains(foreign), Is.False);
            Assert.That(PresetOutputRoot.OwnedFolderKeys.Contains(expectedKey), Is.True);
            Assert.That(map[path], Is.EqualTo("presetrootshots_" + hash));
        }
        finally
        {
            UserImageHistoryHelper.SharedSpecialFolders.TryRemove(foreign, out _);
        }
    }

    /// <summary>Registering a root does not create the directory.</summary>
    [Test]
    public static void TestEnsureMapped_DoesNotCreateDirectory()
    {
        string path = "D:\\swarm-preset-root-unit-test-" + Guid.NewGuid().ToString("N");
        Assert.That(Directory.Exists(path), Is.False);
        string folder = PresetOutputRoot.EnsureMapped(path, Drives);
        Assert.That(Directory.Exists(path), Is.False);
        Assert.That(folder, Does.Not.Contain(":"));
        Assert.That(folder, Does.Not.Contain("\\"));
        Assert.That(UserImageHistoryHelper.SharedSpecialFolders[folder + "/"], Is.EqualTo(path));
    }

    /// <summary>A registered history folder resolves onto the real directory, not the server output root.</summary>
    [Test]
    public static void TestGetRealPathFor_RewritesHistoryFolder()
    {
        string output = Path.Combine(Path.GetTempPath(), "swarm-output-root-" + Guid.NewGuid().ToString("N"));
        string real = Path.Combine(Path.GetTempPath(), "swarm-real-root-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(output);
        Directory.CreateDirectory(real);
        string key = "_presetroottest_" + Guid.NewGuid().ToString("N") + "/";
        try
        {
            UserImageHistoryHelper.SharedSpecialFolders[key] = real;
            string history = PresetOutputRoot.PrefixHistoryPath("flux/shot.png", key.TrimEnd('/'));
            Assert.That(history, Does.Not.Contain(":"));
            string request = Path.Combine(output, history.Replace('/', Path.DirectorySeparatorChar));
            string resolved = UserImageHistoryHelper.GetRealPathFor(null, request, output);
            string realFull = Path.GetFullPath(real).Replace('\\', '/');
            string outputFull = Path.GetFullPath(output).Replace('\\', '/');
            Assert.That(resolved, Does.Not.Contain("\\"));
            Assert.That(resolved, Does.StartWith(realFull));
            Assert.That(resolved, Does.Not.StartWith(outputFull));
            Assert.That(resolved, Does.Contain("/flux/shot.png"));
        }
        finally
        {
            UserImageHistoryHelper.SharedSpecialFolders.TryRemove(key, out _);
            if (Directory.Exists(output))
            {
                Directory.Delete(output, true);
            }
            if (Directory.Exists(real))
            {
                Directory.Delete(real, true);
            }
        }
    }

    /// <summary>Asserts that validation refuses <paramref name="raw"/> with <paramref name="message"/>.</summary>
    static void Expect(string raw, string message)
    {
        SwarmUserErrorException ex = Assert.Throws<SwarmUserErrorException>(() => PresetOutputRoot.Validate(raw, Drives));
        Assert.That(ex.Message, Is.EqualTo(message));
    }
}
