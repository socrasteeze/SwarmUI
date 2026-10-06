using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using NUnit.Framework;
using SwarmUI.Accounts;
using SwarmUI.Builtin_GridGeneratorExtension;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.WebAPI;

namespace SwarmUITests;

/// <summary>Preset grid axis: short labels, unknown-title skip, and param_map merge onto the current input.</summary>
[TestFixture]
[NonParallelizable]
public class GridPresetAxisTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
        if (!T2IParamTypes.TryGetType("steps", out _, null))
        {
            T2IParamTypes.RegisterDefaults();
        }
        if (!T2IParamTypes.TryGetType("sampler", out _, null))
        {
            T2IParamTypes.Register<string>(new("Sampler", "Sampler type.", "", ValidateValues: false));
        }
        if (!T2IParamTypes.TryGetType("scheduler", out _, null))
        {
            T2IParamTypes.Register<string>(new("Scheduler", "Scheduler type.", "", ValidateValues: false));
        }
    }

    /// <summary>The axis id Simple sends is the cleaned name of the shared grid preset parameter.</summary>
    [Test]
    public static void TestPresetAxisIdMatchesParameterName()
    {
        Assert.That(T2IParamTypes.CleanTypeName("[Grid Gen] Presets"), Is.EqualTo(GridGeneratorExtension.PresetAxisId));
    }

    /// <summary>A folder title labels the cell with the last segment. A comma-joined cell stays whole.</summary>
    [Test]
    public static void TestShortPresetTitle()
    {
        Assert.That(GridGenCore.ShortPresetTitle("anima/TrattoNero-niTratto_steeze"), Is.EqualTo("TrattoNero-niTratto_steeze"));
        Assert.That(GridGenCore.ShortPresetTitle("anima/TrattoNero-orenz_steeze"), Is.EqualTo("TrattoNero-orenz_steeze"));
        Assert.That(GridGenCore.ShortPresetTitle("anima/TrattoNero-niTratto_steeze_cfg35"), Is.EqualTo("TrattoNero-niTratto_steeze_cfg35"));
        Assert.That(GridGenCore.ShortPresetTitle("anima/TrattoNero-orenz_steeze_cfg35"), Is.EqualTo("TrattoNero-orenz_steeze_cfg35"));
        Assert.That(GridGenCore.ShortPresetTitle("plain"), Is.EqualTo("plain"));
        Assert.That(GridGenCore.ShortPresetTitle("folder/a, folder/b"), Is.EqualTo("folder/a, folder/b"));
        Assert.That(GridGenCore.ShortPresetTitle("folder/"), Is.EqualTo("folder/"));
    }

    /// <summary>An unknown title fails that cell and names the title as written. The other titles are not applied.</summary>
    [Test]
    public static void TestUnknownPresetSkipsTheCell()
    {
        List<T2IPreset> presets =
        [
            new() { Title = "anima/TrattoNero-niTratto_steeze" },
            new() { Title = "anima/TrattoNero-orenz_steeze" }
        ];
        bool found = GridGeneratorExtension.TryResolvePresetCell(presets, "anima/missing", out List<T2IPreset> matches, out string missing);
        Assert.That(found, Is.False);
        Assert.That(missing, Is.EqualTo("anima/missing"));
        Assert.That(matches, Is.Empty);

        bool mixed = GridGeneratorExtension.TryResolvePresetCell(presets, "anima/TrattoNero-niTratto_steeze, anima/missing", out List<T2IPreset> partial, out string secondMissing);
        Assert.That(mixed, Is.False);
        Assert.That(secondMissing, Is.EqualTo("anima/missing"));
        Assert.That(partial, Is.Empty);

        bool known = GridGeneratorExtension.TryResolvePresetCell(presets, "ANIMA/TrattoNero-orenz_steeze", out List<T2IPreset> one, out string none);
        Assert.That(known, Is.True);
        Assert.That(none, Is.Null);
        Assert.That(one, Has.Count.EqualTo(1));
        Assert.That(one[0].Title, Is.EqualTo("anima/TrattoNero-orenz_steeze"));
    }

    /// <summary>A preset's param_map replaces conflicting Create-tab fields. {value} is that same prompt on every cell.</summary>
    [Test]
    public static void TestPresetMapWinsAndKeepsPromptValue()
    {
        T2IModelHandler handler = new() { ModelType = "Stable-Diffusion" };
        T2IModel baseModel = new(handler, "models", "models\\other.safetensors", "other/ckpt");
        T2IModel presetModel = new(handler, "models", "models\\anima.safetensors", "anima/base");
        handler.Models[baseModel.Name] = baseModel;
        handler.Models[presetModel.Name] = presetModel;
        T2IModelHandler loraHandler = new() { ModelType = "LoRA" };
        foreach (string name in new string[] { "old/one", "style/a", "style/b", "style/c" })
        {
            T2IModel lora = new(loraHandler, "loras", $"loras\\{name.Replace('/', '_')}.safetensors", name);
            loraHandler.Models[name] = lora;
        }
        bool had = Program.T2IModelSets.TryGetValue("Stable-Diffusion", out T2IModelHandler saved);
        bool hadLora = Program.T2IModelSets.TryGetValue("LoRA", out T2IModelHandler savedLora);
        Program.T2IModelSets["Stable-Diffusion"] = handler;
        Program.T2IModelSets["LoRA"] = loraHandler;
        // ListModelNamesFor also asks extra providers. The built-in remote provider throws when no backends
        // are loaded, and an empty provider list then crashes Aggregate. A local empty provider keeps the list usable.
        ModelsAPI.ExtraModelProviders["grid-preset-test"] = _ => [];
        bool savedHash = Program.ServerSettings.Metadata.ImageMetadataIncludeModelHash;
        Program.ServerSettings.Metadata.ImageMetadataIncludeModelHash = false;
        try
        {
            T2IParamInput first = BaseInput();
            Preset("anima/TrattoNero-niTratto_steeze", "{value}, cinematic", "8", "3.5", "er_sde", "beta", "style/a, style/b", "0.5, 0.8", "anima/base").ApplyTo(first);
            AssertMerged(first, "a cat, cinematic", 8, 3.5, "er_sde", "beta", "style/a,style/b", "0.5,0.8", "anima/base");
            Assert.That(first.Get(T2IParamTypes.Seed), Is.EqualTo(42), "a field the preset does not set stays from the Create tab");

            T2IParamInput second = BaseInput();
            Preset("anima/TrattoNero-orenz_steeze", "{value}, flat", "4", "1", "euler", "normal", "style/c", "1", "other/ckpt").ApplyTo(second);
            Assert.That(second.Get(T2IParamTypes.Prompt), Is.EqualTo("a cat, flat"), "the same Create-tab prompt is {value} on the next cell");
            Assert.That(second.Get(T2IParamTypes.Model).Name, Is.EqualTo("other/ckpt"));
        }
        finally
        {
            Program.ServerSettings.Metadata.ImageMetadataIncludeModelHash = savedHash;
            if (had)
            {
                Program.T2IModelSets["Stable-Diffusion"] = saved;
            }
            else
            {
                Program.T2IModelSets.Remove("Stable-Diffusion");
            }
            if (hadLora)
            {
                Program.T2IModelSets["LoRA"] = savedLora;
            }
            else
            {
                Program.T2IModelSets.Remove("LoRA");
            }
            ModelsAPI.ExtraModelProviders.TryRemove("grid-preset-test", out _);
        }
    }

    /// <summary>Create-tab state the preset is applied onto.</summary>
    static T2IParamInput BaseInput()
    {
        Role role = new("grid-preset-test");
        role.Data.PermissionFlags.Add("*");
        User user = RuntimeHelpers.GetUninitializedObject(typeof(User)) as User;
        user.CalculatedRole = role;
        T2IParamInput input = new(null);
        input.SourceSession = new Session() { User = user };
        input.InternalSet.SourceSession = input.SourceSession;
        T2IParamTypes.ApplyParameter("prompt", "a cat", input);
        T2IParamTypes.ApplyParameter("negativeprompt", "blurry", input);
        T2IParamTypes.ApplyParameter("steps", "30", input);
        T2IParamTypes.ApplyParameter("cfgscale", "7", input);
        T2IParamTypes.ApplyParameter("sampler", "euler", input);
        T2IParamTypes.ApplyParameter("scheduler", "karras", input);
        T2IParamTypes.ApplyParameter("seed", "42", input);
        T2IParamTypes.ApplyParameter("loras", "old/one", input);
        T2IParamTypes.ApplyParameter("loraweights", "1", input);
        T2IParamTypes.ApplyParameter("model", "other/ckpt", input);
        return input;
    }

    /// <summary>One preset whose param_map carries the fields a grid cell must merge.</summary>
    static T2IPreset Preset(string title, string prompt, string steps, string cfg, string sampler, string scheduler, string loras, string weights, string model)
    {
        return new T2IPreset()
        {
            Title = title,
            ParamMap = new Dictionary<string, string>()
            {
                ["prompt"] = prompt,
                ["negativeprompt"] = "{value}, text",
                ["steps"] = steps,
                ["cfgscale"] = cfg,
                ["sampler"] = sampler,
                ["scheduler"] = scheduler,
                ["loras"] = loras,
                ["loraweights"] = weights,
                ["model"] = model
            }
        };
    }

    /// <summary>The preset's values replaced the Create-tab values.</summary>
    static void AssertMerged(T2IParamInput input, string prompt, int steps, double cfg, string sampler, string scheduler, string loras, string weights, string model)
    {
        Assert.That(input.Get(T2IParamTypes.Prompt), Is.EqualTo(prompt));
        Assert.That(input.Get(T2IParamTypes.NegativePrompt), Is.EqualTo("blurry, text"));
        Assert.That(input.Get(T2IParamTypes.Steps), Is.EqualTo(steps));
        AssertAreRoughlyEqual(cfg, input.Get(T2IParamTypes.CFGScale), "cfg");
        Assert.That(Raw(input, "sampler"), Is.EqualTo(sampler));
        Assert.That(Raw(input, "scheduler"), Is.EqualTo(scheduler));
        Assert.That(string.Join(",", input.Get(T2IParamTypes.Loras)), Is.EqualTo(loras));
        Assert.That(string.Join(",", input.Get(T2IParamTypes.LoraWeights)), Is.EqualTo(weights));
        Assert.That(input.Get(T2IParamTypes.Model).Name, Is.EqualTo(model));
    }

    /// <summary>String form of a param stored by id.</summary>
    static string Raw(T2IParamInput input, string id)
    {
        T2IParamType type = T2IParamTypes.GetType(id, input);
        Assert.That(input.TryGetRaw(type, out object value), Is.True, id);
        return $"{value}";
    }
}
