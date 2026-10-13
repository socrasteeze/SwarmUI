using NUnit.Framework;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using System;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;

namespace SwarmUITests;

/// <summary>Exercises stale cache replacement, bounded retries, and interrupted writes against real files.</summary>
[TestFixture]
[NonParallelizable]
public class SpokeCacheFreshnessTests : SwarmUITest
{
    /// <summary>Temporary roots and original settings.</summary>
    private string Root, Share, Cache, SavedRoot, SavedCache;

    /// <summary>Original runtime spoke flag.</summary>
    private bool SavedSpoke;

    /// <summary>Initializes the shared test environment.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Creates isolated file trees and enables spoke cache policy.</summary>
    [SetUp]
    public void Init()
    {
        Root = Path.Combine(Path.GetTempPath(), $"swarm-cache-freshness-{Guid.NewGuid():N}");
        Share = Path.Combine(Root, "share");
        Cache = Path.Combine(Root, "cache");
        Directory.CreateDirectory(Path.Combine(Share, "checkpoints"));
        Directory.CreateDirectory(Path.Combine(Cache, "checkpoints"));
        SavedRoot = Program.ServerSettings.Paths.ModelRoot;
        SavedCache = Program.ServerSettings.Paths.SpokeModelCache;
        SavedSpoke = Program.IsSpokeMode;
        Program.ServerSettings.Paths.ModelRoot = Share;
        Program.ServerSettings.Paths.SpokeModelCache = Cache;
        SetSpoke(true);
    }

    /// <summary>Restores process settings and removes only this fixture's temporary tree.</summary>
    [TearDown]
    public void Cleanup()
    {
        Program.ServerSettings.Paths.ModelRoot = SavedRoot;
        Program.ServerSettings.Paths.SpokeModelCache = SavedCache;
        SetSpoke(SavedSpoke);
        foreach (string file in Directory.GetFiles(Root, "*", SearchOption.AllDirectories))
        {
            File.SetAttributes(file, FileAttributes.Normal);
        }
        Directory.Delete(Root, true);
    }

    /// <summary>Sets the private runtime-mode setter used by the established spoke fixtures.</summary>
    private static void SetSpoke(bool active)
    {
        typeof(Program).GetProperty(nameof(Program.IsSpokeMode), BindingFlags.Public | BindingFlags.Static).GetSetMethod(true).Invoke(null, [active]);
    }

    /// <summary>Creates a known model whose source modification time can be changed deterministically.</summary>
    private T2IModel Model(int bytes = 32)
    {
        string folder = Path.Combine(Share, "checkpoints");
        string source = Path.Combine(folder, "model.safetensors");
        File.WriteAllBytes(source, new byte[bytes]);
        File.SetLastWriteTimeUtc(source, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        T2IModelHandler handler = new() { ModelType = "Test", FolderPaths = [folder] };
        return new T2IModel(handler, folder, source, "model.safetensors");
    }

    /// <summary>A same-size source replacement must invalidate the old local bytes.</summary>
    [Test]
    public async Task SameSizeReplacementUsesNewModificationTime()
    {
        T2IModel model = Model();
        string target = SpokeModelCache.CacheTargetFor(model);
        Assert.That(await SpokeModelCache.EnsureCached(model), Is.True);
        byte[] replacement = new byte[32];
        Array.Fill(replacement, (byte)42);
        File.WriteAllBytes(model.RawFilePath, replacement);
        File.SetLastWriteTimeUtc(model.RawFilePath, new DateTime(2026, 1, 2, 0, 0, 0, DateTimeKind.Utc));
        Assert.That(await SpokeModelCache.EnsureCached(model), Is.True);
        Assert.That(File.ReadAllBytes(target), Is.EqualTo(replacement));
        Assert.That(File.GetLastWriteTimeUtc(target), Is.EqualTo(File.GetLastWriteTimeUtc(model.RawFilePath)));
    }

    /// <summary>A Windows loader handle that denies deletion stops the transfer before any partial is created.
    /// Repairing the handle does not retrigger the expensive copy until cooldown or a new source version.</summary>
    [Test]
    [Platform("Win")]
    public async Task LockedStaleTargetFailsBeforeCopyAndSuppressesRetry()
    {
        T2IModel model = Model();
        string target = SpokeModelCache.CacheTargetFor(model);
        File.WriteAllBytes(target, new byte[1]);
        using (FileStream locked = new(target, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            Assert.That(await SpokeModelCache.EnsureCached(model), Is.False);
            Assert.That(File.Exists($"{target}.partial"), Is.False);
            Assert.That(new FileInfo(target).Length, Is.EqualTo(1));
        }
        Assert.That(await SpokeModelCache.EnsureCached(model), Is.False, "same source must respect failure cooldown after the handle is repaired");
        File.SetLastWriteTimeUtc(model.RawFilePath, new DateTime(2026, 1, 3, 0, 0, 0, DateTimeKind.Utc));
        Assert.That(await SpokeModelCache.EnsureCached(model), Is.True, "a changed source can retry immediately");
    }

    /// <summary>Concurrent requests produce one complete output, with no stale or partial siblings left.</summary>
    [Test]
    public async Task ConcurrentRequestsReuseOneCompleteCopy()
    {
        T2IModel model = Model(2 * 1024 * 1024);
        bool[] results = await Task.WhenAll(SpokeModelCache.EnsureCached(model), SpokeModelCache.EnsureCached(model), SpokeModelCache.EnsureCached(model));
        Assert.That(results, Is.All.True);
        Assert.That(Directory.GetFiles(Cache, "*", SearchOption.AllDirectories), Has.Length.EqualTo(1));
        Assert.That(File.ReadAllBytes(SpokeModelCache.CacheTargetFor(model)), Is.EqualTo(File.ReadAllBytes(model.RawFilePath)));
    }

    /// <summary>Cancellation after a partial appears removes it and allows the next request to fill the cache.</summary>
    [Test]
    public async Task InterruptedTransferRemovesPartialAndCanRetry()
    {
        T2IModel model = Model(64 * 1024 * 1024);
        string target = SpokeModelCache.CacheTargetFor(model);
        using CancellationTokenSource cancel = new();
        Task<bool> copy = Task.Run(() => SpokeModelCache.EnsureCached(model, cancel.Token));
        long deadline = Environment.TickCount64 + 5000;
        while (!File.Exists($"{target}.partial") && !copy.IsCompleted && Environment.TickCount64 < deadline)
        {
            await Task.Yield();
        }
        cancel.Cancel();
        Assert.CatchAsync<OperationCanceledException>(async () => await copy);
        Assert.That(File.Exists($"{target}.partial"), Is.False);
        Assert.That(File.Exists(target), Is.False);
        Assert.That(await SpokeModelCache.EnsureCached(model), Is.True);
    }
}
