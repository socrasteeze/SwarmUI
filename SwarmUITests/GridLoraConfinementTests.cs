using System;
using System.Collections.Generic;
using NUnit.Framework;
using SwarmUI.Builtin_GridGeneratorExtension;
using SwarmUI.Text2Image;

namespace SwarmUITests;

/// <summary>Grid LoRA axes stay index-aligned with the base LoRAs. A missing base confinement list means global (0).</summary>
[TestFixture]
[NonParallelizable]
public class GridLoraConfinementTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
        if (!T2IParamTypes.TryGetType("loras", out _, null))
        {
            T2IParamTypes.RegisterDefaults();
        }
    }

    /// <summary>Base EVEANI at 0.8 with no confinement, plus an axis LoRA confined to Base (5), keeps EVEANI global.</summary>
    [Test]
    public static void TestGlobalBaseStaysGlobalWhenAxisIsBaseOnly()
    {
        T2IParamInput input = Base("EVEANI");
        input.Set(T2IParamTypes.LoraWeights, new List<string>() { "0.8" });
        // Confinement is inserted first. Dictionary order must not decide which list is the base count.
        Dictionary<T2IParamType, List<string>> stack = [];
        stack[T2IParamTypes.LoraSectionConfinement.Type] = ["5"];
        stack[T2IParamTypes.Loras.Type] = ["style"];
        GridGeneratorExtension.ApplyCommaStackable(input, stack);
        Assert.That(Joined(input, T2IParamTypes.Loras), Is.EqualTo("EVEANI,style"));
        Assert.That(Joined(input, T2IParamTypes.LoraWeights), Is.EqualTo("0.8"));
        Assert.That(Joined(input, T2IParamTypes.LoraSectionConfinement), Is.EqualTo("0,5"));
    }

    /// <summary>An existing base confinement stays on the base LoRA when the axis confinement is global.</summary>
    [Test]
    public static void TestExistingConfinementStaysOnTheBaseLora()
    {
        T2IParamInput input = Base("EVEANI");
        input.Set(T2IParamTypes.LoraSectionConfinement, new List<string>() { "5" });
        Dictionary<T2IParamType, List<string>> stack = [];
        stack[T2IParamTypes.LoraSectionConfinement.Type] = ["0"];
        stack[T2IParamTypes.Loras.Type] = ["style"];
        GridGeneratorExtension.ApplyCommaStackable(input, stack);
        Assert.That(Joined(input, T2IParamTypes.LoraSectionConfinement), Is.EqualTo("5,0"));
    }

    /// <summary>No base LoRAs means the axis value is stored as given.</summary>
    [Test]
    public static void TestNoBaseLorasLeavesTheAxisValue()
    {
        T2IParamInput input = new(null);
        Dictionary<T2IParamType, List<string>> stack = [];
        stack[T2IParamTypes.LoraSectionConfinement.Type] = ["5"];
        stack[T2IParamTypes.Loras.Type] = ["style"];
        stack[T2IParamTypes.LoraWeights.Type] = ["0.4"];
        GridGeneratorExtension.ApplyCommaStackable(input, stack);
        Assert.That(Joined(input, T2IParamTypes.Loras), Is.EqualTo("style"));
        Assert.That(Joined(input, T2IParamTypes.LoraWeights), Is.EqualTo("0.4"));
        Assert.That(Joined(input, T2IParamTypes.LoraSectionConfinement), Is.EqualTo("5"));
    }

    /// <summary>A short base weight list is padded with 1 up to the base LoRA count, then the axis weight is appended.</summary>
    [Test]
    public static void TestShortWeightsPadWithOne()
    {
        T2IParamInput input = Base("EVEANI", "OTHER");
        input.Set(T2IParamTypes.LoraWeights, new List<string>() { "0.8" });
        Dictionary<T2IParamType, List<string>> stack = [];
        stack[T2IParamTypes.LoraWeights.Type] = ["0.4"];
        GridGeneratorExtension.ApplyCommaStackable(input, stack);
        Assert.That(Joined(input, T2IParamTypes.LoraWeights), Is.EqualTo("0.8,1,0.4"));
    }

    /// <summary>A short text-encoder weight list copies the base LoRA weight at each missing index, else 1.</summary>
    [Test]
    public static void TestShortTencPadsFromBaseWeight()
    {
        T2IParamInput matched = Base("EVEANI", "OTHER");
        matched.Set(T2IParamTypes.LoraWeights, new List<string>() { "0.8", "0.3" });
        Dictionary<T2IParamType, List<string>> matchedStack = [];
        matchedStack[T2IParamTypes.LoraTencWeights.Type] = ["0.2"];
        GridGeneratorExtension.ApplyCommaStackable(matched, matchedStack);
        Assert.That(Joined(matched, T2IParamTypes.LoraTencWeights), Is.EqualTo("0.8,0.3,0.2"));

        T2IParamInput shortWeights = Base("EVEANI", "OTHER");
        shortWeights.Set(T2IParamTypes.LoraWeights, new List<string>() { "0.8" });
        Dictionary<T2IParamType, List<string>> shortStack = [];
        shortStack[T2IParamTypes.LoraTencWeights.Type] = ["0.2"];
        GridGeneratorExtension.ApplyCommaStackable(shortWeights, shortStack);
        Assert.That(Joined(shortWeights, T2IParamTypes.LoraTencWeights), Is.EqualTo("0.8,1,0.2"));
    }

    /// <summary>A confinement value stored as a comma string is aligned the same way as a list.</summary>
    [Test]
    public static void TestStringConfinementAndStringLoraCount()
    {
        T2IParamInput input = Base("EVEANI");
        input.InternalSet.ValuesInput[T2IParamTypes.LoraSectionConfinement.Type.ID] = "5";
        Dictionary<T2IParamType, List<string>> stack = [];
        stack[T2IParamTypes.LoraSectionConfinement.Type] = ["0"];
        GridGeneratorExtension.ApplyCommaStackable(input, stack);
        Assert.That(Joined(input, T2IParamTypes.LoraSectionConfinement), Is.EqualTo("5,0"));

        T2IParamInput counted = new(null);
        counted.InternalSet.ValuesInput[T2IParamTypes.Loras.Type.ID] = "EVEANI,OTHER";
        Dictionary<T2IParamType, List<string>> countStack = [];
        countStack[T2IParamTypes.LoraSectionConfinement.Type] = ["5"];
        GridGeneratorExtension.ApplyCommaStackable(counted, countStack);
        Assert.That(Joined(counted, T2IParamTypes.LoraSectionConfinement), Is.EqualTo("0,0,5"));
    }

    /// <summary>Appending an axis LoRA without a confinement axis leaves the base confinement list alone.</summary>
    [Test]
    public static void TestNoConfinementAxisLeavesTheBaseList()
    {
        T2IParamInput confined = Base("EVEANI");
        confined.Set(T2IParamTypes.LoraSectionConfinement, new List<string>() { "5" });
        Dictionary<T2IParamType, List<string>> confinedStack = [];
        confinedStack[T2IParamTypes.Loras.Type] = ["style"];
        GridGeneratorExtension.ApplyCommaStackable(confined, confinedStack);
        Assert.That(Joined(confined, T2IParamTypes.Loras), Is.EqualTo("EVEANI,style"));
        Assert.That(Joined(confined, T2IParamTypes.LoraSectionConfinement), Is.EqualTo("5"));

        T2IParamInput global = Base("EVEANI");
        global.Set(T2IParamTypes.LoraWeights, new List<string>() { "0.8" });
        Dictionary<T2IParamType, List<string>> globalStack = [];
        globalStack[T2IParamTypes.Loras.Type] = ["style"];
        GridGeneratorExtension.ApplyCommaStackable(global, globalStack);
        Assert.That(global.TryGet(T2IParamTypes.LoraSectionConfinement, out List<string> _), Is.False);
        Assert.That(Joined(global, T2IParamTypes.LoraWeights), Is.EqualTo("0.8"));
    }

    /// <summary>A non-LoRA stackable value is still a plain join, with no LoRA padding.</summary>
    [Test]
    public static void TestNonLoraStackableStaysAPlainJoin()
    {
        T2IParamInput input = new(null);
        input.Set(T2IParamTypes.Prompt, "hello");
        Dictionary<T2IParamType, List<string>> stack = [];
        stack[T2IParamTypes.Prompt.Type] = ["world"];
        GridGeneratorExtension.ApplyCommaStackable(input, stack);
        Assert.That(input.Get(T2IParamTypes.Prompt), Is.EqualTo("hello,world"));
    }

    /// <summary>The pure aligner pads up to the base count, appends the axis, and does not truncate a longer list.</summary>
    [Test]
    public static void TestAlignStackedLoraList()
    {
        Assert.That(string.Join(",", GridGeneratorExtension.AlignStackedLoraList(null, 1, _ => "0", ["5"])), Is.EqualTo("0,5"));
        Assert.That(string.Join(",", GridGeneratorExtension.AlignStackedLoraList(["5"], 1, _ => "0", ["0"])), Is.EqualTo("5,0"));
        Assert.That(string.Join(",", GridGeneratorExtension.AlignStackedLoraList(null, 0, _ => "0", ["5"])), Is.EqualTo("5"));
        Assert.That(string.Join(",", GridGeneratorExtension.AlignStackedLoraList(["0.8"], 2, _ => "1", ["0.4"])), Is.EqualTo("0.8,1,0.4"));
        Assert.That(string.Join(",", GridGeneratorExtension.AlignStackedLoraList(null, 2, index => index == 0 ? "0.8" : "1", ["0.2"])), Is.EqualTo("0.8,1,0.2"));
        Assert.That(string.Join(",", GridGeneratorExtension.AlignStackedLoraList(["5", "9"], 1, _ => "0", ["0"])), Is.EqualTo("5,9,0"));
    }

    /// <summary>One cell input whose base LoRAs are <paramref name="names"/>.</summary>
    static T2IParamInput Base(params string[] names)
    {
        T2IParamInput input = new(null);
        input.Set(T2IParamTypes.Loras, new List<string>(names));
        return input;
    }

    /// <summary>Comma form of a list param that must be present.</summary>
    static string Joined(T2IParamInput input, T2IRegisteredParam<List<string>> param)
    {
        Assert.That(input.TryGet(param, out List<string> values), Is.True, param.Type.ID);
        return string.Join(",", values);
    }
}
