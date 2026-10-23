using Newtonsoft.Json.Linq;
using NUnit.Framework;
using SwarmUI.Builtin_MobileEnhancementsExtension;
using System;
using System.IO;

namespace SwarmUITests;

/// <summary>Verifies discovery against synthetic backend contracts and isolated annotator caches without loading models.</summary>
[TestFixture]
public class SimpleControlNetTests
{
    /// <summary>Unknown backends cannot advertise Anima guidance.</summary>
    [Test]
    public void MissingNodes_AreUnavailable()
    {
        JObject result = SimpleControlNetAPI.BuildCapabilities(null, null);
        Assert.That((bool)result["supported"], Is.False);
        Assert.That((JArray)result["patches"], Is.Empty);
        Assert.That((JObject)result["preprocessors"], Is.Empty);
    }

    /// <summary>Patch and checkpoint names remain exact. Discovery must not mutate the backend's node snapshot.</summary>
    [Test]
    public void RegisteredNames_ArePreservedAndDetached()
    {
        JObject info = JObject.Parse("""{"AnimaLLLiteApply":{"input":{"required":{"model_patch":["MODEL_PATCH"]}}},"ModelPatchLoader":{"input":{"required":{"name":[["folder\\\\pose.safetensors"]]}}},"UNETLoader":{"input":{"required":{"unet_name":[["base.safetensors"]]}}}}""");
        JObject result = SimpleControlNetAPI.BuildCapabilities(info, null);
        Assert.That((bool)result["supported"], Is.True);
        Assert.That((string)result["checkpoints"][0], Is.EqualTo("base.safetensors"));
        Assert.That((string)result["patches"][0], Is.EqualTo((string)info["ModelPatchLoader"]["input"]["required"]["name"][0][0]));
        ((JArray)result["patches"]).Clear();
        Assert.That((JArray)info["ModelPatchLoader"]["input"]["required"]["name"][0], Has.Count.EqualTo(1));
    }

    /// <summary>Remote cache contents are unknown. Only registered checkpoint-free processors are safe there.</summary>
    [Test]
    public void RemoteCache_DoesNotAssumePoseOrDepthWeights()
    {
        JObject info = Annotators();
        JObject processors = (JObject)SimpleControlNetAPI.BuildCapabilities(info, null)["preprocessors"];
        Assert.That((bool)processors["LineartStandardPreprocessor"], Is.True);
        Assert.That((bool)processors["ScribblePreprocessor"], Is.True);
        Assert.That(processors.ContainsKey("DWPreprocessor"), Is.False);
        Assert.That(processors.ContainsKey("DepthAnythingV2Preprocessor"), Is.False);
    }

    /// <summary>DWPose must use the detector Swarm actually selects, not the node's default ONNX detector.</summary>
    [Test]
    public void LocalCache_RequiresActualGraphDefaults()
    {
        string root = Path.Combine(Path.GetTempPath(), $"swarm-control-test-{Guid.NewGuid():N}");
        try
        {
            void cached(string relative)
            {
                string path = Path.Combine(root, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.WriteAllBytes(path, [1]);
            }
            cached("yzd-v/DWPose/yolox_l.onnx");
            cached("hr16/DWPose-TorchScript-BatchSize5/dw-ll_ucoco_384_bs5.torchscript.pt");
            JObject info = Annotators();
            JObject missing = (JObject)SimpleControlNetAPI.BuildCapabilities(info, root)["preprocessors"];
            Assert.That(missing.ContainsKey("DWPreprocessor"), Is.False);
            cached("hr16/yolox-onnx/yolox_l.torchscript.pt");
            cached("depth-anything/Depth-Anything-V2-Large/depth_anything_v2_vitl.pth");
            JObject ready = (JObject)SimpleControlNetAPI.BuildCapabilities(info, root)["preprocessors"];
            Assert.That((bool)ready["DWPreprocessor"], Is.True);
            Assert.That((bool)ready["DepthAnythingV2Preprocessor"], Is.True);
            info["DepthAnythingV2Preprocessor"]["input"]["required"]["ckpt_name"][1]["default"] = "unknown.pth";
            Assert.That(((JObject)SimpleControlNetAPI.BuildCapabilities(info, root)["preprocessors"]).ContainsKey("DepthAnythingV2Preprocessor"), Is.False);
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, true);
            }
        }
    }

    /// <summary>Minimal contracts for the supported preprocessor inputs.</summary>
    private static JObject Annotators()
    {
        return JObject.Parse("""{"LineartStandardPreprocessor":{},"ScribblePreprocessor":{},"DWPreprocessor":{"input":{"required":{"pose_estimator":[["unused.pt","dw-ll_ucoco_384_bs5.torchscript.pt"],{"default":"dw-ll_ucoco_384_bs5.torchscript.pt"}]}}},"DepthAnythingV2Preprocessor":{"input":{"required":{"ckpt_name":[["depth_anything_v2_vits.pth","depth_anything_v2_vitl.pth"],{"default":"depth_anything_v2_vitl.pth"}]}}}}""");
    }
}
