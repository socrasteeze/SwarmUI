using Newtonsoft.Json.Linq;
using SwarmUI.Builtin_ComfyUIBackend;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;

namespace SwarmUI.Builtin_H3Accel;

/// <summary>Exposes two third-party MiniMax H3 ComfyUI accelerator nodes - "H3 Memory Optimization"
/// (<see cref="MemoryNodeName"/>, from the H3-Optimizations node pack) and "H3 FirstBlockCache"
/// (<see cref="FbcNodeName"/>, from ComfyUI-MiniMaxH3-FirstBlockCache) - as native SwarmUI parameters.
/// Neither node ships with this extension: both are installable third-party Comfy node packs, detected
/// the same way core detects TeaCache/EasyCache/Nunchaku/etc, via <see cref="ComfyUIBackendExtension.NodeToFeatureMap"/>.
/// Fork-owned; zero core-file edits.</summary>
public class H3AccelExtension : Extension
{
    /// <summary>Core node emitted by WorkflowGeneratorModelSupport.IsMiniMaxH3() for every H3 model load. This
    /// extension never edits that core file; it only reacts to the node it emits.</summary>
    public const string SigmaShiftNodeName = "MiniMaxH3SigmaShift";

    /// <summary>Comfy's core sampler node class, used to find the final model input right before sampling.</summary>
    public const string SamplerNodeName = "SwarmKSampler";

    /// <summary>Node class of the third-party (SwarmUI-H3Attn extension) Spectrum forecaster. Detected purely by
    /// scanning the generated workflow for this class name, so this extension has no compile-time or runtime
    /// dependency on H3Attn - Spectrum detection works whether or not that extension is even installed.</summary>
    public const string SpectrumNodeName = "SpectrumApplyMiniMaxH3";

    /// <summary>Node class of the H3-Optimizations "H3 Memory Optimization" node.</summary>
    public const string MemoryNodeName = "H3MemoryOptimization";

    /// <summary>Comfy feature flag advertised once <see cref="MemoryNodeName"/> is detected on the backend.</summary>
    public const string MemoryFeatureFlag = "h3_memory_optimization";

    /// <summary>Node class of the ComfyUI-MiniMaxH3-FirstBlockCache "MiniMax H3 FirstBlockCache" node.</summary>
    public const string FbcNodeName = "ApplyMiniMaxH3FirstBlockCache";

    /// <summary>Comfy feature flag advertised once <see cref="FbcNodeName"/> is detected on the backend.</summary>
    public const string FbcFeatureFlag = "h3_first_block_cache";

    /// <summary>Runs immediately after model load, before any other H3 patch. Core's last step is priority 200;
    /// the third-party SwarmUI-H3Attn extension's own step (Window/Sol-Attn/Spectrum) runs at priority 1000.
    /// 500 sits between the two, so Memory Optimization becomes the base of the H3 patch chain and everything
    /// H3Attn attaches - including Sol-Attn ("Sparse Attention") and its AIMDO limiter - wraps around it, never
    /// the other way around.</summary>
    public const double MemoryStepPriority = 500;

    /// <summary>Runs last, after H3Attn's own step (priority 1000) has attached its sigma-shift/window/Sol-Attn/
    /// Spectrum patches, and immediately before the sampler consumes the model.</summary>
    public const double FbcStepPriority = 1500;

    public static T2IParamGroup MemoryGroup, FbcGroup;

    // ---- H3 Memory Optimization params (node: H3MemoryOptimization) ----
    public static T2IRegisteredParam<string> MemMlpMemory, MemQkvStreaming, MemAttentionMode, MemPrecisionMode;
    public static T2IRegisteredParam<int> MemChunkRows;

    // ---- H3 FirstBlockCache params (node: ApplyMiniMaxH3FirstBlockCache) ----
    public static T2IRegisteredParam<string> FbcMode;
    public static T2IRegisteredParam<double> FbcThreshold, FbcStartPercent, FbcEndPercent;
    public static T2IRegisteredParam<int> FbcMaxConsecutiveHits;
    public static T2IRegisteredParam<bool> FbcTemporalGuard;

    // ---- H3MemoryOptimization widget-facing enum literals (exact strings the node's schema expects) ----
    public const string MlpMemoryAuto = "auto";
    public const string MlpMemoryOff = "off";
    public const string QkvStreamingOff = "Off";
    public const string QkvStreamingAuto = "Auto";
    public const string QkvStreamingForced = "Forced";
    public const string AttentionModeStandard = "Standard";
    public const string AttentionModeLowerVram = "Lower VRAM (slower)";
    public const string PrecisionModeAuto = "Auto";
    public const string PrecisionModeBf16 = "BF16";
    public const string PrecisionModePreserveNative = "Preserve native";
    public const string PrecisionModeForceQuant = "Force quant";

    // ---- H3MemoryOptimization legacy/hidden widget slots. The node itself marks these 'hidden' and ignores
    // their value functionally (kept only so old serialized workflows still deserialize); this extension never
    // builds an old serialized workflow, so it always sends the node's own defaults for these three. ----
    public const string LegacyFusedQkv = MlpMemoryAuto;
    public const bool LegacyPreservePrecision = true;
    public const string LegacyEmbeddingMemoryMode = "Auto";

    // ---- ApplyMiniMaxH3FirstBlockCache widget-facing enum literals ----
    public const string FbcModeSafe = "H3 Safe — 0.08 / max 2";
    public const string FbcModeFast = "H3 Fast — 0.10 / max 2";
    public const string FbcModeAggressive = "H3 Aggressive — 0.12 / max 2";
    public const string FbcModeExperimental = "H3 Experimental";
    public const string FbcModeCustom = "Custom — manual values";

    /// <inheritdoc/>
    public override void OnInit()
    {
        ComfyUIBackendExtension.NodeToFeatureMap[MemoryNodeName] = MemoryFeatureFlag;
        ComfyUIBackendExtension.NodeToFeatureMap[FbcNodeName] = FbcFeatureFlag;
        InstallableFeatures.RegisterInstallableFeature(new(
            "H3 Memory Optimization",
            MemoryFeatureFlag,
            "https://github.com/Zironic/H3-Optimizations",
            "Zironic"
        ));
        InstallableFeatures.RegisterInstallableFeature(new(
            "H3 FirstBlockCache",
            FbcFeatureFlag,
            "https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache",
            "duckyshell"
        ));

        MemoryGroup = new T2IParamGroup(
            Name: "H3 Memory Optimization",
            Toggles: true,
            Open: false,
            IsAdvanced: false,
            OrderPriority: 8,
            Description: "MiniMax H3: streams QKV and chunks MLP/FinalLayer execution to cut peak VRAM, via the H3-Optimizations node. Applied immediately after model load, before any other H3 patch."
        );

        FbcGroup = new T2IParamGroup(
            Name: "H3 FirstBlockCache",
            Toggles: true,
            Open: false,
            IsAdvanced: false,
            OrderPriority: 10,
            Description: "MiniMax H3: reuses the cached first-block residual across similar denoising steps, via the ComfyUI-MiniMaxH3-FirstBlockCache node. Attached last, immediately before the sampler. Skipped (with a log warning) whenever TeaCache, EasyCache, or Spectrum is also active on the same generation."
        );

        MemMlpMemory = T2IParamTypes.Register<string>(new T2IParamType(
            Name: "H3 Mem MLP Memory",
            Description: "MLP memory optimization. Auto keeps bounded MLP/FinalLayer chunking under the node's precision policy. Off disables MLP chunking entirely.",
            Default: MlpMemoryAuto,
            GetValues: _ => [MlpMemoryAuto, MlpMemoryOff],
            Group: MemoryGroup,
            FeatureFlag: MemoryFeatureFlag,
            OrderPriority: 0
        ));

        MemQkvStreaming = T2IParamTypes.Register<string>(new T2IParamType(
            Name: "H3 Mem QKV Streaming",
            Description: "QKV streaming mode. Off leaves attention untouched. Auto adds a bounded streamed QKV carrier around the existing attention backend (Sage, Comfy Kitchen, or plain), including one requested by H3 Sparse Attention. Forced lets this node replace dense attention with full-density Kitchen.",
            Default: QkvStreamingAuto,
            GetValues: _ => [QkvStreamingOff, QkvStreamingAuto, QkvStreamingForced],
            Group: MemoryGroup,
            FeatureFlag: MemoryFeatureFlag,
            OrderPriority: 1
        ));

        MemAttentionMode = T2IParamTypes.Register<string>(new T2IParamType(
            Name: "H3 Mem Attention Mode",
            Description: "Attention memory mode. Standard prioritizes speed. Lower VRAM trades additional attention work for lower peak memory.",
            Default: AttentionModeStandard,
            GetValues: _ => [AttentionModeStandard, AttentionModeLowerVram],
            Group: MemoryGroup,
            FeatureFlag: MemoryFeatureFlag,
            OrderPriority: 2
        ));

        MemPrecisionMode = T2IParamTypes.Register<string>(new T2IParamType(
            Name: "H3 Mem Precision Mode",
            Description: "Precision policy for QKV/MLP execution. Auto picks the best compatible native path (may fall back to FP8). BF16 materializes supported weights as BF16. Preserve native never introduces a new conversion. Force quant converts floating H3 linears to execution-scoped INT8.",
            Default: PrecisionModeAuto,
            GetValues: _ => [PrecisionModeAuto, PrecisionModeBf16, PrecisionModePreserveNative, PrecisionModeForceQuant],
            IsAdvanced: true,
            Group: MemoryGroup,
            FeatureFlag: MemoryFeatureFlag,
            OrderPriority: 3
        ));

        MemChunkRows = T2IParamTypes.Register<int>(new T2IParamType(
            Name: "H3 Mem Chunk Rows",
            Description: "Maximum token rows processed by one MLP/FinalLayer chunk. Larger chunks may be faster but use more activation memory. At or above the current input length, the ordinary unsliced MLP runs instead.",
            Default: "4096",
            Min: 256, Max: 65536, Step: 256,
            IsAdvanced: true,
            Group: MemoryGroup,
            FeatureFlag: MemoryFeatureFlag,
            OrderPriority: 4
        ));

        FbcMode = T2IParamTypes.Register<string>(new T2IParamType(
            Name: "H3 FBC Mode",
            Description: "FirstBlockCache mode. The Safe/Fast/Aggressive presets always use their own calibrated values and ignore Temporal Guard. Custom (the default here) uses this group's own Threshold/Start/End/Max Hits/Temporal Guard values - set to the Safe preset's numbers with Temporal Guard on, for the closest match to reference output plus the extra motion-aware safety check. Experimental is a separate deep-reuse cache mode with no tunable values.",
            Default: FbcModeCustom,
            GetValues: _ => [FbcModeSafe, FbcModeFast, FbcModeAggressive, FbcModeExperimental, FbcModeCustom],
            Group: FbcGroup,
            FeatureFlag: FbcFeatureFlag,
            OrderPriority: 0
        ));

        FbcThreshold = T2IParamTypes.Register<double>(new T2IParamType(
            Name: "H3 FBC Threshold",
            Description: "Relative first-block residual-change threshold below which a step is cached instead of computed. Only used in Custom/Experimental-adjacent tuning; ignored by the named presets. 0.08 is the Safe preset's value.",
            Default: "0.08",
            Min: 0, Max: 1, Step: 0.005,
            ViewType: ParamViewType.SLIDER,
            Group: FbcGroup,
            FeatureFlag: FbcFeatureFlag,
            OrderPriority: 1
        ));

        FbcStartPercent = T2IParamTypes.Register<double>(new T2IParamType(
            Name: "H3 FBC Start Percent",
            Description: "Caching is only considered after this fraction of the denoising schedule has run. Only used in Custom mode.",
            Default: "0.10",
            Min: 0, Max: 1, Step: 0.01,
            ViewType: ParamViewType.SLIDER,
            Group: FbcGroup,
            FeatureFlag: FbcFeatureFlag,
            OrderPriority: 2
        ));

        FbcEndPercent = T2IParamTypes.Register<double>(new T2IParamType(
            Name: "H3 FBC End Percent",
            Description: "Caching stops being considered after this fraction of the denoising schedule. Only used in Custom mode.",
            Default: "0.95",
            Min: 0, Max: 1, Step: 0.01,
            ViewType: ParamViewType.SLIDER,
            Group: FbcGroup,
            FeatureFlag: FbcFeatureFlag,
            OrderPriority: 3
        ));

        FbcMaxConsecutiveHits = T2IParamTypes.Register<int>(new T2IParamType(
            Name: "H3 FBC Max Consecutive Hits",
            Description: "Maximum consecutive cached (skipped) steps before the next step is always computed for real. Only used in Custom mode.",
            Default: "2",
            Min: 1, Max: 20, Step: 1,
            Group: FbcGroup,
            FeatureFlag: FbcFeatureFlag,
            OrderPriority: 4
        ));

        FbcTemporalGuard = T2IParamTypes.Register<bool>(new T2IParamType(
            Name: "H3 FBC Temporal Guard",
            Description: "Also checks the most-changed target-video latent frame (not just the global mean) before allowing a cache hit, catching local motion a global average can hide. Only takes effect in Custom mode - the named presets always ignore it. On by default here for the extra safety margin.",
            Default: "true",
            Group: FbcGroup,
            FeatureFlag: FbcFeatureFlag,
            OrderPriority: 5
        ));

        WorkflowGenerator.AddStep(ApplyMemory, MemoryStepPriority);
        WorkflowGenerator.AddStep(ApplyFbc, FbcStepPriority);
    }

    /// <summary>Attaches H3 Memory Optimization directly onto every H3 sigma-shift node's output, so it becomes
    /// the base of the H3 patch chain - everything H3Attn later attaches (Window/Sol-Attn/Spectrum) wraps
    /// around it, not the reverse.</summary>
    private static void ApplyMemory(WorkflowGenerator generator)
    {
        if (!generator.UserInput.TryGet(MemMlpMemory, out _))
        {
            return;
        }
        if (!generator.Features.Contains(MemoryFeatureFlag))
        {
            throw new SwarmUserErrorException("H3 Memory Optimization parameters were specified, but the H3-Optimizations comfy node isn't installed on the backend.");
        }
        List<string> shiftIds = FindNodeIdsOfClass(generator.Workflow, SigmaShiftNodeName);
        if (shiftIds.Count == 0)
        {
            Logs.Debug($"H3 Accel: H3 Memory Optimization enabled but the workflow has no {SigmaShiftNodeName} node (not a MiniMax H3 generation); skipping.");
            return;
        }
        string mlpMemory = generator.UserInput.Get(MemMlpMemory, MlpMemoryAuto);
        string qkvStreaming = generator.UserInput.Get(MemQkvStreaming, QkvStreamingAuto);
        string attentionMode = generator.UserInput.Get(MemAttentionMode, AttentionModeStandard);
        string precisionMode = generator.UserInput.Get(MemPrecisionMode, PrecisionModeAuto);
        int chunkRows = generator.UserInput.Get(MemChunkRows, 4096);
        foreach (string shiftId in shiftIds)
        {
            JArray shiftOut = new(shiftId, 0);
            JObject inputs = BuildMemoryNodeInputs(mlpMemory, qkvStreaming, attentionMode, precisionMode, chunkRows);
            // The configure-action overload skips the input-hash dedupe cache: without it, two sigma-shift
            // nodes would build byte-identical inputs here (neither has "model" set yet) and collapse into
            // one shared node. Order matters too: replace existing consumers of the shift output first, then
            // point this node's own "model" at the shift - doing it the other way rewrites a self-reference.
            string nodeId = generator.CreateNode(MemoryNodeName, (_, node) => node["inputs"] = inputs);
            generator.ReplaceNodeConnection(shiftOut, new JArray(nodeId, 0));
            ((JObject)generator.Workflow[nodeId]["inputs"])["model"] = shiftOut;
        }
        Logs.Debug($"H3 Accel: attached H3 Memory Optimization across {shiftIds.Count} {SigmaShiftNodeName} model(s).");
    }

    /// <summary>Attaches H3 FirstBlockCache directly onto every H3 sampler's current model input - whatever
    /// H3Attn (and Memory Optimization) already patched it to - making it the last model patch before the
    /// sampler. Skips (with a warning) when TeaCache, EasyCache, or Spectrum is active on this generation.</summary>
    private static void ApplyFbc(WorkflowGenerator generator)
    {
        if (!generator.UserInput.TryGet(FbcMode, out string mode))
        {
            return;
        }
        if (!generator.Features.Contains(FbcFeatureFlag))
        {
            throw new SwarmUserErrorException("H3 FirstBlockCache parameters were specified, but the ComfyUI-MiniMaxH3-FirstBlockCache comfy node isn't installed on the backend.");
        }
        HashSet<string> shiftIds = [.. FindNodeIdsOfClass(generator.Workflow, SigmaShiftNodeName)];
        if (shiftIds.Count == 0)
        {
            Logs.Debug($"H3 Accel: H3 FirstBlockCache enabled but the workflow has no {SigmaShiftNodeName} node (not a MiniMax H3 generation); skipping.");
            return;
        }
        string teaCacheMode = generator.UserInput.Get(ComfyUIBackendExtension.TeaCacheMode, "disabled");
        string easyCacheMode = generator.UserInput.Get(ComfyUIBackendExtension.EasyCacheMode, "disabled");
        bool spectrumActive = FindNodeIdsOfClass(generator.Workflow, SpectrumNodeName).Count > 0;
        if (ShouldSkipFbc(teaCacheMode, easyCacheMode, spectrumActive, out string reason))
        {
            Logs.Warning($"H3 Accel: skipping H3 FirstBlockCache - {reason}");
            return;
        }
        double threshold = generator.UserInput.Get(FbcThreshold, 0.08);
        double startPercent = generator.UserInput.Get(FbcStartPercent, 0.10);
        double endPercent = generator.UserInput.Get(FbcEndPercent, 0.95);
        int maxConsecutiveHits = generator.UserInput.Get(FbcMaxConsecutiveHits, 2);
        bool temporalGuard = generator.UserInput.Get(FbcTemporalGuard, true);
        int attached = 0;
        foreach (JProperty samplerProp in generator.NodesOfClass(SamplerNodeName))
        {
            JObject inputs = (samplerProp.Value as JObject)?["inputs"] as JObject;
            if (inputs?["model"] is not JArray model || !ModelChainReachesAny(generator.Workflow, model, shiftIds))
            {
                continue;
            }
            JObject fbcInputs = BuildFbcNodeInputs(model, mode, threshold, startPercent, endPercent, maxConsecutiveHits, temporalGuard);
            string fbcId = generator.CreateNode(FbcNodeName, (_, node) => node["inputs"] = fbcInputs);
            inputs["model"] = new JArray(fbcId, 0);
            attached++;
        }
        Logs.Debug($"H3 Accel: attached H3 FirstBlockCache ({mode}) to {attached} sampler(s).");
    }

    /// <summary>Builds the H3MemoryOptimization node's "inputs" object (everything but "model", which the
    /// caller attaches separately). Pure/testable: no <see cref="WorkflowGenerator"/> dependency.</summary>
    public static JObject BuildMemoryNodeInputs(string mlpMemory, string qkvStreamingMode, string attentionMode, string precisionMode, int chunkRows)
    {
        return new JObject()
        {
            ["fused_qkv"] = LegacyFusedQkv,
            ["mlp_memory"] = mlpMemory,
            ["chunk_rows"] = chunkRows,
            ["preserve_precision"] = LegacyPreservePrecision,
            ["precision_mode"] = precisionMode,
            ["qkv_streaming_mode"] = qkvStreamingMode,
            ["embedding_memory_mode"] = LegacyEmbeddingMemoryMode,
            ["kitchen_v_memory_mode"] = attentionMode
        };
    }

    /// <summary>Builds the ApplyMiniMaxH3FirstBlockCache node's full "inputs" object, including "model".
    /// Pure/testable: no <see cref="WorkflowGenerator"/> dependency.</summary>
    public static JObject BuildFbcNodeInputs(JArray model, string mode, double threshold, double startPercent, double endPercent, int maxConsecutiveHits, bool temporalGuard)
    {
        return new JObject()
        {
            ["model"] = model,
            ["mode"] = mode,
            ["threshold"] = threshold,
            ["start_percent"] = startPercent,
            ["end_percent"] = endPercent,
            ["max_consecutive_hits"] = maxConsecutiveHits,
            ["temporal_guard"] = temporalGuard
        };
    }

    /// <summary>Decides whether H3 FirstBlockCache must be skipped this generation, and why. Active TeaCache or
    /// EasyCache both alter the same per-step model-execution path FirstBlockCache reads its residual diff
    /// from, and Spectrum forecasting skips the transformer body outright on forecast steps - any of the three
    /// would corrupt FirstBlockCache's cache/skip decision if stacked underneath it. Pure/testable: takes
    /// already-resolved state rather than reading a <see cref="WorkflowGenerator"/> itself.</summary>
    public static bool ShouldSkipFbc(string teaCacheMode, string easyCacheMode, bool spectrumActive, out string reason)
    {
        List<string> reasons = [];
        if (!string.IsNullOrWhiteSpace(teaCacheMode) && teaCacheMode != "disabled")
        {
            reasons.Add("TeaCache is active");
        }
        if (!string.IsNullOrWhiteSpace(easyCacheMode) && easyCacheMode != "disabled")
        {
            reasons.Add("EasyCache is active");
        }
        if (spectrumActive)
        {
            reasons.Add("Spectrum forecasting is active");
        }
        if (reasons.Count == 0)
        {
            reason = null;
            return false;
        }
        reason = $"{string.Join(" and ", reasons)} on this generation, and stacking FirstBlockCache underneath would corrupt its residual-diff cache/skip decision.";
        return true;
    }

    /// <summary>Returns the node IDs of every node in <paramref name="workflow"/> whose class_type matches
    /// <paramref name="classType"/>. Pure/testable: takes a raw workflow object rather than a
    /// <see cref="WorkflowGenerator"/> instance.</summary>
    public static List<string> FindNodeIdsOfClass(JObject workflow, string classType)
    {
        List<string> ids = [];
        foreach (JProperty property in workflow.Properties())
        {
            if ($"{property.Value["class_type"]}" == classType)
            {
                ids.Add(property.Name);
            }
        }
        return ids;
    }

    /// <summary>Walks a node's "model" input connection upstream, through however many intermediate patch
    /// nodes, to see whether it eventually reaches one of <paramref name="targetIds"/>. Used to tell whether a
    /// given sampler's model chain actually originates from a MiniMax H3 sigma-shift node. Guards against
    /// cycles. Pure/testable: takes a raw workflow object rather than a <see cref="WorkflowGenerator"/>
    /// instance.</summary>
    public static bool ModelChainReachesAny(JObject workflow, JArray modelConnection, HashSet<string> targetIds)
    {
        HashSet<string> visited = [];
        JArray current = modelConnection;
        while (current is not null && current.Count == 2)
        {
            string nodeId = $"{current[0]}";
            if (!visited.Add(nodeId))
            {
                return false;
            }
            if (targetIds.Contains(nodeId))
            {
                return true;
            }
            if (workflow[nodeId] is not JObject node || node["inputs"] is not JObject inputs || inputs["model"] is not JArray upstream)
            {
                return false;
            }
            current = upstream;
        }
        return false;
    }
}
