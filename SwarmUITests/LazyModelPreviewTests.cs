using LiteDB;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

namespace SwarmUITests;

/// <summary>Tests deferred model preview loading against synthetic cache rows and images.</summary>
[TestFixture]
[NonParallelizable]
public class LazyModelPreviewTests : SwarmUITest
{
    /// <summary>Prepares the shared test framework.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>A warm metadata load omits preview data until explicit serialization and preserves the stored row.</summary>
    [Test]
    public static void WarmLoadDefersCachedPreviewAndPreservesMetadataSave()
    {
        WithModel((handler, model, cache) =>
        {
            string preview = "data:image/png;base64," + new string('A', 256 * 1024);
            Seed(cache, model, preview);
            ILiteCollection<BsonDocument> rawRows = cache.Database.GetCollection("models");
            BsonDocument legacyRow = rawRows.FindById(model.RawFilePath);
            Assert.That(legacyRow.Remove(nameof(T2IModelHandler.ModelMetadataStore.PreviewExplicitlyCleared)), Is.True);
            rawRows.Update(legacyRow);

            handler.LoadMetadata(model);

            Assert.That(handler.DeferredPreviewLoadCount, Is.Zero);
            Assert.That(model.Metadata.PreviewExplicitlyCleared, Is.False, "old rows need no clear-marker migration");
            Assert.That(model.PreviewImage, Is.EqualTo(T2IModelHandler.PlaceholderPreviewImage));
            Assert.That(cache.Metadata.FindById(model.RawFilePath).PreviewImage, Is.EqualTo(preview));

            JObject inline = model.ToNetObject(dataImgs: true);
            Assert.That(inline.Value<string>("preview_image"), Is.EqualTo(preview));
            Assert.That(handler.DeferredPreviewLoadCount, Is.EqualTo(1));
            Assert.That(model.PreviewImage, Is.EqualTo(T2IModelHandler.PlaceholderPreviewImage));

            model.Metadata.Author = "updated";
            handler.ResetMetadataFrom(model);
            T2IModelHandler.ModelMetadataStore stored = cache.Metadata.FindById(model.RawFilePath);
            Assert.That(stored.Author, Is.EqualTo("updated"));
            Assert.That(stored.PreviewImage, Is.EqualTo(preview));
            Assert.That(model.PreviewImage, Is.EqualTo(T2IModelHandler.PlaceholderPreviewImage));
            Assert.That(model.ToNetObject(dataImgs: false).Value<string>("preview_image"), Does.StartWith("/ViewSpecial/"));
        });
    }

    /// <summary>A metadata-only save before first preview use preserves the deferred cache field.</summary>
    [Test]
    public static void MetadataSaveBeforePreviewResolutionPreservesPreview()
    {
        WithModel((handler, model, cache) =>
        {
            string preview = "data:image/png;base64," + new string('D', 128 * 1024);
            Seed(cache, model, preview);
            handler.LoadMetadata(model);
            Assert.That(handler.DeferredPreviewLoadCount, Is.Zero);

            model.Metadata.Author = "changed before preview";
            handler.ResetMetadataFrom(model);

            Assert.That(cache.Metadata.FindById(model.RawFilePath).PreviewImage, Is.EqualTo(preview));
            Assert.That(T2IModel.PreviewDataFor(model), Is.EqualTo(preview));
        });
    }

    /// <summary>A deferred metadata save preserves the raw cache field even when it is not valid for display.</summary>
    [Test]
    public static void MetadataSavePreservesRawOversizedPreview()
    {
        WithModel((handler, model, cache) =>
        {
            string raw = new('Z', T2IModelHandler.MaxPreviewDataLength + 1);
            Seed(cache, model, raw);
            handler.LoadMetadata(model);

            model.Metadata.Author = "metadata only";
            handler.ResetMetadataFrom(model);

            Assert.That(cache.Metadata.FindById(model.RawFilePath).PreviewImage, Is.EqualTo(raw));
            Assert.That(T2IModel.PreviewDataFor(model), Is.Null, "invalid saved values are preserved but not emitted as display previews");
        });
    }

    /// <summary>An ordinary metadata save does not persist an adjacent fallback over a placeholder cache field.</summary>
    [Test]
    public static void MetadataSaveKeepsPlaceholderWhileDisplayUsesAdjacentFallback()
    {
        WithModel((handler, model, cache) =>
        {
            Seed(cache, model, T2IModelHandler.PlaceholderPreviewImage);
            File.WriteAllBytes(Path.Combine(model.OriginatingFolderPath, "model.preview.png"), OnePixelPng);
            handler.LoadMetadata(model);

            model.Metadata.Author = "metadata only";
            handler.ResetMetadataFrom(model);

            Assert.That(cache.Metadata.FindById(model.RawFilePath).PreviewImage, Is.EqualTo(T2IModelHandler.PlaceholderPreviewImage));
            Assert.That(T2IModel.PreviewDataFor(model), Does.StartWith("data:image/"));
            Assert.That(cache.Metadata.FindById(model.RawFilePath).PreviewImage, Is.EqualTo(T2IModelHandler.PlaceholderPreviewImage));
        });
    }

    /// <summary>Header and sidecar export preserve the exact deferred thumbnail, including an older oversized value.</summary>
    [TestCase(false, false)]
    [TestCase(true, false)]
    [TestCase(false, true)]
    [TestCase(true, true)]
    public static void ResaveModelPreservesDeferredThumbnail(bool oversized, bool writeJson)
    {
        WithModel((handler, model, cache) =>
        {
            string preview = "data:image/png;base64," + (oversized ? new string('H', T2IModelHandler.MaxPreviewDataLength) : "header-preview");
            WriteSafetensors(model.RawFilePath, preview);
            Seed(cache, model, preview);
            T2IModelHandler.ModelMetadataStore row = cache.Metadata.FindById(model.RawFilePath);
            row.ModelFileVersion = new DateTimeOffset(File.GetLastWriteTimeUtc(model.RawFilePath)).ToUnixTimeMilliseconds();
            row.Hash = "synthetic-hash";
            cache.Metadata.Upsert(row);
            handler.LoadMetadata(model);

            if (oversized)
            {
                string inlinePreview = model.ToNetObject().Value<string>("preview_image");
                Assert.That(string.Equals(inlinePreview, preview, StringComparison.Ordinal), Is.True, "older large previews retain their inline API response");
                Assert.That(handler.ResolvedPreviewCount, Is.Zero, "oversized values must not bypass the bounded preview cache");
            }

            bool savedWriteJson = Program.ServerSettings.Metadata.EditMetadataWriteJSON;
            try
            {
                Program.ServerSettings.Metadata.EditMetadataWriteJSON = writeJson;
                model.ResaveModel();
                JObject header = T2IModel.GetMetadataHeaderFrom(model.RawFilePath);
                Assert.That(string.Equals(header["__metadata__"]?["modelspec.thumbnail"]?.ToString(), preview, StringComparison.Ordinal), Is.True, "header thumbnail must preserve the exact saved value");
                if (writeJson)
                {
                    string sidecarPath = Path.ChangeExtension(model.RawFilePath, ".swarm.json");
                    JObject sidecar = JObject.Parse(File.ReadAllText(sidecarPath));
                    Assert.That(string.Equals(sidecar["modelspec.preview_image"]?.ToString(), preview, StringComparison.Ordinal), Is.True, "sidecar preview must preserve the exact saved value");
                }
            }
            finally
            {
                Program.ServerSettings.Metadata.EditMetadataWriteJSON = savedWriteJson;
            }
        });
    }

    /// <summary>An explicit clear blocks adjacent fallback until explicit missing-preview refresh restores it.</summary>
    [Test]
    public static void ExplicitClearAndReplacementInvalidateDeferredPreview()
    {
        WithModel((handler, model, cache) =>
        {
            string oldPreview = "data:image/png;base64,old";
            Seed(cache, model, oldPreview);
            File.WriteAllBytes(Path.Combine(model.OriginatingFolderPath, "model.preview.png"), OnePixelPng);
            handler.LoadMetadata(model);
            Assert.That(T2IModel.PreviewDataFor(model), Is.EqualTo(oldPreview));

            model.Metadata.PreviewImage = null;
            model.Metadata.PreviewExplicitlyCleared = true;
            handler.ResetMetadataFrom(model);
            Assert.That(T2IModel.PreviewDataFor(model), Is.Null);
            Assert.That(cache.Metadata.FindById(model.RawFilePath).PreviewImage, Is.Null);

            handler.Refresh();
            model = handler.Models[model.Name];
            Assert.That(T2IModel.PreviewDataFor(model), Is.Null, "an ordinary refresh must retain an explicit clear");

            T2IModelHandler.PreviewRefreshCounts refreshed = handler.RefreshMissingPreviews("", model.Name, null, 1);
            Assert.That(refreshed.Updated, Is.EqualTo(1));
            Assert.That(T2IModel.PreviewDataFor(model), Does.StartWith("data:image/"));
            Assert.That(cache.Metadata.FindById(model.RawFilePath).PreviewExplicitlyCleared, Is.False);

            model.Metadata.PreviewImage = "data:image/png;base64,replacement";
            model.Metadata.PreviewExplicitlyCleared = false;
            handler.ResetMetadataFrom(model);
            Assert.That(T2IModel.PreviewDataFor(model), Is.EqualTo("data:image/png;base64,replacement"));
        });
    }

    /// <summary>Cached header data wins over an adjacent image, while a failed adjacent load is retried later.</summary>
    [Test]
    public static void HeaderPrecedenceAndAdjacentFailureRecovery()
    {
        WithModel((handler, model, cache) =>
        {
            string headerPreview = "data:image/png;base64,header-wins";
            WriteSafetensors(model.RawFilePath, headerPreview);
            File.WriteAllBytes(Path.Combine(model.OriginatingFolderPath, "model.preview.png"), OnePixelPng);
            handler.LoadMetadata(model);
            Assert.That(T2IModel.PreviewDataFor(model), Is.EqualTo(headerPreview));

            string legacyPath = Path.Combine(model.OriginatingFolderPath, "legacy.ckpt");
            string legacyPreview = Path.Combine(model.OriginatingFolderPath, "legacy.preview.png");
            File.WriteAllBytes(legacyPath, [0]);
            File.WriteAllText(legacyPreview, "invalid");
            ConcurrentDictionary<string, T2IModel> found = [];
            handler.AddAllFromFolder(model.OriginatingFolderPath, "", found);
            T2IModel legacy = found["legacy.ckpt"];
            Assert.That(T2IModel.PreviewDataFor(legacy), Is.Null);
            File.WriteAllBytes(legacyPreview, OnePixelPng);
            Assert.That(T2IModel.PreviewDataFor(legacy), Does.StartWith("data:image/"));
        });
    }

    /// <summary>Per-folder caches retain lazy preview behavior, while spoke mode remains preview-free.</summary>
    [Test]
    public static void PerFolderAndSpokeContractsRemainIntact()
    {
        WithModel((handler, model, cache) =>
        {
            string preview = "data:image/png;base64,per-folder";
            Seed(cache, model, preview);
            handler.LoadMetadata(model);
            Assert.That(handler.DeferredPreviewLoadCount, Is.Zero);
            Assert.That(cache.Metadata.FindById(model.Name).PreviewImage, Is.EqualTo(preview));
            Assert.That(T2IModel.PreviewDataFor(model), Is.EqualTo(preview));
        }, perFolder: true);

        WithModel((handler, model, cache) =>
        {
            Seed(cache, model, "data:image/png;base64,spoke-rich");
            handler.LoadMetadata(model);
            Assert.That(model.PreviewImage, Is.EqualTo(T2IModelHandler.PlaceholderPreviewImage));
            Assert.That(model.Metadata.PreviewImage, Is.Null);
            Assert.That(handler.DeferredPreviewLoadCount, Is.Zero);
        }, spoke: true);
    }

    /// <summary>Concurrent first use shares one source load and the resolved cache remains bounded.</summary>
    [Test]
    public static void ConcurrentFirstUseCoalescesAndCacheEvicts()
    {
        WithModel((handler, model, cache) =>
        {
            string preview = "data:image/png;base64," + new string('B', 64 * 1024);
            Seed(cache, model, preview);
            handler.LoadMetadata(model);

            Task<string>[] calls = Enumerable.Range(0, 16).Select(_ => Task.Run(() => T2IModel.PreviewDataFor(model))).ToArray();
            Assert.That(Task.WaitAll(calls, TimeSpan.FromSeconds(5)), Is.True);
            Assert.That(calls.Select(task => task.Result), Is.All.EqualTo(preview));
            Assert.That(handler.DeferredPreviewLoadCount, Is.EqualTo(1));

            Task[] saveRace = Enumerable.Range(0, 16).SelectMany(_ => new Task[]
            {
                Task.Run(() => model.ToNetObject()),
                Task.Run(() => handler.ResetMetadataFrom(model))
            }).ToArray();
            Assert.That(Task.WaitAll(saveRace, TimeSpan.FromSeconds(5)), Is.True, "preview resolution and metadata save must not deadlock");
            Assert.That(cache.Metadata.FindById(model.RawFilePath).PreviewImage, Is.EqualTo(preview));

            for (int i = 0; i < 40; i++)
            {
                string name = $"extra-{i}.safetensors";
                string path = Path.Combine(model.OriginatingFolderPath, name).Replace('\\', '/');
                File.WriteAllBytes(path, [(byte)i]);
                T2IModel extra = new(handler, model.OriginatingFolderPath, path, name);
                Seed(cache, extra, $"data:image/png;base64,{i:D3}" + new string('C', 600 * 1024));
                handler.LoadMetadata(extra);
                _ = extra.ToNetObject();
            }
            Assert.That(handler.ResolvedPreviewCount, Is.LessThanOrEqualTo(T2IModelHandler.ResolvedPreviewEntryLimit));
            Assert.That(handler.ResolvedPreviewBytes, Is.LessThanOrEqualTo(T2IModelHandler.ResolvedPreviewByteLimit));
        });
    }

    /// <summary>One-pixel synthetic PNG used for adjacent preview tests.</summary>
    private static readonly byte[] OnePixelPng = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

    /// <summary>Writes a tiny safetensors file with enough header padding for metadata resave.</summary>
    private static void WriteSafetensors(string path, string preview)
    {
        JObject metadata = new()
        {
            ["modelspec.architecture"] = "anima/lora",
            ["modelspec.title"] = "Synthetic",
            ["__spacer"] = new string(' ', 4096)
        };
        if (preview is not null)
        {
            metadata["modelspec.thumbnail"] = preview;
        }
        byte[] header = Encoding.UTF8.GetBytes(new JObject() { ["__metadata__"] = metadata }.ToString(Newtonsoft.Json.Formatting.None));
        using FileStream file = File.Create(path);
        file.Write(BitConverter.GetBytes((long)header.Length));
        file.Write(header);
    }

    /// <summary>Creates an isolated cache-hit model and restores process settings afterwards.</summary>
    private static void WithModel(Action<T2IModelHandler, T2IModel, T2IModelHandler.ModelDatabase> body, bool perFolder = false, bool spoke = false)
    {
        string root = Path.Combine(Path.GetTempPath(), $"swarm-lazy-preview-{Guid.NewGuid():N}");
        string data = Path.Combine(root, "data");
        string models = Path.Combine(root, "models");
        string modelPath = Path.Combine(models, "model.safetensors").Replace('\\', '/');
        string savedData = Program.DataDir;
        bool savedPerFolder = Program.ServerSettings.Metadata.ModelMetadataPerFolder;
        bool savedSpoke = Program.IsSpokeMode;
        T2IModelHandler handler = new() { ModelType = "LoRA" };
        Directory.CreateDirectory(data);
        Directory.CreateDirectory(models);
        File.WriteAllBytes(modelPath, [0]);
        try
        {
            Program.DataDir = data;
            Program.ServerSettings.Metadata.ModelMetadataPerFolder = perFolder;
            SetSpokeMode(spoke);
            T2IModel model = new(handler, models.Replace('\\', '/'), modelPath, "model.safetensors");
            handler.FolderPaths = [models];
            handler.Models[model.Name] = model;
            T2IModelHandler.ModelDatabase cache = handler.GetCacheForFolder(perFolder && !spoke ? models.Replace('\\', '/') : data);
            body(handler, model, cache);
        }
        finally
        {
            handler.Shutdown();
            Program.DataDir = savedData;
            Program.ServerSettings.Metadata.ModelMetadataPerFolder = savedPerFolder;
            SetSpokeMode(savedSpoke);
            Directory.Delete(root, true);
        }
    }

    /// <summary>Changes the process spoke flag only inside isolated tests.</summary>
    private static void SetSpokeMode(bool active)
    {
        typeof(Program).GetProperty(nameof(Program.IsSpokeMode), BindingFlags.Public | BindingFlags.Static).GetSetMethod(true).Invoke(null, [active]);
    }

    /// <summary>Seeds one same-version cache row.</summary>
    private static void Seed(T2IModelHandler.ModelDatabase cache, T2IModel model, string preview)
    {
        long version = new DateTimeOffset(File.GetLastWriteTimeUtc(model.RawFilePath)).ToUnixTimeMilliseconds();
        cache.Metadata.Upsert(new T2IModelHandler.ModelMetadataStore()
        {
            ModelName = Program.ServerSettings.Metadata.ModelMetadataPerFolder && !Program.IsSpokeMode ? model.Name : model.RawFilePath,
            ModelFileVersion = version,
            SidecarVersionKnown = true,
            SidecarFileVersion = 0,
            ModelClassType = "anima/lora",
            AnimaDepthClassified = true,
            Title = "Synthetic",
            PreviewImage = preview,
            TextEncoders = "clip_l",
            TimeModified = version,
            TimeCreated = version
        });
    }
}
