using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Builtin_ComfyUIBackend;
using SwarmUI.Core;
using SwarmUI.WebAPI;
using System.IO;

namespace SwarmUI.Builtin_MobileEnhancementsExtension;

/// <summary>Read-only discovery for the simple client's Anima controls. Never loads models or downloads annotators.</summary>
[API.APIClass("Simple ControlNet")]
public static class SimpleControlNetAPI
{
    /// <summary>Returns each running Comfy backend's registered patch names and verified local preprocessors.</summary>
    public static Task<JObject> GetSimpleControlNetCapabilities(Session session)
    {
        JArray backends = [];
        foreach (ComfyUIAPIAbstractBackend backend in Program.Backends.RunningBackendsOfType<ComfyUIAPIAbstractBackend>())
        {
            if (!backend.IsEnabled)
            {
                continue;
            }
            // Only self-start backends use this checkout's annotator cache. Remote cache contents are unknown.
            string cache = backend is ComfyUISelfStartBackend
                ? Path.Combine(ComfyUIBackendExtension.Folder, "DLNodes", "comfyui_controlnet_aux", "ckpts") : null;
            JObject capability = BuildCapabilities(backend.RawObjectInfo, cache);
            foreach (string key in new[] { "patches", "checkpoints" })
            {
                capability[key] = new JArray(((JArray)capability[key]).Where(name => session.User.IsAllowedModel(((string)name).Replace('\\', '/'))));
            }
            capability["id"] = backend.BackendData.ID;
            backends.Add(capability);
        }
        return Task.FromResult(new JObject() { ["backends"] = backends });
    }

    /// <summary>Describes only installed node contracts and checkpoint-free or locally cached preprocessing paths.</summary>
    public static JObject BuildCapabilities(JObject info, string annotatorCache)
    {
        info ??= new JObject();
        JArray patches = info["ModelPatchLoader"]?["input"]?["required"]?["name"]?[0] as JArray ?? [];
        JArray checkpoints = [];
        foreach ((string node, string input) in new[] { ("UNETLoader", "unet_name"), ("UnetLoaderGGUF", "unet_name"), ("CheckpointLoaderSimple", "ckpt_name") })
        {
            if (info[node]?["input"]?["required"]?[input]?[0] is JArray names)
            {
                foreach (JToken name in names)
                {
                    checkpoints.Add(name.DeepClone());
                }
            }
        }
        JObject processors = new();
        foreach (string node in new[] { "LineartStandardPreprocessor", "ScribblePreprocessor", "Scribble_XDoG_Preprocessor", "CannyEdgePreprocessor" })
        {
            if (info[node] is JObject)
            {
                processors[node] = true;
            }
        }
        if (annotatorCache is not null)
        {
            string pose = DefaultChoice(info, "DWPreprocessor", "pose_estimator");
            string poseFolder = pose == "dw-ll_ucoco_384_bs5.torchscript.pt" ? "hr16/DWPose-TorchScript-BatchSize5" : "yzd-v/DWPose";
            // WorkflowGenerator.CreatePreprocessor explicitly selects this detector instead of the node's combo default.
            if ((pose == "dw-ll_ucoco_384_bs5.torchscript.pt" || pose == "dw-ll_ucoco_384.onnx")
                && File.Exists(Path.Combine(annotatorCache, "hr16/yolox-onnx", "yolox_l.torchscript.pt"))
                && File.Exists(Path.Combine(annotatorCache, poseFolder, pose)))
            {
                processors["DWPreprocessor"] = true;
            }
            string depth = DefaultChoice(info, "DepthAnythingV2Preprocessor", "ckpt_name");
            string depthSize = depth switch
            {
                "depth_anything_v2_vitl.pth" => "Large",
                "depth_anything_v2_vitb.pth" => "Base",
                "depth_anything_v2_vits.pth" => "Small",
                _ => null
            };
            if (depthSize is not null && File.Exists(Path.Combine(annotatorCache, $"depth-anything/Depth-Anything-V2-{depthSize}", depth)))
            {
                processors["DepthAnythingV2Preprocessor"] = true;
            }
        }
        return new JObject()
        {
            ["supported"] = (string)info["AnimaLLLiteApply"]?["input"]?["required"]?["model_patch"]?[0] == "MODEL_PATCH"
                && info["ModelPatchLoader"] is JObject,
            ["patches"] = patches.DeepClone(),
            ["checkpoints"] = checkpoints,
            ["preprocessors"] = processors
        };
    }

    /// <summary>Reads the same combo default used when Swarm builds a preprocessor node. Unknown contracts stay unavailable.</summary>
    public static string DefaultChoice(JObject info, string node, string input)
    {
        JToken field = info[node]?["input"]?["required"]?[input] ?? info[node]?["input"]?["optional"]?[input];
        if (field is not JArray array || array.Count == 0 || array[0] is not JArray choices)
        {
            return null;
        }
        return (array.Count > 1 ? (string)array[1]?["default"] : null) ?? (string)choices.FirstOrDefault();
    }
}
