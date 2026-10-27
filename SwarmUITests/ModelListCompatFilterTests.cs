using System.Collections.Generic;
using NUnit.Framework;
using SwarmUI.WebAPI;

namespace SwarmUITests;

/// <summary>The compat-class filter <see cref="ModelsAPI.ListModels"/> applies to sub-model listings, as implemented by <see cref="ModelListWindow"/>.
/// All names and class IDs here are invented.</summary>
[TestFixture]
public class ModelListCompatFilterTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>The list is trimmed, split on commas, de-duplicated in order, and blank parts are dropped.</summary>
    [Test]
    public static void TestParseCompatList_TrimDedupeAndBlank()
    {
        Assert.That(ModelListWindow.ParseCompatList(" fam-a , fam-b,,fam-a,  "), Is.EqualTo(new[] { "fam-a", "fam-b" }));
        Assert.That(ModelListWindow.ParseCompatList(""), Is.Empty);
        Assert.That(ModelListWindow.ParseCompatList("   "), Is.Empty);
        Assert.That(ModelListWindow.ParseCompatList(null), Is.Empty);
    }

    /// <summary>The filter does nothing for Wildcards, Stable-Diffusion, or an empty class list.</summary>
    [Test]
    public static void TestCompatFilterApplies()
    {
        Assert.That(ModelListWindow.CompatFilterApplies("LoRA", new[] { "fam-a" }), Is.True);
        Assert.That(ModelListWindow.CompatFilterApplies("VAE", new[] { "fam-a" }), Is.True);
        Assert.That(ModelListWindow.CompatFilterApplies("LoRA", new string[0]), Is.False);
        Assert.That(ModelListWindow.CompatFilterApplies("LoRA", null), Is.False);
        Assert.That(ModelListWindow.CompatFilterApplies("Wildcards", new[] { "fam-a" }), Is.False);
        Assert.That(ModelListWindow.CompatFilterApplies("Stable-Diffusion", new[] { "fam-a" }), Is.False);
    }

    /// <summary>Without an exception, a sub-model matches only its own compat class.</summary>
    [Test]
    public static void TestCompatMatches_Equality()
    {
        Assert.That(ModelListWindow.CompatMatches("LoRA", "fam-a/lora", "fam-a", new[] { "fam-a" }), Is.True);
        Assert.That(ModelListWindow.CompatMatches("LoRA", "fam-a/lora", "fam-a", new[] { "fam-b" }), Is.False);
        Assert.That(ModelListWindow.CompatMatches("LoRA", "fam-a/lora", "fam-a", new[] { "fam-a-large" }), Is.False, "equality, not a prefix");
    }

    /// <summary>With several active classes, one match is enough.</summary>
    [Test]
    public static void TestCompatMatches_AnyOfActive()
    {
        Assert.That(ModelListWindow.CompatMatches("LoRA", "fam-a/lora", "fam-a", new[] { "fam-b", "fam-a" }), Is.True);
        Assert.That(ModelListWindow.CompatMatches("LoRA", "fam-a/lora", "fam-a", new[] { "fam-b", "fam-c" }), Is.False);
    }

    /// <summary>No active class, only blank active classes, no model class, or a Stable-Diffusion row all match.</summary>
    [Test]
    public static void TestCompatMatches_EmptyInputsMatch()
    {
        Assert.That(ModelListWindow.CompatMatches("LoRA", "fam-a/lora", "fam-a", new string[0]), Is.True);
        Assert.That(ModelListWindow.CompatMatches("LoRA", "fam-a/lora", "fam-a", null), Is.True);
        Assert.That(ModelListWindow.CompatMatches("LoRA", "fam-a/lora", "fam-a", new[] { "", null }), Is.True);
        Assert.That(ModelListWindow.CompatMatches("LoRA", "fam-a/lora", "", new[] { "fam-b" }), Is.True);
        Assert.That(ModelListWindow.CompatMatches("LoRA", "fam-a/lora", null, new[] { "fam-b" }), Is.True);
        Assert.That(ModelListWindow.CompatMatches("Stable-Diffusion", "fam-a", "fam-a", new[] { "fam-b" }), Is.True);
    }

    /// <summary>VAEs of the SD3 family mix. A flux-1 VAE loads under hidream-i1. A flux-1 LoRA loads under chroma. Each allowance is one-way and type-specific.</summary>
    [Test]
    public static void TestCompatMatches_ThreeExceptions()
    {
        Assert.That(ModelListWindow.CompatMatches("VAE", "stable-diffusion-v3-medium/vae", "stable-diffusion-v3-medium", new[] { "stable-diffusion-v3-large" }), Is.True);
        Assert.That(ModelListWindow.CompatMatches("VAE", "stable-diffusion-v3-medium/vae", "stable-diffusion-v3-medium", new[] { "fam-b" }), Is.False);
        Assert.That(ModelListWindow.CompatMatches("LoRA", "stable-diffusion-v3-medium/lora", "stable-diffusion-v3-medium", new[] { "stable-diffusion-v3-large" }), Is.False, "SD3 mixing is for VAEs only");

        Assert.That(ModelListWindow.CompatMatches("VAE", "flux-1/vae", "flux-1", new[] { "hidream-i1-full" }), Is.True);
        Assert.That(ModelListWindow.CompatMatches("VAE", "flux-1/vae", "flux-1", new[] { "chroma" }), Is.False);
        Assert.That(ModelListWindow.CompatMatches("LoRA", "flux-1/lora", "flux-1", new[] { "hidream-i1-full" }), Is.False, "hidream allowance is for VAEs only");

        Assert.That(ModelListWindow.CompatMatches("LoRA", "flux-1/lora", "flux-1", new[] { "chroma" }), Is.True);
        Assert.That(ModelListWindow.CompatMatches("LoRA", "chroma/lora", "chroma", new[] { "flux-1" }), Is.False, "the allowance is one-way");
        Assert.That(ModelListWindow.CompatMatches("VAE", "flux-1/vae", "flux-1", new[] { "chroma" }), Is.False, "chroma allowance is for LoRAs only");
    }

    /// <summary>An architecture with no '/' is a sub-model of its subtype, not a base model that matches everything.</summary>
    [Test]
    public static void TestCompatMatches_NoSlashIsSubModelOfSubtype()
    {
        Assert.That(ModelListWindow.CompatMatches("LoRA", "fam-a", "fam-a", new[] { "fam-b" }), Is.False);
        Assert.That(ModelListWindow.CompatMatches("LoRA", "", "fam-a", new[] { "fam-b" }), Is.False);
        Assert.That(ModelListWindow.CompatMatches("LoRA", null, "fam-a", new[] { "fam-a" }), Is.True);
        Assert.That(ModelListWindow.CompatMatches("LoRA", "flux-1", "flux-1", new[] { "chroma" }), Is.True, "no slash on a LoRA reads as x/lora");
        Assert.That(ModelListWindow.CompatMatches("VAE", "flux-1", "flux-1", new[] { "hidream-i1-full" }), Is.True, "no slash on a VAE reads as x/vae");
        Assert.That(ModelListWindow.CompatMatches("VAE", "flux-1", "flux-1", new[] { "chroma" }), Is.False);
        Assert.That(ModelListWindow.CompatMatches("ControlNet", "flux-1", "flux-1", new[] { "chroma" }), Is.False, "no slash on a ControlNet reads as x/controlnet");
        Assert.That(ModelListWindow.CompatMatches("ControlNet", "flux-1", "flux-1", new[] { "flux-1" }), Is.True);
    }

    /// <summary>Classed rows are judged by their class. Rows from other classes are removed and counted.</summary>
    [Test]
    public static void TestFilterByCompat_ClassedRows()
    {
        List<ModelListCandidate> rows = new()
        {
            Cand("a-one.safetensors", "fam-a", "fam-a/lora"),
            Cand("b-one.safetensors", "fam-b", "fam-b/lora"),
            Cand("c-one.safetensors", "fam-c", "fam-c/lora")
        };
        ModelListCompatResult one = ModelListWindow.FilterByCompat(rows, new[] { "fam-a" }, "LoRA", null);
        Assert.That(Names(one.Kept), Is.EqualTo(new[] { "a-one.safetensors" }));
        Assert.That(one.Hidden, Is.EqualTo(2));
        ModelListCompatResult two = ModelListWindow.FilterByCompat(rows, new[] { "fam-a", "fam-c" }, "LoRA", null);
        Assert.That(Names(two.Kept), Is.EqualTo(new[] { "a-one.safetensors", "c-one.safetensors" }), "original order is kept");
        Assert.That(two.Hidden, Is.EqualTo(1));
    }

    /// <summary>An unclassed row in a folder whose classed models are all inactive is hidden. If one of them is active, or the folder is unknown, it stays.</summary>
    [Test]
    public static void TestFilterByCompat_UnclassedUsesFolderEvidence()
    {
        Dictionary<string, HashSet<string>> evidence = new();
        ModelListWindow.AddFolderEvidence(evidence, "fam-a/seen-1.safetensors", "fam-a");
        ModelListWindow.AddFolderEvidence(evidence, "mixed/seen-1.safetensors", "fam-a");
        ModelListWindow.AddFolderEvidence(evidence, "mixed/seen-2.safetensors", "fam-b");
        List<ModelListCandidate> rows = new()
        {
            Cand("fam-a/stub.safetensors", "", ""),
            Cand("mixed/stub.safetensors", "", ""),
            Cand("elsewhere/stub.safetensors", "", ""),
            Cand("top-level-stub.safetensors", "", "")
        };
        ModelListCompatResult underB = ModelListWindow.FilterByCompat(rows, new[] { "fam-b" }, "LoRA", evidence);
        Assert.That(Names(underB.Kept), Is.EqualTo(new[] { "mixed/stub.safetensors", "elsewhere/stub.safetensors", "top-level-stub.safetensors" }),
            "fam-a/ has only fam-a evidence so it is hidden; mixed/ includes fam-b; an unseen folder and the top level are unknown");
        Assert.That(underB.Hidden, Is.EqualTo(1));
        ModelListCompatResult underA = ModelListWindow.FilterByCompat(rows, new[] { "fam-a" }, "LoRA", evidence);
        Assert.That(underA.Hidden, Is.EqualTo(0));
        ModelListCompatResult underC = ModelListWindow.FilterByCompat(rows, new[] { "fam-c" }, "LoRA", evidence);
        Assert.That(Names(underC.Kept), Is.EqualTo(new[] { "elsewhere/stub.safetensors", "top-level-stub.safetensors" }));
        Assert.That(underC.Hidden, Is.EqualTo(2));
        ModelListCompatResult noEvidence = ModelListWindow.FilterByCompat(rows, new[] { "fam-c" }, "LoRA", null);
        Assert.That(noEvidence.Hidden, Is.EqualTo(0), "no evidence is not incompatible");
    }

    /// <summary>A model's own class wins over folder evidence. A folder lookup ignores case, and a folder with no classed models adds no evidence.</summary>
    [Test]
    public static void TestFilterByCompat_OwnClassBeatsFolderAndCaseFolds()
    {
        Dictionary<string, HashSet<string>> evidence = new();
        ModelListWindow.AddFolderEvidence(evidence, "Fam-A/seen.safetensors", "fam-a");
        ModelListWindow.AddFolderEvidence(evidence, "empty/seen.safetensors", "");
        ModelListWindow.AddFolderEvidence(evidence, "no-folder.safetensors", "fam-a");
        Assert.That(evidence.Keys, Is.EquivalentTo(new[] { "fam-a" }));
        List<ModelListCandidate> rows = new()
        {
            Cand("FAM-A/classed-b.safetensors", "fam-b", "fam-b/lora"),
            Cand("fam-A/unclassed.safetensors", "", ""),
            Cand("empty/unclassed.safetensors", "", "")
        };
        ModelListCompatResult underB = ModelListWindow.FilterByCompat(rows, new[] { "fam-b" }, "LoRA", evidence);
        Assert.That(Names(underB.Kept), Is.EqualTo(new[] { "FAM-A/classed-b.safetensors", "empty/unclassed.safetensors" }));
        Assert.That(underB.Hidden, Is.EqualTo(1));
    }

    /// <summary>Wildcards, Stable-Diffusion, and an empty class list keep every row.</summary>
    [Test]
    public static void TestFilterByCompat_NotApplicableKeepsEverything()
    {
        List<ModelListCandidate> rows = new()
        {
            Cand("a.safetensors", "fam-a", "fam-a/lora"),
            Cand("b.safetensors", "fam-b", "fam-b/lora")
        };
        Assert.That(ModelListWindow.FilterByCompat(rows, new[] { "fam-a" }, "Wildcards", null).Hidden, Is.EqualTo(0));
        Assert.That(ModelListWindow.FilterByCompat(rows, new[] { "fam-a" }, "Stable-Diffusion", null).Hidden, Is.EqualTo(0));
        ModelListCompatResult empty = ModelListWindow.FilterByCompat(rows, new string[0], "LoRA", null);
        Assert.That(empty.Hidden, Is.EqualTo(0));
        Assert.That(empty.Kept.Count, Is.EqualTo(2));
    }

    /// <summary>The hidden count is the number removed, and paging after the filter totals and pages only the survivors, with no gaps or repeats.</summary>
    [Test]
    public static void TestFilterByCompat_HiddenCountAndPagingTotals()
    {
        List<ModelListCandidate> rows = new();
        for (int i = 0; i < 10; i++)
        {
            bool compatible = i % 5 != 0 && i != 7;
            rows.Add(Cand($"lora-{i:00}.safetensors", compatible ? "fam-a" : "fam-b", compatible ? "fam-a/lora" : "fam-b/lora"));
        }
        ModelListCompatResult filtered = ModelListWindow.FilterByCompat(rows, new[] { "fam-a" }, "LoRA", null);
        Assert.That(filtered.Hidden, Is.EqualTo(3));
        Assert.That(filtered.Kept.Count, Is.EqualTo(7));
        List<string> seen = new();
        for (int offset = 0; offset < 7; offset += 3)
        {
            ModelListPage page = ModelListWindow.Page(filtered.Kept, ModelsAPI.ModelHistorySortMode.Name, false, offset, 3, 100);
            Assert.That(page.Total, Is.EqualTo(7), "total is the post-filter count");
            Assert.That(page.Truncated, Is.True, "a window short of the whole set is truncated");
            seen.AddRange(Names(page.Rows));
        }
        Assert.That(seen, Is.EqualTo(new[]
        {
            "lora-01.safetensors", "lora-02.safetensors", "lora-03.safetensors", "lora-04.safetensors",
            "lora-06.safetensors", "lora-08.safetensors", "lora-09.safetensors"
        }));
        ModelListPage whole = ModelListWindow.Page(filtered.Kept, ModelsAPI.ModelHistorySortMode.Name, false, 0, 0, 100);
        Assert.That(whole.Total, Is.EqualTo(7));
        Assert.That(whole.Truncated, Is.False);
    }

    /// <summary>The first path segment is lowercased. A name with no folder has none.</summary>
    [Test]
    public static void TestRootFolderOf()
    {
        Assert.That(ModelListWindow.RootFolderOf("Fam-A/sub/file.safetensors"), Is.EqualTo("fam-a"));
        Assert.That(ModelListWindow.RootFolderOf("file.safetensors"), Is.EqualTo(""));
        Assert.That(ModelListWindow.RootFolderOf("/file.safetensors"), Is.EqualTo(""));
        Assert.That(ModelListWindow.RootFolderOf(null), Is.EqualTo(""));
    }

    /// <summary>One candidate. Title and trigger are empty.</summary>
    static ModelListCandidate Cand(string name, string compat, string architecture)
    {
        return new ModelListCandidate()
        {
            Name = name,
            Title = "",
            TriggerPhrase = "",
            CompatClass = compat,
            Architecture = architecture
        };
    }

    /// <summary>Names of the given rows, in order.</summary>
    static string[] Names(List<ModelListCandidate> rows)
    {
        string[] names = new string[rows.Count];
        for (int i = 0; i < rows.Count; i++)
        {
            names[i] = rows[i].Name;
        }
        return names;
    }
}
