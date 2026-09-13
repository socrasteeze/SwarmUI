using Newtonsoft.Json.Linq;
using NUnit.Framework;
using SwarmUI.Builtin_H3Accel;
using System.Collections.Generic;

namespace SwarmUITests;

/// <summary>Tests the pure/testable surface of the H3Accel extension: the workflow-graph scan helpers
/// (<see cref="H3AccelExtension.FindNodeIdsOfClass"/>, <see cref="H3AccelExtension.ModelChainReachesAny"/>),
/// the node-input builders (<see cref="H3AccelExtension.BuildMemoryNodeInputs"/>,
/// <see cref="H3AccelExtension.BuildFbcNodeInputs"/>), the FirstBlockCache exclusion decision
/// (<see cref="H3AccelExtension.ShouldSkipFbc"/>), and the two step priority constants. None of this needs a
/// live <see cref="SwarmUI.Builtin_ComfyUIBackend.WorkflowGenerator"/>, a backend, or a session - every function
/// under test takes plain data and returns plain data. The <c>ApplyMemory</c>/<c>ApplyFbc</c> step bodies that
/// wire these functions into a real WorkflowGenerator are deliberately not exercised here.</summary>
[TestFixture]
public class H3AccelTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Builds a minimal workflow node: {class_type, inputs:{model:[fromId,fromSlot]}} (or no "model"
    /// input at all when <paramref name="fromId"/> is null).</summary>
    private static JObject MakeNode(string classType, string fromId = null, int fromSlot = 0)
    {
        JObject inputs = new();
        if (fromId is not null)
        {
            inputs["model"] = new JArray(fromId, fromSlot);
        }
        return new JObject()
        {
            ["class_type"] = classType,
            ["inputs"] = inputs
        };
    }

    #region Step priorities

    /// <summary>Memory Optimization must run after every core step (core's last is priority 200) but before the
    /// third-party H3Attn extension's own step (priority 1000), so Memory Optimization becomes the base of the
    /// H3 patch chain.</summary>
    [Test]
    public void MemoryStepPriority_SitsBetweenCoreAndH3Attn()
    {
        Assert.That(H3AccelExtension.MemoryStepPriority, Is.GreaterThan(200));
        Assert.That(H3AccelExtension.MemoryStepPriority, Is.LessThan(1000));
    }

    /// <summary>FirstBlockCache must run after H3Attn's own step (priority 1000), so it becomes the last model
    /// patch before the sampler.</summary>
    [Test]
    public void FbcStepPriority_RunsAfterH3Attn()
    {
        Assert.That(H3AccelExtension.FbcStepPriority, Is.GreaterThan(1000));
    }

    /// <summary>Ordering sanity: Memory Optimization always attaches before FirstBlockCache.</summary>
    [Test]
    public void MemoryStepPriority_RunsBeforeFbcStepPriority()
    {
        Assert.That(H3AccelExtension.MemoryStepPriority, Is.LessThan(H3AccelExtension.FbcStepPriority));
    }

    #endregion

    #region FindNodeIdsOfClass (H3-only insertion gate)

    /// <summary>A workflow with no MiniMax H3 sigma-shift node reports zero matches - this is exactly the check
    /// both ApplyMemory and ApplyFbc use to silently no-op on a non-H3 generation.</summary>
    [Test]
    public void FindNodeIdsOfClass_NoMatch_ReturnsEmpty()
    {
        JObject workflow = new()
        {
            ["4"] = MakeNode("CheckpointLoaderSimple"),
            ["10"] = MakeNode("SwarmKSampler", "4")
        };
        Assert.That(H3AccelExtension.FindNodeIdsOfClass(workflow, H3AccelExtension.SigmaShiftNodeName), Is.Empty);
    }

    /// <summary>An H3 workflow's sigma-shift node(s) are found by ID, and only those.</summary>
    [Test]
    public void FindNodeIdsOfClass_Match_ReturnsExactIds()
    {
        JObject workflow = new()
        {
            ["4"] = MakeNode("CheckpointLoaderSimple"),
            ["5"] = MakeNode(H3AccelExtension.SigmaShiftNodeName, "4"),
            ["6"] = MakeNode(H3AccelExtension.SigmaShiftNodeName, "4"),
            ["10"] = MakeNode("SwarmKSampler", "5")
        };
        List<string> found = H3AccelExtension.FindNodeIdsOfClass(workflow, H3AccelExtension.SigmaShiftNodeName);
        Assert.That(found, Is.EquivalentTo(new[] { "5", "6" }));
    }

    #endregion

    #region ModelChainReachesAny (per-sampler H3 detection for FirstBlockCache)

    /// <summary>A sampler wired directly to a target node reaches it in one hop.</summary>
    [Test]
    public void ModelChainReachesAny_DirectConnection_ReturnsTrue()
    {
        JObject workflow = new()
        {
            ["5"] = MakeNode(H3AccelExtension.SigmaShiftNodeName, "4")
        };
        Assert.That(H3AccelExtension.ModelChainReachesAny(workflow, new JArray("5", 0), ["5"]), Is.True);
    }

    /// <summary>A sampler's model input has to walk through several intermediate patch nodes (Memory
    /// Optimization, Window, Sol-Attn, Spectrum, ...) before it reaches the sigma-shift node - exactly the
    /// shape of the chain by the time FirstBlockCache's step runs.</summary>
    [Test]
    public void ModelChainReachesAny_MultiHopChain_ReturnsTrue()
    {
        JObject workflow = new()
        {
            ["5"] = MakeNode(H3AccelExtension.SigmaShiftNodeName, "4"),
            ["6"] = MakeNode(H3AccelExtension.MemoryNodeName, "5"),
            ["7"] = MakeNode("H3WindowAttentionPatch", "6"),
            ["8"] = MakeNode("SolAttnPatch", "7")
        };
        Assert.That(H3AccelExtension.ModelChainReachesAny(workflow, new JArray("8", 0), ["5"]), Is.True);
    }

    /// <summary>A chain that terminates at an unrelated loader never reaches the target set.</summary>
    [Test]
    public void ModelChainReachesAny_UnrelatedChain_ReturnsFalse()
    {
        JObject workflow = new()
        {
            ["4"] = MakeNode("CheckpointLoaderSimple"),
            ["6"] = MakeNode("LoraLoaderModelOnly", "4")
        };
        Assert.That(H3AccelExtension.ModelChainReachesAny(workflow, new JArray("6", 0), ["5"]), Is.False);
    }

    /// <summary>A cyclic model chain (malformed workflow) terminates instead of looping forever, and reports no
    /// match.</summary>
    [Test]
    public void ModelChainReachesAny_Cycle_TerminatesAndReturnsFalse()
    {
        JObject workflow = new()
        {
            ["6"] = MakeNode("SomePatch", "7"),
            ["7"] = MakeNode("SomePatch", "6")
        };
        Assert.That(H3AccelExtension.ModelChainReachesAny(workflow, new JArray("6", 0), ["5"]), Is.False);
    }

    #endregion

    #region BuildMemoryNodeInputs (defaults)

    /// <summary>With the node's own defaults, the built inputs match H3MemoryOptimization's schema defaults
    /// exactly, including the three legacy/hidden slots this extension always pins.</summary>
    [Test]
    public void BuildMemoryNodeInputs_Defaults_MatchNodeSchema()
    {
        JObject inputs = H3AccelExtension.BuildMemoryNodeInputs(
            H3AccelExtension.MlpMemoryAuto,
            H3AccelExtension.QkvStreamingAuto,
            H3AccelExtension.AttentionModeStandard,
            H3AccelExtension.PrecisionModeAuto,
            4096);
        Assert.That(inputs["fused_qkv"].Value<string>(), Is.EqualTo("auto"));
        Assert.That(inputs["mlp_memory"].Value<string>(), Is.EqualTo("auto"));
        Assert.That(inputs["chunk_rows"].Value<int>(), Is.EqualTo(4096));
        Assert.That(inputs["preserve_precision"].Value<bool>(), Is.True);
        Assert.That(inputs["precision_mode"].Value<string>(), Is.EqualTo("Auto"));
        Assert.That(inputs["qkv_streaming_mode"].Value<string>(), Is.EqualTo("Auto"));
        Assert.That(inputs["embedding_memory_mode"].Value<string>(), Is.EqualTo("Auto"));
        Assert.That(inputs["kitchen_v_memory_mode"].Value<string>(), Is.EqualTo("Standard"));
    }

    /// <summary>Non-default choices for the three user-facing controls pass through untouched, while the
    /// legacy/hidden slots stay pinned regardless.</summary>
    [Test]
    public void BuildMemoryNodeInputs_NonDefaultChoices_PassThrough()
    {
        JObject inputs = H3AccelExtension.BuildMemoryNodeInputs(
            H3AccelExtension.MlpMemoryOff,
            H3AccelExtension.QkvStreamingForced,
            H3AccelExtension.AttentionModeLowerVram,
            H3AccelExtension.PrecisionModeForceQuant,
            512);
        Assert.That(inputs["mlp_memory"].Value<string>(), Is.EqualTo("off"));
        Assert.That(inputs["qkv_streaming_mode"].Value<string>(), Is.EqualTo("Forced"));
        Assert.That(inputs["kitchen_v_memory_mode"].Value<string>(), Is.EqualTo("Lower VRAM (slower)"));
        Assert.That(inputs["precision_mode"].Value<string>(), Is.EqualTo("Force quant"));
        Assert.That(inputs["chunk_rows"].Value<int>(), Is.EqualTo(512));
        Assert.That(inputs["fused_qkv"].Value<string>(), Is.EqualTo("auto"));
        Assert.That(inputs["preserve_precision"].Value<bool>(), Is.True);
        Assert.That(inputs["embedding_memory_mode"].Value<string>(), Is.EqualTo("Auto"));
    }

    #endregion

    #region BuildFbcNodeInputs (defaults: Custom mode, Safe's numbers, Temporal Guard on)

    /// <summary>This extension's default FirstBlockCache configuration is Custom mode carrying the Safe
    /// preset's numbers, with Temporal Guard on - the named Safe preset itself would silently ignore Temporal
    /// Guard, so Custom is the only mode that actually honors it.</summary>
    [Test]
    public void BuildFbcNodeInputs_Defaults_AreCustomModeWithSafeNumbersAndGuardOn()
    {
        JArray model = new("6", 0);
        JObject inputs = H3AccelExtension.BuildFbcNodeInputs(model, H3AccelExtension.FbcModeCustom, 0.08, 0.10, 0.95, 2, true);
        Assert.That(inputs["model"], Is.SameAs(model));
        Assert.That(inputs["mode"].Value<string>(), Is.EqualTo("Custom — manual values"));
        Assert.That(inputs["threshold"].Value<double>(), Is.EqualTo(0.08));
        Assert.That(inputs["start_percent"].Value<double>(), Is.EqualTo(0.10));
        Assert.That(inputs["end_percent"].Value<double>(), Is.EqualTo(0.95));
        Assert.That(inputs["max_consecutive_hits"].Value<int>(), Is.EqualTo(2));
        Assert.That(inputs["temporal_guard"].Value<bool>(), Is.True);
    }

    #endregion

    #region ShouldSkipFbc (exclusion + warning reason)

    /// <summary>Nothing conflicting active: FirstBlockCache is not skipped, and no reason is produced.</summary>
    [Test]
    public void ShouldSkipFbc_NothingActive_ReturnsFalseWithNoReason()
    {
        bool skip = H3AccelExtension.ShouldSkipFbc("disabled", "disabled", false, out string reason);
        Assert.That(skip, Is.False);
        Assert.That(reason, Is.Null);
    }

    /// <summary>An active TeaCache mode skips FirstBlockCache and names TeaCache in the reason.</summary>
    [Test]
    public void ShouldSkipFbc_TeaCacheActive_ReturnsTrueAndNamesTeaCache()
    {
        bool skip = H3AccelExtension.ShouldSkipFbc("all", "disabled", false, out string reason);
        Assert.That(skip, Is.True);
        Assert.That(reason, Does.Contain("TeaCache"));
    }

    /// <summary>An active EasyCache mode skips FirstBlockCache and names EasyCache in the reason.</summary>
    [Test]
    public void ShouldSkipFbc_EasyCacheActive_ReturnsTrueAndNamesEasyCache()
    {
        bool skip = H3AccelExtension.ShouldSkipFbc("disabled", "video only", false, out string reason);
        Assert.That(skip, Is.True);
        Assert.That(reason, Does.Contain("EasyCache"));
    }

    /// <summary>Active Spectrum forecasting skips FirstBlockCache and names Spectrum in the reason.</summary>
    [Test]
    public void ShouldSkipFbc_SpectrumActive_ReturnsTrueAndNamesSpectrum()
    {
        bool skip = H3AccelExtension.ShouldSkipFbc("disabled", "disabled", true, out string reason);
        Assert.That(skip, Is.True);
        Assert.That(reason, Does.Contain("Spectrum"));
    }

    /// <summary>All three active at once still skips exactly once, and the reason names all three.</summary>
    [Test]
    public void ShouldSkipFbc_AllThreeActive_NamesAllThree()
    {
        bool skip = H3AccelExtension.ShouldSkipFbc("all", "all", true, out string reason);
        Assert.That(skip, Is.True);
        Assert.That(reason, Does.Contain("TeaCache"));
        Assert.That(reason, Does.Contain("EasyCache"));
        Assert.That(reason, Does.Contain("Spectrum"));
    }

    #endregion
}
