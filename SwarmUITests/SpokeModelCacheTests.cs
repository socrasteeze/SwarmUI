using NUnit.Framework;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using System;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;

namespace SwarmUITests;

/// <summary>Tests the spoke's local model cache: what it will and will not write, and that a cached copy is
/// byte-complete and reused.</summary>
[TestFixture]
[NonParallelizable]
public class SpokeModelCacheTests : SwarmUITest
{
    private string TestRoot, ShareRoot, CacheRoot;
    private string SavedModelRoot, SavedCache;

    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Builds a throwaway shared tree and cache root, and points the settings at them.</summary>
    [SetUp]
    public void MakeRoots()
    {
        TestRoot = Path.Combine(Path.GetTempPath(), $"swarm-spoke-cache-{Guid.NewGuid():N}");
        ShareRoot = Path.Combine(TestRoot, "share");
        CacheRoot = Path.Combine(TestRoot, "cache");
        Directory.CreateDirectory(Path.Combine(ShareRoot, "checkpoints", "sub"));
        Directory.CreateDirectory(CacheRoot);
        SavedModelRoot = Program.ServerSettings.Paths.ModelRoot;
        SavedCache = Program.ServerSettings.Paths.SpokeModelCache;
        Program.ServerSettings.Paths.ModelRoot = ShareRoot;
        Program.ServerSettings.Paths.SpokeModelCache = CacheRoot;
        SetSpokeMode(true);
    }

    /// <summary>Restores settings and runtime mode, and removes the temp tree.</summary>
    [TearDown]
    public void RemoveRoots()
    {
        SetSpokeMode(false);
        Program.ServerSettings.Paths.ModelRoot = SavedModelRoot;
        Program.ServerSettings.Paths.SpokeModelCache = SavedCache;
        if (Directory.Exists(TestRoot))
        {
            Directory.Delete(TestRoot, true);
        }
    }

    private static void SetSpokeMode(bool active)
    {
        PropertyInfo property = typeof(Program).GetProperty(nameof(Program.IsSpokeMode), BindingFlags.Public | BindingFlags.Static);
        property.GetSetMethod(true).Invoke(null, [active]);
    }

    private T2IModel MakeModel(string relative, int bytes)
    {
        string path = Path.Combine(ShareRoot, relative);
        byte[] data = new byte[bytes];
        new Random(bytes).NextBytes(data);
        File.WriteAllBytes(path, data);
        T2IModelHandler handler = new() { ModelType = "Test", FolderPaths = [Path.Combine(ShareRoot, "checkpoints")] };
        return new T2IModel(handler, Path.Combine(ShareRoot, "checkpoints"), path, relative.Replace('\\', '/').Substring("checkpoints/".Length));
    }

    /// <summary>The cache mirrors the shared tree's relative layout, so ComfyUI's folder names line up on both sides.</summary>
    [Test]
    public void TestTargetMirrorsRelativePath()
    {
        T2IModel model = MakeModel(Path.Combine("checkpoints", "sub", "a.safetensors"), 16);
        Assert.That(SpokeModelCache.CacheTargetFor(model), Is.EqualTo(Path.GetFullPath(Path.Combine(CacheRoot, "checkpoints", "sub", "a.safetensors"))));
    }

    /// <summary>A file outside every model root is not the hub's model tree and must never be copied.</summary>
    [Test]
    public void TestOutsideModelRootIsNotCacheable()
    {
        string stray = Path.Combine(TestRoot, "stray.safetensors");
        File.WriteAllBytes(stray, new byte[8]);
        T2IModelHandler handler = new() { ModelType = "Test", FolderPaths = [TestRoot] };
        T2IModel model = new(handler, TestRoot, stray, "stray.safetensors");
        Assert.That(SpokeModelCache.CacheTargetFor(model), Is.Null);
        Assert.That(SpokeModelCache.EnsureCached(model).Result, Is.False);
    }

    /// <summary>First use copies byte-for-byte; a second use finds the copy and does not rewrite it.</summary>
    [Test]
    public async Task TestFirstUseCopiesAndSecondUseReuses()
    {
        T2IModel model = MakeModel(Path.Combine("checkpoints", "b.safetensors"), 3 * 1024 * 1024 + 7);
        string target = SpokeModelCache.CacheTargetFor(model);
        Assert.That(File.Exists(target), Is.False);
        Assert.That(await SpokeModelCache.EnsureCached(model), Is.True);
        Assert.That(File.Exists(target), Is.True);
        Assert.That(File.ReadAllBytes(target), Is.EqualTo(File.ReadAllBytes(model.RawFilePath)));
        Assert.That(File.Exists($"{target}.partial"), Is.False);
        DateTime firstWrite = File.GetLastWriteTimeUtc(target);
        await Task.Delay(30);
        Assert.That(await SpokeModelCache.EnsureCached(model), Is.True);
        Assert.That(File.GetLastWriteTimeUtc(target), Is.EqualTo(firstWrite), "a byte-complete cached copy must not be rewritten");
    }

    /// <summary>A cached file whose size no longer matches the source is stale and gets replaced, not served.</summary>
    [Test]
    public async Task TestSizeMismatchIsRecopied()
    {
        T2IModel model = MakeModel(Path.Combine("checkpoints", "c.safetensors"), 4096);
        string target = SpokeModelCache.CacheTargetFor(model);
        Directory.CreateDirectory(Path.GetDirectoryName(target));
        File.WriteAllBytes(target, new byte[10]);
        Assert.That(await SpokeModelCache.EnsureCached(model), Is.True);
        Assert.That(new FileInfo(target).Length, Is.EqualTo(4096));
    }

    /// <summary>Off a spoke, or with no cache root, the cache does nothing at all.</summary>
    [Test]
    public void TestDisabledWhenNotSpokeOrUnconfigured()
    {
        T2IModel model = MakeModel(Path.Combine("checkpoints", "d.safetensors"), 64);
        SetSpokeMode(false);
        Assert.That(SpokeModelCache.Enabled, Is.False);
        Assert.That(SpokeModelCache.EnsureCached(model).Result, Is.False);
        SetSpokeMode(true);
        Program.ServerSettings.Paths.SpokeModelCache = "";
        Assert.That(SpokeModelCache.Enabled, Is.False);
        Assert.That(SpokeModelCache.EnsureCached(model).Result, Is.False);
        Assert.That(Directory.GetFiles(CacheRoot, "*", SearchOption.AllDirectories), Is.Empty);
    }
}
