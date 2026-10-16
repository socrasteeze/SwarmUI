using NUnit.Framework;
using SwarmUI.Core;
using SwarmUI.Media;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System;
using System.IO;
using System.Text;

namespace SwarmUITests;

/// <summary>Preview cache fill, sidecar mtime checks, and preview JPEG writes that must not touch model files or sidecars.</summary>
[TestFixture]
[NonParallelizable]
public class ModelPreviewRefreshTests : SwarmUITest
{
    /// <summary>One-pixel PNG. ImageSharp sniffs the bytes, so the file extension does not have to match.</summary>
    private static readonly byte[] OnePixelPng = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

    /// <summary>Initializes invariant culture the same way the other metadata tests do.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>A blank or placeholder cache row picks up an adjacent preview without rewriting the model or any sidecar.</summary>
    [Test]
    public static void CacheHit_BlankPreview_LoadsAdjacentImageWithoutWritingFiles()
    {
        WithHandler((handler, folder, data) =>
        {
            string modelPath = Path.Combine(folder, "model.safetensors");
            File.WriteAllBytes(modelPath, Encoding.UTF8.GetBytes("not a header"));
            DateTime modified = File.GetLastWriteTimeUtc(modelPath);
            string previewPath = Path.Combine(folder, "model.preview.jpeg");
            File.WriteAllBytes(previewPath, OnePixelPng);
            string sidecarPath = Path.Combine(folder, "model.swarm.json");
            File.WriteAllText(sidecarPath, "{\"modelspec.tags\":\"anima-base,gynoid\",\"modelspec.title\":\"sidecar title\"}");
            byte[] sidecarBefore = File.ReadAllBytes(sidecarPath);
            DateTime sidecarTime = File.GetLastWriteTimeUtc(sidecarPath);
            long modelVersion = new DateTimeOffset(modified).ToUnixTimeMilliseconds();
            T2IModel model = Seed(handler, data, folder, "model.safetensors", modelVersion, new T2IModelHandler.ModelMetadataStore()
            {
                Title = "cached title",
                PreviewImage = T2IModelHandler.PlaceholderPreviewImage,
                Tags = ["anima-base", "gynoid"],
                Hash = "saved hash",
                SidecarVersionKnown = true,
                SidecarFileVersion = new DateTimeOffset(sidecarTime).ToUnixTimeMilliseconds()
            });
            handler.LoadMetadata(model);
            Assert.That(model.PreviewImage, Does.StartWith("data:image/"));
            Assert.That(model.Title, Is.EqualTo("cached title"));
            Assert.That(model.Metadata.Tags, Is.EqualTo(new[] { "anima-base", "gynoid" }));
            Assert.That(model.Metadata.Hash, Is.EqualTo("saved hash"));
            Assert.That(File.GetLastWriteTimeUtc(modelPath), Is.EqualTo(modified));
            Assert.That(File.ReadAllBytes(modelPath), Is.EqualTo(Encoding.UTF8.GetBytes("not a header")));
            Assert.That(File.ReadAllBytes(sidecarPath), Is.EqualTo(sidecarBefore));
            Assert.That(File.GetLastWriteTimeUtc(sidecarPath), Is.EqualTo(sidecarTime));
            Assert.That(Directory.GetFiles(folder, "*.metadata.json"), Is.Empty);
            Assert.That(Directory.GetFiles(folder, "*.cm-info.json"), Is.Empty);
            Assert.That(Directory.GetFiles(folder, "*.civitai.info"), Is.Empty);
        });
    }

    /// <summary>A preview already stored in the cache is left alone even when a new image file appears.</summary>
    [Test]
    public static void CacheHit_ExistingPreview_IsNotReplaced()
    {
        WithHandler((handler, folder, data) =>
        {
            string modelPath = Path.Combine(folder, "model.safetensors");
            File.WriteAllBytes(modelPath, Encoding.UTF8.GetBytes("not a header"));
            File.WriteAllBytes(Path.Combine(folder, "model.preview.jpeg"), OnePixelPng);
            long modelVersion = new DateTimeOffset(File.GetLastWriteTimeUtc(modelPath)).ToUnixTimeMilliseconds();
            T2IModel model = Seed(handler, data, folder, "model.safetensors", modelVersion, new T2IModelHandler.ModelMetadataStore()
            {
                Title = "cached title",
                PreviewImage = "data:image/jpeg;base64,already",
                SidecarVersionKnown = true,
                SidecarFileVersion = 0
            });
            handler.LoadMetadata(model);
            Assert.That(model.PreviewImage, Is.EqualTo("data:image/jpeg;base64,already"));
            Assert.That(model.Title, Is.EqualTo("cached title"));
        });
    }

    /// <summary>A legacy row with no sidecar field records the current mtime and keeps the cached text.</summary>
    [Test]
    public static void LegacySidecar_RecordsMtimeWithoutReread()
    {
        WithHandler((handler, folder, data) =>
        {
            string modelPath = Path.Combine(folder, "model.safetensors");
            File.WriteAllBytes(modelPath, Encoding.UTF8.GetBytes("not a header"));
            string sidecarPath = Path.Combine(folder, "model.swarm.json");
            File.WriteAllText(sidecarPath, "{\"modelspec.title\":\"from sidecar\"}");
            DateTime sidecarTime = File.GetLastWriteTimeUtc(sidecarPath);
            long modelVersion = new DateTimeOffset(File.GetLastWriteTimeUtc(modelPath)).ToUnixTimeMilliseconds();
            T2IModel model = Seed(handler, data, folder, "model.safetensors", modelVersion, new T2IModelHandler.ModelMetadataStore()
            {
                Title = "cached title",
                PreviewImage = "data:image/jpeg;base64,already",
                Tags = ["keep"],
                SidecarVersionKnown = false,
                SidecarFileVersion = 0
            });
            Assert.DoesNotThrow(() => handler.LoadMetadata(model));
            Assert.That(model.Title, Is.EqualTo("cached title"));
            Assert.That(model.Metadata.Tags, Is.EqualTo(new[] { "keep" }));
            Assert.That(model.Metadata.SidecarVersionKnown, Is.True);
            Assert.That(model.Metadata.SidecarFileVersion, Is.EqualTo(new DateTimeOffset(sidecarTime).ToUnixTimeMilliseconds()));
            Assert.That(File.ReadAllText(sidecarPath), Is.EqualTo("{\"modelspec.title\":\"from sidecar\"}"));
        });
    }

    /// <summary>A known sidecar mtime that no longer matches rebuilds from the sidecar and does not write it back.</summary>
    [Test]
    public static void KnownSidecar_MtimeChange_RebuildsFromSidecar()
    {
        WithHandler((handler, folder, data) =>
        {
            string modelPath = Path.Combine(folder, "model.safetensors");
            WriteTinySafetensors(modelPath);
            DateTime modified = File.GetLastWriteTimeUtc(modelPath);
            string sidecarPath = Path.Combine(folder, "model.swarm.json");
            string sidecarText = "{\"modelspec.title\":\"from sidecar\",\"modelspec.tags\":\"anima-base,gynoid\"}";
            File.WriteAllText(sidecarPath, sidecarText);
            long modelVersion = new DateTimeOffset(modified).ToUnixTimeMilliseconds();
            T2IModel model = Seed(handler, data, folder, "model.safetensors", modelVersion, new T2IModelHandler.ModelMetadataStore()
            {
                Title = "cached title",
                PreviewImage = "data:image/jpeg;base64,already",
                Tags = ["stale"],
                SidecarVersionKnown = true,
                SidecarFileVersion = 1
            });
            handler.LoadMetadata(model);
            Assert.That(model.Title, Is.EqualTo("from sidecar"));
            Assert.That(model.Metadata.Tags, Is.EqualTo(new[] { "anima-base", "gynoid" }));
            Assert.That(model.Metadata.SidecarVersionKnown, Is.True);
            Assert.That(model.Metadata.SidecarFileVersion, Is.EqualTo(new DateTimeOffset(File.GetLastWriteTimeUtc(sidecarPath)).ToUnixTimeMilliseconds()));
            Assert.That(File.ReadAllText(sidecarPath), Is.EqualTo(sidecarText));
            Assert.That(File.GetLastWriteTimeUtc(modelPath), Is.EqualTo(modified));
        });
    }

    /// <summary>The refresh counts only blank previews, leaves other rows, and does not write sidecars.</summary>
    [Test]
    public static void RefreshMissingPreviews_UpdatesOnlyBlank()
    {
        WithHandler((handler, folder, data) =>
        {
            string blankPath = Path.Combine(folder, "blank.safetensors");
            string keptPath = Path.Combine(folder, "kept.safetensors");
            string nonePath = Path.Combine(folder, "none.safetensors");
            File.WriteAllBytes(blankPath, Encoding.UTF8.GetBytes("blank"));
            File.WriteAllBytes(keptPath, Encoding.UTF8.GetBytes("kept"));
            File.WriteAllBytes(nonePath, Encoding.UTF8.GetBytes("none"));
            File.WriteAllBytes(Path.Combine(folder, "blank.preview.jpeg"), OnePixelPng);
            File.WriteAllBytes(Path.Combine(folder, "kept.jpg"), OnePixelPng);
            DateTime blankTime = File.GetLastWriteTimeUtc(blankPath);
            T2IModel blank = Track(handler, folder, "blank.safetensors", new T2IModelHandler.ModelMetadataStore()
            {
                Title = "Blank",
                PreviewImage = null,
                Tags = ["anima-base", "gynoid"],
                ModelClassType = "anima",
                SidecarVersionKnown = true,
                SidecarFileVersion = 0
            });
            T2IModel kept = Track(handler, folder, "kept.safetensors", new T2IModelHandler.ModelMetadataStore()
            {
                Title = "Kept",
                PreviewImage = "data:image/jpeg;base64,keep",
                Tags = ["stay"],
                SidecarVersionKnown = true,
                SidecarFileVersion = 0
            });
            Track(handler, folder, "none.safetensors", new T2IModelHandler.ModelMetadataStore()
            {
                Title = "None",
                PreviewImage = T2IModelHandler.PlaceholderPreviewImage,
                SidecarVersionKnown = true,
                SidecarFileVersion = 0
            });
            T2IModelHandler.PreviewRefreshCounts counts = handler.RefreshMissingPreviews("", "", null, T2IModelHandler.PreviewRefreshNameLimit);
            Assert.That(counts.Checked, Is.EqualTo(3));
            Assert.That(counts.Updated, Is.EqualTo(1));
            Assert.That(counts.Names, Is.EqualTo(new[] { "blank.safetensors" }));
            Assert.That(blank.PreviewImage, Does.StartWith("data:image/"));
            Assert.That(blank.Metadata.Tags, Is.EqualTo(new[] { "anima-base", "gynoid" }));
            Assert.That(blank.Metadata.ModelClassType, Is.EqualTo("anima"));
            Assert.That(kept.PreviewImage, Is.EqualTo("data:image/jpeg;base64,keep"));
            Assert.That(kept.Metadata.Tags, Is.EqualTo(new[] { "stay" }));
            Assert.That(File.GetLastWriteTimeUtc(blankPath), Is.EqualTo(blankTime));
            Assert.That(File.Exists(Path.Combine(folder, "blank.swarm.json")), Is.False);
            T2IModelHandler.PreviewRefreshCounts filtered = handler.RefreshMissingPreviews("kept", "", null, 10);
            Assert.That(filtered.Checked, Is.EqualTo(1));
            Assert.That(filtered.Updated, Is.EqualTo(0));
            T2IModelHandler.PreviewRefreshCounts exact = handler.RefreshMissingPreviews("", "none.safetensors", null, 0);
            Assert.That(exact.Checked, Is.EqualTo(1));
            Assert.That(exact.Updated, Is.EqualTo(0));
            Assert.That(exact.Names, Is.Empty);
        });
    }

    /// <summary>Saving a preview writes only the JPEG and the cache. Tags and the sidecar bytes stay put.</summary>
    [Test]
    public static void StorePreviewJpeg_WritesJpegAndKeepsTags()
    {
        WithHandler((handler, folder, data) =>
        {
            string modelPath = Path.Combine(folder, "model.safetensors");
            File.WriteAllBytes(modelPath, Encoding.UTF8.GetBytes("model-bytes"));
            DateTime modified = File.GetLastWriteTimeUtc(modelPath);
            string sidecarPath = Path.Combine(folder, "model.swarm.json");
            File.WriteAllText(sidecarPath, "{\"modelspec.tags\":\"anima-base,gynoid\"}");
            byte[] sidecarBefore = File.ReadAllBytes(sidecarPath);
            DateTime sidecarTime = File.GetLastWriteTimeUtc(sidecarPath);
            T2IModel model = Track(handler, folder, "model.safetensors", new T2IModelHandler.ModelMetadataStore()
            {
                Title = "Cached",
                Description = "leave this",
                PreviewImage = null,
                Tags = ["anima-base", "gynoid"],
                ModelClassType = "anima",
                Author = "someone",
                SidecarVersionKnown = true,
                SidecarFileVersion = new DateTimeOffset(sidecarTime).ToUnixTimeMilliseconds()
            });
            string dataUrl = handler.StorePreviewJpeg(model, new Image(OnePixelPng, MediaType.ImagePng));
            string previewPath = Path.Combine(folder, "model.preview.jpeg");
            Assert.That(dataUrl, Does.StartWith("data:image/jpeg"));
            Assert.That(model.PreviewImage, Is.EqualTo(dataUrl));
            Assert.That(model.Metadata.PreviewImage, Is.EqualTo(dataUrl));
            Assert.That(model.Metadata.Tags, Is.EqualTo(new[] { "anima-base", "gynoid" }));
            Assert.That(model.Metadata.Title, Is.EqualTo("Cached"));
            Assert.That(model.Metadata.Description, Is.EqualTo("leave this"));
            Assert.That(model.Metadata.Author, Is.EqualTo("someone"));
            Assert.That(model.Metadata.ModelClassType, Is.EqualTo("anima"));
            Assert.That(File.Exists(previewPath), Is.True);
            Assert.That(File.ReadAllBytes(previewPath).Length, Is.GreaterThan(0));
            Assert.That(File.ReadAllBytes(modelPath), Is.EqualTo(Encoding.UTF8.GetBytes("model-bytes")));
            Assert.That(File.GetLastWriteTimeUtc(modelPath), Is.EqualTo(modified));
            Assert.That(File.ReadAllBytes(sidecarPath), Is.EqualTo(sidecarBefore));
            Assert.That(File.GetLastWriteTimeUtc(sidecarPath), Is.EqualTo(sidecarTime));
        });
    }

    /// <summary>The preview URL allow-list matches the CivitAI image hosts and rejects anything else.</summary>
    [Test]
    public static void ForwardablePreviewUrl_AllowsOnlyCivitaiImageHosts()
    {
        Assert.That(ModelsAPI.IsForwardablePreviewUrl("https://image.civitai.com/x/a.jpg"), Is.True);
        Assert.That(ModelsAPI.IsForwardablePreviewUrl("https://blobs-b2.civitai.com/x/a.jpg"), Is.True);
        Assert.That(ModelsAPI.IsForwardablePreviewUrl("https://civitai.com/api/download/models/1"), Is.False);
        Assert.That(ModelsAPI.IsForwardablePreviewUrl("http://image.civitai.com/x/a.jpg"), Is.False);
        Assert.That(ModelsAPI.IsForwardablePreviewUrl(""), Is.False);
        Assert.That(ModelsAPI.IsForwardablePreviewUrl(null), Is.False);
        Assert.That(T2IModelHandler.PreviewImageMissing(null), Is.True);
        Assert.That(T2IModelHandler.PreviewImageMissing("  "), Is.True);
        Assert.That(T2IModelHandler.PreviewImageMissing(T2IModelHandler.PlaceholderPreviewImage), Is.True);
        Assert.That(T2IModelHandler.PreviewImageMissing("data:image/jpeg;base64,aa"), Is.False);
        Assert.That(T2IModelHandler.PreviewDataAcceptable(new string('a', T2IModelHandler.MaxPreviewDataLength + 1)), Is.False);
    }

    /// <summary>Runs one isolated handler against a temp data directory and deletes it afterwards.</summary>
    private static void WithHandler(Action<T2IModelHandler, string, string> body)
    {
        string root = Path.Combine(Path.GetTempPath(), $"swarm-preview-{Guid.NewGuid():N}");
        string data = Path.Combine(root, "data");
        string folder = Path.Combine(root, "models");
        string savedData = Program.DataDir;
        bool savedPerFolder = Program.ServerSettings.Metadata.ModelMetadataPerFolder;
        T2IModelHandler handler = new() { ModelType = "LoRA" };
        Directory.CreateDirectory(data);
        Directory.CreateDirectory(folder);
        try
        {
            Program.DataDir = data;
            Program.ServerSettings.Metadata.ModelMetadataPerFolder = false;
            body(handler, folder, data);
        }
        finally
        {
            handler.Shutdown();
            Program.DataDir = savedData;
            Program.ServerSettings.Metadata.ModelMetadataPerFolder = savedPerFolder;
            Directory.Delete(root, true);
        }
    }

    /// <summary>Inserts a cache row and a loaded model that points at it.</summary>
    private static T2IModel Seed(T2IModelHandler handler, string data, string folder, string name, long modelVersion, T2IModelHandler.ModelMetadataStore metadata)
    {
        string raw = Path.Combine(folder, name).Replace('\\', '/');
        metadata.ModelName = raw;
        metadata.ModelFileVersion = modelVersion;
        metadata.TimeModified = modelVersion;
        metadata.TimeCreated = modelVersion;
        T2IModelHandler.ModelDatabase cache = handler.GetCacheForFolder(data);
        cache.Metadata.Upsert(metadata);
        T2IModel model = new(handler, folder.Replace('\\', '/'), raw, name);
        handler.Models[name] = model;
        return model;
    }

    /// <summary>Tracks a model whose metadata is already on the object, the shape refresh and preview-save use.</summary>
    private static T2IModel Track(T2IModelHandler handler, string folder, string name, T2IModelHandler.ModelMetadataStore metadata)
    {
        string raw = Path.Combine(folder, name).Replace('\\', '/');
        metadata.ModelName = raw;
        T2IModel model = new(handler, folder.Replace('\\', '/'), raw, name)
        {
            Title = metadata.Title,
            Description = metadata.Description,
            PreviewImage = metadata.PreviewImage,
            Metadata = metadata
        };
        handler.Models[name] = model;
        return model;
    }

    /// <summary>Writes a tiny safetensors header so a sidecar rebuild can open the file.</summary>
    private static void WriteTinySafetensors(string path)
    {
        string header = "{\"__metadata__\":{\"modelspec.architecture\":\"anima\",\"modelspec.title\":\"from header\"}}";
        byte[] bytes = Encoding.UTF8.GetBytes(header);
        using FileStream file = File.Create(path);
        file.Write(BitConverter.GetBytes((long)bytes.Length));
        file.Write(bytes);
    }
}
