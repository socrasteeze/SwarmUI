using LiteDB;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using System;
using System.IO;
using System.Reflection;
using System.Text;

namespace SwarmUITests;

/// <summary>Tests lightweight spoke metadata without sacrificing generation fields or normal rich metadata.</summary>
[TestFixture]
[NonParallelizable]
public class SpokeModelMetadataTests : SwarmUITest
{
    /// <summary>Prepares the test framework's culture.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Changes the immutable process-mode flag only within isolated tests.</summary>
    private static void SetSpokeMode(bool active)
    {
        typeof(Program).GetProperty(nameof(Program.IsSpokeMode), BindingFlags.Public | BindingFlags.Static).GetSetMethod(true).Invoke(null, [active]);
    }

    /// <summary>Builds generation metadata with large presentation values for both cache profiles.</summary>
    private static T2IModelHandler.ModelMetadataStore CreateMetadata()
    {
        return new()
        {
            ModelName = "test.safetensors",
            ModelFileVersion = 123,
            ModelClassType = "spoke-test",
            Title = "Test title",
            PreviewImage = "data:image/png;base64," + new string('A', 1000000),
            Description = "description",
            Author = "author",
            License = "license",
            UsageHint = "usage",
            Tags = ["tag"],
            MergedFrom = "merged",
            Date = "date",
            StandardWidth = 832,
            StandardHeight = 1216,
            TriggerPhrase = "test trigger",
            Preprocessor = "depth",
            PredictionType = "v",
            TextEncoders = "clip_l",
            SpecialFormat = "fp8_scaled",
            Hash = "hash",
            IsNegativeEmbedding = true,
            LoraDefaultWeight = "0.7",
            LoraDefaultConfinement = "1",
            TimeModified = 100,
            TimeCreated = 50
        };
    }

    /// <summary>Proves only presentation fields disappear and normal mode remains rich.</summary>
    [Test]
    public static void TestTrimPreservesGenerationFieldsOnlyOnSpoke()
    {
        try
        {
            T2IModelHandler.ModelMetadataStore metadata = CreateMetadata();
            SetSpokeMode(false);
            SpokeModelMetadata.TrimForSpoke(metadata);
            Assert.That(metadata.PreviewImage.Length, Is.GreaterThan(1000000));
            Assert.That(metadata.Description, Is.EqualTo("description"));
            SetSpokeMode(true);
            SpokeModelMetadata.TrimForSpoke(metadata);
            Assert.That(metadata.PreviewImage, Is.Null);
            Assert.That(metadata.Description, Is.Null);
            Assert.That(metadata.Tags, Is.Null);
            Assert.That(metadata.ModelClassType, Is.EqualTo("spoke-test"));
            Assert.That(metadata.Title, Is.EqualTo("Test title"));
            Assert.That(metadata.StandardWidth, Is.EqualTo(832));
            Assert.That(metadata.StandardHeight, Is.EqualTo(1216));
            Assert.That(metadata.TriggerPhrase, Is.EqualTo("test trigger"));
            Assert.That(metadata.Preprocessor, Is.EqualTo("depth"));
            Assert.That(metadata.PredictionType, Is.EqualTo("v"));
            Assert.That(metadata.TextEncoders, Is.EqualTo("clip_l"));
            Assert.That(metadata.SpecialFormat, Is.EqualTo("fp8_scaled"));
            Assert.That(metadata.LoraDefaultWeight, Is.EqualTo("0.7"));
            Assert.That(metadata.LoraDefaultConfinement, Is.EqualTo("1"));
            Assert.That(metadata.IsNegativeEmbedding, Is.True);
            Assert.That(metadata.Hash, Is.EqualTo("hash"));
            Assert.That(metadata.ModelFileVersion, Is.EqualTo(123));
            Assert.That(metadata.TimeModified, Is.EqualTo(100));
            Assert.That(metadata.TimeCreated, Is.EqualTo(50));
        }
        finally
        {
            SetSpokeMode(false);
        }
    }

    /// <summary>Proves nested preview fields and padding are filtered before rich JSON strings are materialized.</summary>
    [Test]
    public static void TestPreviewJsonProjectionPreservesTensorAndTriggerMetadata()
    {
        JObject source = CreateHeader("trigger one");
        source["__metadata__"]["__spacer"] = new string(' ', 10000);
        source["extra"] = new JArray(new JObject { ["thumbnail"] = "ignored", ["trainedWords"] = new JArray("first", "second") });
        byte[] bytes = Encoding.UTF8.GetBytes("\uFEFF" + source.ToString());
        JObject result = SpokeModelMetadata.ParseWithoutPreviews(bytes);
        Assert.That(result["__metadata__"]["modelspec.thumbnail"], Is.Null);
        Assert.That(result["__metadata__"]["__spacer"], Is.Null);
        Assert.That(result["extra"][0]["thumbnail"], Is.Null);
        Assert.That(result["extra"][0]["trainedWords"].ToObject<string[]>(), Is.EqualTo(new[] { "first", "second" }));
        Assert.That(result["__metadata__"]["modelspec.trigger_phrase"].Value<string>(), Is.EqualTo("trigger one"));
        Assert.That(result["text_encoders.clip_l.weight"]["shape"].ToObject<int[]>(), Is.EqualTo(new[] { 1 }));
    }

    /// <summary>Creates a tiny safe tensor header covering loader selection, dimensions, defaults, and previews.</summary>
    private static JObject CreateHeader(string trigger)
    {
        return new()
        {
            ["__metadata__"] = new JObject
            {
                ["modelspec.architecture"] = "spoke-test",
                ["modelspec.title"] = "Test title",
                ["modelspec.resolution"] = "832x1216",
                ["modelspec.trigger_phrase"] = trigger,
                ["modelspec.prediction_type"] = "v",
                ["modelspec.preprocessor"] = "depth",
                ["modelspec.lora_default_weight"] = "0.7",
                ["modelspec.is_negative_embedding"] = "true",
                ["modelspec.thumbnail"] = "data:image/png;base64," + new string('A', 1000000),
                ["modelspec.description"] = "rich description"
            },
            ["text_encoders.clip_l.weight"] = new JObject { ["dtype"] = "F32", ["shape"] = new JArray(1), ["data_offsets"] = new JArray(0, 4) },
            ["layer.scale_weight"] = new JObject { ["dtype"] = "F32", ["shape"] = new JArray(1), ["data_offsets"] = new JArray(4, 8) }
        };
    }

    /// <summary>Writes a tiny synthetic safetensors file used only for header identification tests.</summary>
    private static void WriteModel(string path, string trigger)
    {
        byte[] header = Encoding.UTF8.GetBytes(CreateHeader(trigger).ToString());
        using FileStream file = File.Create(path);
        file.Write(BitConverter.GetBytes((long)header.Length));
        file.Write(header);
        file.Write(new byte[8]);
    }

    /// <summary>Tests isolated spoke persistence, a true same-version cache hit, version invalidation, and rich normal mode.</summary>
    [Test]
    public static void TestCacheIsolationHitAndInvalidation()
    {
        string root = Path.Combine(Path.GetTempPath(), $"swarm-spoke-metadata-{Guid.NewGuid():N}");
        string data = Path.Combine(root, "data");
        string models = Path.Combine(root, "models");
        string modelPath = Path.Combine(models, "test.safetensors");
        string savedData = Program.DataDir;
        bool savedSpoke = Program.IsSpokeMode;
        bool savedPerFolder = Program.ServerSettings.Metadata.ModelMetadataPerFolder;
        bool savedRecheck = Program.ServerSettings.Metadata.DebugAlwaysRecheckClass;
        T2IModelHandler handler = new() { ModelType = "Test" };
        T2IModelClassSorter.ModelClasses.TryGetValue("spoke-test", out T2IModelClass savedClass);
        Directory.CreateDirectory(data);
        Directory.CreateDirectory(models);
        try
        {
            Program.DataDir = data;
            Program.ServerSettings.Metadata.ModelMetadataPerFolder = true;
            Program.ServerSettings.Metadata.DebugAlwaysRecheckClass = false;
            T2IModelClassSorter.ModelClasses["spoke-test"] = new() { ID = "spoke-test", Name = "Test", StandardWidth = 832, StandardHeight = 1216 };
            string richCache = Path.Combine(data, "model_metadata.ldb");
            using (LiteDatabase rich = new(richCache))
            {
                rich.GetCollection<T2IModelHandler.ModelMetadataStore>("models").Upsert(CreateMetadata());
            }
            long richCacheSize = new FileInfo(richCache).Length;
            WriteModel(modelPath, "trigger one");
            string nested = Path.Combine(models, "nested");
            Directory.CreateDirectory(nested);
            WriteModel(Path.Combine(nested, "child.safetensors"), "child trigger");
            // An invalid image proves startup never attempts decoding sidecar images on spokes.
            File.WriteAllText(Path.Combine(models, "test.preview.png"), "not an image");
            SetSpokeMode(true);
            handler.AddAllFromFolder(models, "", handler.Models);
            Assert.That(handler.Models.Count, Is.EqualTo(2), "bounded directory/file scanning must retain models from every nested folder");
            Assert.That(handler.Models["nested/child.safetensors"].Metadata.TriggerPhrase, Is.EqualTo("child trigger"));
            T2IModel first = handler.Models["test.safetensors"];
            Assert.That(first.PreviewImage, Is.EqualTo("imgs/model_placeholder.jpg"));
            Assert.That(first.Metadata.PreviewImage, Is.Null);
            Assert.That(first.Metadata.TriggerPhrase, Is.EqualTo("trigger one"));
            Assert.That(first.Metadata.ModelClassType, Is.EqualTo("spoke-test"));
            Assert.That(first.Metadata.TextEncoders, Is.EqualTo("clip_l"));
            Assert.That(first.Metadata.SpecialFormat, Is.EqualTo("fp8_scaled"));
            Assert.That(first.StandardWidth, Is.EqualTo(832));
            Assert.That(first.StandardHeight, Is.EqualTo(1216));
            Assert.That(File.Exists(Path.Combine(data, SpokeModelMetadata.CacheFileName)), Is.True);
            Assert.That(File.Exists(Path.Combine(models, "model_metadata.ldb")), Is.False);
            Assert.That(new FileInfo(richCache).Length, Is.EqualTo(richCacheSize));
            T2IModelHandler.ModelMetadataStore stored = handler.GetCacheForFolder(models).Metadata.FindById(first.RawFilePath);
            Assert.That(stored, Is.Not.Null, "the scanner normalizes cache IDs to forward-slash paths");
            Assert.That(stored.PreviewImage, Is.Null);
            Assert.That(stored.PredictionType, Is.EqualTo("v"));
            DateTime originalModified = File.GetLastWriteTimeUtc(modelPath);
            File.WriteAllText(modelPath, "invalid model header");
            File.SetLastWriteTimeUtc(modelPath, originalModified);
            T2IModel cached = new(handler, models, first.RawFilePath, "test.safetensors");
            Assert.DoesNotThrow(() => handler.LoadMetadata(cached), "unchanged model versions must use the lightweight cache without reopening the header");
            Assert.That(cached.Metadata.TriggerPhrase, Is.EqualTo("trigger one"));
            WriteModel(modelPath, "trigger two");
            File.SetLastWriteTimeUtc(modelPath, originalModified.AddSeconds(2));
            T2IModel refreshed = new(handler, models, first.RawFilePath, "test.safetensors");
            handler.LoadMetadata(refreshed);
            Assert.That(refreshed.Metadata.TriggerPhrase, Is.EqualTo("trigger two"));
            SetSpokeMode(false);
            File.Delete(Path.Combine(models, "test.preview.png"));
            Program.ServerSettings.Metadata.ModelMetadataPerFolder = false;
            T2IModel normal = new(handler, models, first.RawFilePath, "test.safetensors");
            handler.LoadMetadata(normal);
            Assert.That(normal.Metadata.Description, Is.EqualTo("rich description"));
            Assert.That(normal.Metadata.PreviewImage.Length, Is.GreaterThan(1000000));
        }
        finally
        {
            handler.Shutdown();
            SetSpokeMode(false);
            Program.DataDir = savedData;
            Program.ServerSettings.Metadata.ModelMetadataPerFolder = savedPerFolder;
            Program.ServerSettings.Metadata.DebugAlwaysRecheckClass = savedRecheck;
            if (savedClass is null)
            {
                T2IModelClassSorter.ModelClasses.Remove("spoke-test");
            }
            else
            {
                T2IModelClassSorter.ModelClasses["spoke-test"] = savedClass;
            }
            Directory.Delete(root, true);
        }
    }
}
