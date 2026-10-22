using NUnit.Framework;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace SwarmUITests;

/// <summary>Exercises refresh diagnostics over isolated synthetic model folders and cache rows.</summary>
[TestFixture]
[NonParallelizable]
public class ModelRefreshTimingIntegrationTests : SwarmUITest
{
    /// <summary>Initializes the shared test environment used by metadata tests.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Nested parallel scanning records cache outcomes and leaves synthetic source files unchanged.</summary>
    [Test]
    public void NestedRefreshLogsCountersAndPreservesWarmSources()
    {
        string root = Path.Combine(Path.GetTempPath(), $"swarm-refresh-timing-{Guid.NewGuid():N}");
        string data = Path.Combine(root, "data");
        string modelRoot = Path.Combine(root, "models");
        string firstFolder = Path.Combine(modelRoot, "first");
        string secondFolder = Path.Combine(modelRoot, "second");
        Directory.CreateDirectory(data);
        Directory.CreateDirectory(firstFolder);
        Directory.CreateDirectory(secondFolder);

        string savedDataDir = Program.DataDir;
        bool savedPerFolder = Program.ServerSettings.Metadata.ModelMetadataPerFolder;
        Action savedRefreshEvent = Program.ModelRefreshEvent;
        Logs.LogLevel savedMinimumLevel = Logs.MinimumLevel;
        HashSet<string> oldCacheKeys = [.. T2IModelHandler.ModelMetadataCachePerFolder.Keys];
        string cacheKey = $"{data}/model_metadata.ldb";
        T2IModelHandler handler = new() { ModelType = "Synthetic" };
        T2IModelHandler.ModelDatabase cache = null;
        try
        {
            Program.DataDir = data;
            Program.ServerSettings.Metadata.ModelMetadataPerFolder = false;
            Program.ModelRefreshEvent = null;
            handler.FolderPaths = [modelRoot];
            cache = handler.GetCacheForFolder(data);
            (string ModelPath, string SidecarPath) first = CreateSyntheticModel(firstFolder, "cached-one", true);
            (string ModelPath, string SidecarPath) second = CreateSyntheticModel(secondFolder, "cached-two", true);
            (string ModelPath, string SidecarPath) missing = CreateSyntheticModel(secondFolder, "uncached-three", false);
            Seed(cache, first.ModelPath, first.SidecarPath);
            Seed(cache, second.ModelPath, second.SidecarPath);

            Dictionary<string, (byte[] Model, DateTime ModelTime, byte[] Sidecar, DateTime SidecarTime)> expected = new()
            {
                [first.ModelPath] = Snapshot(first.ModelPath, first.SidecarPath),
                [second.ModelPath] = Snapshot(second.ModelPath, second.SidecarPath),
                [missing.ModelPath] = Snapshot(missing.ModelPath, missing.SidecarPath)
            };
            long beforeFirstRefresh = Logs.LogTracker.LastSequenceID;
            Logs.MinimumLevel = Logs.LogLevel.None;
            handler.Refresh();
            string firstSummary = GetNewInfoMessages(beforeFirstRefresh).Single(message => message.StartsWith("Model refresh diagnostics (Synthetic):", StringComparison.Ordinal));

            long beforeWarmRefresh = Logs.LogTracker.LastSequenceID;
            handler.Refresh();
            string warmSummary = GetNewInfoMessages(beforeWarmRefresh).Single(message => message.StartsWith("Model refresh diagnostics (Synthetic):", StringComparison.Ordinal));

            Assert.That(firstSummary, Does.Contain("cache-lookups=3"));
            Assert.That(firstSummary, Does.Contain("hits=2"));
            Assert.That(firstSummary, Does.Contain("misses=1"));
            Assert.That(firstSummary, Does.Contain("preview-attempts=0"));
            Assert.That(warmSummary, Does.Contain("cache-lookups=3"));
            Assert.That(warmSummary, Does.Contain("hits=3"));
            Assert.That(warmSummary, Does.Contain("misses=0"));
            Assert.That(warmSummary, Does.Contain("preview-attempts=0"));
            AssertSourcesUnchanged(expected);
        }
        finally
        {
            Program.ModelRefreshEvent = savedRefreshEvent;
            Program.DataDir = savedDataDir;
            Program.ServerSettings.Metadata.ModelMetadataPerFolder = savedPerFolder;
            Logs.MinimumLevel = savedMinimumLevel;
            if (cache is not null)
            {
                T2IModelHandler.ModelMetadataCachePerFolder.TryRemove(cacheKey, out _);
                cache.Database.Dispose();
            }
            foreach (string key in T2IModelHandler.ModelMetadataCachePerFolder.Keys)
            {
                if (key.StartsWith(data, StringComparison.Ordinal) && !oldCacheKeys.Contains(key))
                {
                    T2IModelHandler.ModelMetadataCachePerFolder.TryRemove(key, out T2IModelHandler.ModelDatabase unexpected);
                    unexpected?.Database.Dispose();
                }
            }
            Directory.Delete(root, true);
        }
    }

    /// <summary>Create one synthetic safetensors model and optional sidecar.</summary>
    private static (string ModelPath, string SidecarPath) CreateSyntheticModel(string folder, string stem, bool withSidecar)
    {
        string modelPath = Path.Combine(folder, $"{stem}.safetensors");
        string sidecarPath = Path.Combine(folder, $"{stem}.swarm.json");
        byte[] header = Encoding.UTF8.GetBytes("{\"__metadata__\":{}}");
        using (FileStream file = File.Create(modelPath))
        {
            file.Write(BitConverter.GetBytes((long)header.Length));
            file.Write(header);
        }
        if (withSidecar)
        {
            File.WriteAllText(sidecarPath, "{\"modelspec.title\":\"synthetic cache\"}");
        }
        return (modelPath, sidecarPath);
    }

    /// <summary>Insert a matching metadata row for a synthetic model.</summary>
    private static void Seed(T2IModelHandler.ModelDatabase cache, string modelPath, string sidecarPath)
    {
        string rawPath = modelPath.Replace('\\', '/');
        long modelVersion = new DateTimeOffset(File.GetLastWriteTimeUtc(modelPath)).ToUnixTimeMilliseconds();
        long sidecarVersion = new DateTimeOffset(File.GetLastWriteTimeUtc(sidecarPath)).ToUnixTimeMilliseconds();
        cache.Metadata.Upsert(new T2IModelHandler.ModelMetadataStore()
        {
            ModelName = rawPath,
            ModelFileVersion = modelVersion,
            SidecarFileVersion = sidecarVersion,
            SidecarVersionKnown = true,
            Title = Path.GetFileName(modelPath),
            PreviewImage = T2IModelHandler.PlaceholderPreviewImage,
            TimeModified = modelVersion,
            TimeCreated = modelVersion
        });
    }

    /// <summary>Capture synthetic model and sidecar bytes and modification times.</summary>
    private static (byte[] Model, DateTime ModelTime, byte[] Sidecar, DateTime SidecarTime) Snapshot(string modelPath, string sidecarPath)
    {
        return (File.ReadAllBytes(modelPath), File.GetLastWriteTimeUtc(modelPath), File.Exists(sidecarPath) ? File.ReadAllBytes(sidecarPath) : [], File.Exists(sidecarPath) ? File.GetLastWriteTimeUtc(sidecarPath) : DateTime.MinValue);
    }

    /// <summary>Assert the model and sidecar source bytes and mtimes remain unchanged.</summary>
    private static void AssertSourcesUnchanged(Dictionary<string, (byte[] Model, DateTime ModelTime, byte[] Sidecar, DateTime SidecarTime)> expected)
    {
        foreach (KeyValuePair<string, (byte[] Model, DateTime ModelTime, byte[] Sidecar, DateTime SidecarTime)> item in expected)
        {
            string sidecarPath = Path.Combine(Path.GetDirectoryName(item.Key), Path.GetFileNameWithoutExtension(item.Key) + ".swarm.json");
            Assert.That(File.ReadAllBytes(item.Key), Is.EqualTo(item.Value.Model));
            Assert.That(File.GetLastWriteTimeUtc(item.Key), Is.EqualTo(item.Value.ModelTime));
            if (item.Value.Sidecar.Length > 0)
            {
                Assert.That(File.ReadAllBytes(sidecarPath), Is.EqualTo(item.Value.Sidecar));
                Assert.That(File.GetLastWriteTimeUtc(sidecarPath), Is.EqualTo(item.Value.SidecarTime));
            }
            else
            {
                Assert.That(File.Exists(sidecarPath), Is.False);
            }
        }
    }

    /// <summary>Read newly tracked info messages after the supplied sequence.</summary>
    private static string[] GetNewInfoMessages(long afterSequence)
    {
        Logs.LogTracker tracker = Logs.Trackers[(int)Logs.LogLevel.Info];
        lock (tracker.Lock)
        {
            return [.. tracker.Messages.Where(message => message.Sequence > afterSequence).Select(message => message.Message)];
        }
    }
}
