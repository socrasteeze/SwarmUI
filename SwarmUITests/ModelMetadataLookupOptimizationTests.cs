using LiteDB;
using NUnit.Framework;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace SwarmUITests;

/// <summary>Checks cached metadata projection and duplicate-source scan behavior with synthetic files.</summary>
[TestFixture]
[NonParallelizable]
public class ModelMetadataLookupOptimizationTests : SwarmUITest
{
    /// <summary>Initializes shared helpers.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>The cached projection preserves metadata, defaults missing legacy flags, omits previews, and uses the ID index.</summary>
    [Test]
    public void PreviewFreeProjectionPreservesFieldsAndUsesIdIndex()
    {
        WithSyntheticCache((handler, cache, root) =>
        {
            string modelPath = CreateModel(root, "projected.safetensors");
            long version = VersionOf(modelPath);
            T2IModelHandler.ModelMetadataStore expected = FullMetadata(modelPath, version);
            BsonDocument legacy = cache.Database.Mapper.ToDocument(expected);
            legacy.Remove(nameof(T2IModelHandler.ModelMetadataStore.PreviewExplicitlyCleared));
            cache.Database.GetCollection("models").Insert(legacy);

            BsonExpression firstProjection = T2IModelHandler.MetadataProjectionFor(cache.Database.Mapper);
            BsonExpression secondProjection = T2IModelHandler.MetadataProjectionFor(cache.Database.Mapper);
            BsonDocument plan = T2IModelHandler.MetadataLookupQuery(cache, modelPath.Replace('\\', '/')).GetPlan();
            T2IModel model = new(handler, root, modelPath.Replace('\\', '/'), "projected.safetensors") { Title = "projected.safetensors" };
            handler.LoadMetadata(model);

            Assert.That(secondProjection, Is.SameAs(firstProjection));
            Assert.That(plan.ToString(), Does.Contain("INDEX SEEK(_id"));
            Assert.That(model.Metadata.PreviewIsDeferred, Is.True);
            Assert.That(model.Metadata.LocalPreview, Is.Null);
            Assert.That(model.Metadata.PreviewExplicitlyCleared, Is.False);
            AssertProjectedFields(model.Metadata, expected);
            Assert.That(T2IModel.PreviewDataFor(model), Is.EqualTo(expected.PreviewImage));
        });
    }

    /// <summary>Later roots skip only exact relative duplicates while unique and differently nested names still load.</summary>
    [Test]
    public void RefreshSkipsExactLaterRootMetadataAndKeepsAllPaths()
    {
        WithSyntheticCache((handler, cache, root) =>
        {
            string firstRoot = Path.Combine(root, "first");
            string secondRoot = Path.Combine(root, "second");
            string primary = CreateModel(firstRoot, Path.Combine("shared", "same.safetensors"));
            string secondary = CreateModel(secondRoot, Path.Combine("shared", "same.safetensors"));
            string firstNested = CreateModel(firstRoot, Path.Combine("alpha", "same.safetensors"));
            string secondNested = CreateModel(secondRoot, Path.Combine("beta", "same.safetensors"));
            string upper = CreateModel(firstRoot, "Case.safetensors");
            string lower = CreateModel(secondRoot, "case.safetensors");
            string unique = CreateModel(secondRoot, "unique.safetensors");
            Seed(cache, primary, "primary");
            Seed(cache, secondary, "secondary");
            Seed(cache, firstNested, "first nested");
            Seed(cache, secondNested, "second nested");
            Seed(cache, upper, "upper");
            Seed(cache, lower, "lower");
            Seed(cache, unique, "unique");
            handler.FolderPaths = [firstRoot, secondRoot];

            long beforeRefresh = Logs.LogTracker.LastSequenceID;
            handler.Refresh();
            string summary = NewInfoMessages(beforeRefresh).Single(message => message.StartsWith("Model refresh diagnostics (Synthetic):", StringComparison.Ordinal));

            Assert.That(handler.Models.Count, Is.EqualTo(6));
            Assert.That(handler.Models["shared/same.safetensors"].Title, Is.EqualTo("primary"));
            Assert.That(handler.Models["shared/same.safetensors"].OtherPaths, Does.Contain(secondary.Replace('\\', '/')));
            Assert.That(handler.Models["alpha/same.safetensors"].Title, Is.EqualTo("first nested"));
            Assert.That(handler.Models["beta/same.safetensors"].Title, Is.EqualTo("second nested"));
            Assert.That(handler.Models["Case.safetensors"].Title, Is.EqualTo("upper"));
            Assert.That(handler.Models["case.safetensors"].Title, Is.EqualTo("lower"));
            Assert.That(handler.Models["unique.safetensors"].Title, Is.EqualTo("unique"));
            Assert.That(summary, Does.Contain("cache-lookups=6"));
            Assert.That(summary, Does.Contain("duplicate-sources-skipped=1"));
        });
    }

    /// <summary>Repeated and syntactically aliased roots retain exact-key semantics and avoid repeated metadata lookups.</summary>
    [Test]
    public void RepeatedRootSkipsRepeatedMetadataLookup()
    {
        WithSyntheticCache((handler, cache, root) =>
        {
            string models = Path.Combine(root, "models");
            string path = CreateModel(models, "repeat.safetensors");
            Seed(cache, path, "first");
            handler.FolderPaths = [models, models + Path.DirectorySeparatorChar, models];

            long beforeRefresh = Logs.LogTracker.LastSequenceID;
            handler.Refresh();
            string summary = NewInfoMessages(beforeRefresh).Single(message => message.StartsWith("Model refresh diagnostics (Synthetic):", StringComparison.Ordinal));

            Assert.That(handler.Models.Count, Is.EqualTo(1));
            Assert.That(handler.Models["repeat.safetensors"].Title, Is.EqualTo("first"));
            Assert.That(handler.Models["repeat.safetensors"].OtherPaths, Does.Contain(path.Replace('\\', '/')));
            Assert.That(summary, Does.Contain("cache-lookups=1"));
            Assert.That(summary, Does.Contain("duplicate-sources-skipped=2"));
        });
    }

    /// <summary>An unavailable root keeps the previously complete inventory after duplicate-scan optimization.</summary>
    [Test]
    public void UnavailableRootPreservesPreviousInventory()
    {
        WithSyntheticCache((handler, cache, root) =>
        {
            string models = Path.Combine(root, "models");
            string path = CreateModel(models, "kept.safetensors");
            Seed(cache, path, "kept");
            handler.FolderPaths = [models];
            handler.Refresh();
            T2IModel previous = handler.Models["kept.safetensors"];

            handler.FolderPaths = [models, Path.Combine(path, "unavailable")];
            handler.Refresh();

            Assert.That(handler.LastRefreshSucceeded, Is.False);
            Assert.That(handler.Models["kept.safetensors"], Is.SameAs(previous));
        });
    }

    /// <summary>Run one test against isolated central metadata storage and restore process-wide settings.</summary>
    private static void WithSyntheticCache(Action<T2IModelHandler, T2IModelHandler.ModelDatabase, string> body)
    {
        string root = Path.Combine(Path.GetTempPath(), $"swarm-metadata-lookup-{Guid.NewGuid():N}");
        string data = Path.Combine(root, "data");
        Directory.CreateDirectory(data);
        string savedDataDir = Program.DataDir;
        Action savedRefreshEvent = Program.ModelRefreshEvent;
        bool savedPerFolder = Program.ServerSettings.Metadata.ModelMetadataPerFolder;
        Logs.LogLevel savedMinimumLevel = Logs.MinimumLevel;
        string cacheKey = $"{data}/model_metadata.ldb";
        T2IModelHandler handler = new() { ModelType = "Synthetic" };
        T2IModelHandler.ModelDatabase cache = null;
        try
        {
            Program.DataDir = data;
            Program.ServerSettings.Metadata.ModelMetadataPerFolder = false;
            Logs.MinimumLevel = Logs.LogLevel.None;
            cache = handler.GetCacheForFolder(data);
            body(handler, cache, root);
        }
        finally
        {
            Program.ModelRefreshEvent = savedRefreshEvent;
            Program.DataDir = savedDataDir;
            Program.ServerSettings.Metadata.ModelMetadataPerFolder = savedPerFolder;
            Logs.MinimumLevel = savedMinimumLevel;
            T2IModelHandler.ModelMetadataCachePerFolder.TryRemove(cacheKey, out _);
            cache?.Database.Dispose();
            Directory.Delete(root, true);
        }
    }

    /// <summary>Create a synthetic file without reading any real model data.</summary>
    private static string CreateModel(string root, string relative)
    {
        string path = Path.Combine(root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllBytes(path, [0]);
        return path;
    }

    /// <summary>Seed one fresh central-cache row.</summary>
    private static void Seed(T2IModelHandler.ModelDatabase cache, string path, string title)
    {
        long version = VersionOf(path);
        cache.Metadata.Upsert(new T2IModelHandler.ModelMetadataStore()
        {
            ModelName = path.Replace('\\', '/'),
            ModelFileVersion = version,
            SidecarVersionKnown = true,
            Title = title,
            PreviewImage = T2IModelHandler.PlaceholderPreviewImage,
            TimeModified = version,
            TimeCreated = version
        });
    }

    /// <summary>Create a row with every projected metadata field populated.</summary>
    private static T2IModelHandler.ModelMetadataStore FullMetadata(string path, long version)
    {
        return new()
        {
            ModelName = path.Replace('\\', '/'),
            ModelFileVersion = version,
            SidecarFileVersion = 0,
            SidecarVersionKnown = true,
            ModelClassType = "class",
            AnimaDepthClassified = true,
            Title = "title",
            Author = "author",
            Description = "description",
            PreviewImage = "data:image/jpeg;base64,preview",
            PreviewExplicitlyCleared = true,
            StandardWidth = 640,
            StandardHeight = 480,
            IsNegativeEmbedding = true,
            LoraDefaultWeight = "0.7",
            LoraDefaultConfinement = "2",
            License = "license",
            UsageHint = "usage",
            TriggerPhrase = "trigger",
            Tags = ["one", "two"],
            MergedFrom = "source",
            Date = "date",
            Preprocessor = "preprocessor",
            TimeModified = 34,
            TimeCreated = 56,
            Hash = "hash",
            PredictionType = "prediction",
            TextEncoders = "clip_l",
            SpecialFormat = "format"
        };
    }

    /// <summary>Compare all fields returned by the preview-free projection.</summary>
    private static void AssertProjectedFields(T2IModelHandler.ModelMetadataStore actual, T2IModelHandler.ModelMetadataStore expected)
    {
        Assert.That(actual.ModelName, Is.EqualTo(expected.ModelName));
        Assert.That(actual.ModelFileVersion, Is.EqualTo(expected.ModelFileVersion));
        Assert.That(actual.SidecarFileVersion, Is.EqualTo(expected.SidecarFileVersion));
        Assert.That(actual.SidecarVersionKnown, Is.EqualTo(expected.SidecarVersionKnown));
        Assert.That(actual.ModelClassType, Is.EqualTo(expected.ModelClassType));
        Assert.That(actual.AnimaDepthClassified, Is.EqualTo(expected.AnimaDepthClassified));
        Assert.That(actual.Title, Is.EqualTo(expected.Title));
        Assert.That(actual.Author, Is.EqualTo(expected.Author));
        Assert.That(actual.Description, Is.EqualTo(expected.Description));
        Assert.That(actual.StandardWidth, Is.EqualTo(expected.StandardWidth));
        Assert.That(actual.StandardHeight, Is.EqualTo(expected.StandardHeight));
        Assert.That(actual.IsNegativeEmbedding, Is.EqualTo(expected.IsNegativeEmbedding));
        Assert.That(actual.LoraDefaultWeight, Is.EqualTo(expected.LoraDefaultWeight));
        Assert.That(actual.LoraDefaultConfinement, Is.EqualTo(expected.LoraDefaultConfinement));
        Assert.That(actual.License, Is.EqualTo(expected.License));
        Assert.That(actual.UsageHint, Is.EqualTo(expected.UsageHint));
        Assert.That(actual.TriggerPhrase, Is.EqualTo(expected.TriggerPhrase));
        Assert.That(actual.Tags, Is.EqualTo(expected.Tags));
        Assert.That(actual.MergedFrom, Is.EqualTo(expected.MergedFrom));
        Assert.That(actual.Date, Is.EqualTo(expected.Date));
        Assert.That(actual.Preprocessor, Is.EqualTo(expected.Preprocessor));
        Assert.That(actual.TimeModified, Is.EqualTo(expected.TimeModified));
        Assert.That(actual.TimeCreated, Is.EqualTo(expected.TimeCreated));
        Assert.That(actual.Hash, Is.EqualTo(expected.Hash));
        Assert.That(actual.PredictionType, Is.EqualTo(expected.PredictionType));
        Assert.That(actual.TextEncoders, Is.EqualTo(expected.TextEncoders));
        Assert.That(actual.SpecialFormat, Is.EqualTo(expected.SpecialFormat));
    }

    /// <summary>Return the model cache version used by production freshness checks.</summary>
    private static long VersionOf(string path) => new DateTimeOffset(File.GetLastWriteTimeUtc(path)).ToUnixTimeMilliseconds();

    /// <summary>Read newly tracked info messages after the supplied sequence.</summary>
    private static string[] NewInfoMessages(long afterSequence)
    {
        Logs.LogTracker tracker = Logs.Trackers[(int)Logs.LogLevel.Info];
        lock (tracker.Lock)
        {
            return [.. tracker.Messages.Where(message => message.Sequence > afterSequence).Select(message => message.Message)];
        }
    }
}
