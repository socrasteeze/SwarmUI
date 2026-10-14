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

/// <summary>Upgrades old Anima cache entries without discarding saved metadata or repeatedly reading headers.</summary>
[TestFixture]
[NonParallelizable]
public class AnimaMetadataCacheTests : SwarmUITest
{
    /// <summary>Initializes model classes for isolated metadata tests.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
        if (!T2IModelClassSorter.ModelClasses.ContainsKey("anima-2.9b"))
        {
            T2IModelClassSorter.Init();
        }
    }

    /// <summary>Checks checkpoint and adapter upgrades in global, per-folder, and spoke caches.</summary>
    [TestCase("anima", "anima-2.9b", "Stable-Diffusion", 39, false, false)]
    [TestCase("anima", "anima-3.8b", "Stable-Diffusion", 51, true, false)]
    [TestCase("anima-preview", "anima-2.9b", "Stable-Diffusion", 39, true, true)]
    [TestCase("anima", "anima", "Stable-Diffusion", 27, false, false)]
    [TestCase("anima/lora", "anima-2.9b/lora", "LoRA", 39, true, false)]
    [TestCase("anima-preview/lora", "anima-3.8b/lora", "LoRA", 51, false, true)]
    [TestCase("anima/controlnet", "anima-3.8b/controlnet", "ControlNet", 51, false, false)]
    [TestCase("anima/lora", "anima-2.9b/lora", "LoRA", 5, false, false)]
    public static void OldCache_ReclassifiesOnce_PreservesMetadata(string oldClass, string expectedClass, string modelType, int block, bool perFolder, bool spoke)
    {
        VerifyCache(oldClass, expectedClass, modelType, block, perFolder, spoke);
    }

    /// <summary>Other families keep the existing same-version cache path without reopening their headers.</summary>
    [Test]
    public static void OtherFamily_CacheDoesNotReadHeader()
    {
        VerifyCache("krea-2", "krea-2", "Stable-Diffusion", -1, false, false);
    }

    /// <summary>Changes only the isolated process's spoke flag.</summary>
    private static void SetSpokeMode(bool active)
    {
        typeof(Program).GetProperty(nameof(Program.IsSpokeMode), BindingFlags.Public | BindingFlags.Static).GetSetMethod(true).Invoke(null, [active]);
    }

    /// <summary>Loads a synthetic old cache, checks its preservation, then proves that the migration persists.</summary>
    private static void VerifyCache(string oldClass, string expectedClass, string modelType, int block, bool perFolder, bool spoke)
    {
        string root = Path.Combine(Path.GetTempPath(), $"swarm-anima-cache-{Guid.NewGuid():N}");
        string data = Path.Combine(root, "data");
        string models = Path.Combine(root, "models");
        string path = Path.Combine(models, "model.safetensors");
        string savedData = Program.DataDir;
        bool savedSpoke = Program.IsSpokeMode;
        bool savedPerFolder = Program.ServerSettings.Metadata.ModelMetadataPerFolder;
        bool savedRecheck = Program.ServerSettings.Metadata.DebugAlwaysRecheckClass;
        T2IModelHandler handler = new() { ModelType = modelType };
        Directory.CreateDirectory(data);
        Directory.CreateDirectory(models);
        try
        {
            Program.DataDir = data;
            SetSpokeMode(spoke);
            Program.ServerSettings.Metadata.ModelMetadataPerFolder = perFolder;
            Program.ServerSettings.Metadata.DebugAlwaysRecheckClass = false;
            WriteModel(path, oldClass, modelType, block);
            if (block == 5)
            {
                File.WriteAllText(Path.Combine(models, "model.json"), "{\"BaseModel\":\"Anima 2.9B\"}");
            }
            DateTime modified = File.GetLastWriteTimeUtc(path);
            string cacheKey = perFolder && !spoke ? "model.safetensors" : path;
            T2IModelHandler.ModelDatabase cache = handler.GetCacheForFolder(perFolder && !spoke ? models.Replace('\\', '/') : data);
            cache.Metadata.Upsert(new T2IModelHandler.ModelMetadataStore()
            {
                ModelName = cacheKey,
                ModelFileVersion = new DateTimeOffset(modified).ToUnixTimeMilliseconds(),
                ModelClassType = oldClass,
                Title = "Saved title",
                TriggerPhrase = "saved trigger",
                LoraDefaultWeight = "0.7",
                StandardWidth = 832,
                StandardHeight = 1216,
                Hash = "saved hash"
            });
            T2IModel model = new(handler, models, path, "model.safetensors");
            handler.LoadMetadata(model);
            Assert.That(model.ModelClass?.ID, Is.EqualTo(expectedClass));
            Assert.That(model.Title, Is.EqualTo("Saved title"));
            Assert.That(model.Metadata.TriggerPhrase, Is.EqualTo("saved trigger"));
            Assert.That(model.Metadata.LoraDefaultWeight, Is.EqualTo("0.7"));
            Assert.That(model.Metadata.Hash, Is.EqualTo("saved hash"));
            Assert.That(model.StandardWidth, Is.EqualTo(832));
            Assert.That(model.StandardHeight, Is.EqualTo(1216));
            Assert.That(File.GetLastWriteTimeUtc(path), Is.EqualTo(modified));
            Assert.That(cache.Metadata.FindById(cacheKey).ModelClassType, Is.EqualTo(expectedClass));
            if (block >= 0)
            {
                Assert.That(cache.Database.GetCollection<BsonDocument>("models").FindById(cacheKey)["AnimaDepthClassified"].AsBoolean, Is.True);
            }
            handler.Shutdown();
            File.WriteAllText(path, "invalid header");
            File.SetLastWriteTimeUtc(path, modified);
            handler = new() { ModelType = modelType };
            T2IModel cached = new(handler, models, path, "model.safetensors");
            Assert.DoesNotThrow(() => handler.LoadMetadata(cached), "the persistent migration marker must prevent another header read");
            Assert.That(cached.ModelClass?.ID, Is.EqualTo(expectedClass));
        }
        finally
        {
            handler.Shutdown();
            SetSpokeMode(savedSpoke);
            Program.DataDir = savedData;
            Program.ServerSettings.Metadata.ModelMetadataPerFolder = savedPerFolder;
            Program.ServerSettings.Metadata.DebugAlwaysRecheckClass = savedRecheck;
            Directory.Delete(root, true);
        }
    }

    /// <summary>Writes a small synthetic model header with only the tensors needed for class selection.</summary>
    private static void WriteModel(string path, string architecture, string modelType, int block)
    {
        if (block < 0)
        {
            File.WriteAllText(path, "invalid header");
            return;
        }
        JObject header = new()
        {
            ["__metadata__"] = new JObject { ["modelspec.architecture"] = architecture }
        };
        if (modelType == "Stable-Diffusion")
        {
            header["t_embedder.1.linear_2.weight"] = new JObject();
            header["llm_adapter.blocks.0.self_attn.v_proj.weight"] = new JObject();
            header["blocks.27.adaln_modulation_cross_attn.2.weight"] = new JObject();
            header[$"blocks.{block}.adaln_modulation_cross_attn.2.weight"] = new JObject();
        }
        else if (modelType == "LoRA")
        {
            header[$"blocks.{block}.self_attn.v_proj.lora_A.weight"] = new JObject();
        }
        else
        {
            header[$"lllite_dit_blocks_{block}_self_attn_q_proj.up.weight"] = new JObject();
        }
        byte[] bytes = Encoding.UTF8.GetBytes(header.ToString());
        using FileStream file = File.Create(path);
        file.Write(BitConverter.GetBytes((long)bytes.Length));
        file.Write(bytes);
    }
}
