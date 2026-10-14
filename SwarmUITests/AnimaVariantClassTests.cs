using Newtonsoft.Json.Linq;
using NUnit.Framework;
using SwarmUI.Text2Image;

namespace SwarmUITests;

/// <summary>Anima base, 2.9B, and 3.8B class detection from tensor keys and architecture headers.</summary>
[TestFixture]
public class AnimaVariantClassTests : SwarmUITest
{
    /// <summary>Prepares the class sorter once.</summary>
    [OneTimeSetUp]
    public void PreInit()
    {
        Setup();
        if (!T2IModelClassSorter.ModelClasses.ContainsKey("anima-2.9b"))
        {
            T2IModelClassSorter.Init();
        }
    }

    /// <summary>A 28-block checkpoint stays base Anima.</summary>
    [Test]
    public void Checkpoint_BaseBlock27_IsAnima()
    {
        AssertClass("anima", "Stable-Diffusion", null, AnimaKeys());
    }

    /// <summary>Block 39 without block 51 is 2.9B, and it is not also claimed as Cosmos Predict2.</summary>
    [Test]
    public void Checkpoint_Block39_Is29B()
    {
        string[] keys = AnimaKeys("blocks.39.adaln_modulation_cross_attn.2.weight",
            "net.blocks.0.adaln_modulation_cross_attn.1.weight",
            "net.pos_embedder.dim_temporal_range",
            "net.x_embedder.proj.1.weight",
            "net.blocks.35.adaln_modulation_mlp.2.weight");
        AssertClass("anima-2.9b", "Stable-Diffusion", null, keys);
    }

    /// <summary>Block 51 wins over block 39.</summary>
    [Test]
    public void Checkpoint_Block51_Is38B()
    {
        AssertClass("anima-3.8b", "Stable-Diffusion", null, AnimaKeys(
            "blocks.39.adaln_modulation_cross_attn.2.weight",
            "blocks.51.adaln_modulation_cross_attn.2.weight"));
    }

    /// <summary>A bundled Semantic Connector marks a checkpoint 3.8B even without a separate block-51 probe.</summary>
    [Test]
    public void Checkpoint_Connector_Is38B()
    {
        AssertClass("anima-3.8b", "Stable-Diffusion", null, AnimaKeys("net.anima_v2_connector.resampler.0.weight"));
    }

    /// <summary>A generic anima-preview header loses to 2.9B keys.</summary>
    [Test]
    public void Checkpoint_PreviewHeader_KeysWin()
    {
        AssertClass("anima-2.9b", "Stable-Diffusion", "anima-preview", AnimaKeys("blocks.39.adaln_modulation_cross_attn.2.weight"));
    }

    /// <summary>A named 2.9B architecture alias resolves without tensor keys.</summary>
    [Test]
    public void Checkpoint_Alias29_Resolves()
    {
        AssertClass("anima-2.9b", "Stable-Diffusion", "anima_2.9b");
        AssertClass("anima-2.9b", "Stable-Diffusion", "anima-29b");
        AssertClass("anima-2.9b", "Stable-Diffusion", "Anima-2.9B");
    }

    /// <summary>A named 3.8B architecture alias resolves without tensor keys.</summary>
    [Test]
    public void Checkpoint_Alias38_Resolves()
    {
        AssertClass("anima-3.8b", "Stable-Diffusion", "anima-38b");
        AssertClass("anima-3.8b", "Stable-Diffusion", "anima_3.8b");
    }

    /// <summary>Base LoRA still requires the block-27 pair and ignores other families' block modules.</summary>
    [Test]
    public void Lora_Block27_IsBase()
    {
        AssertClass("anima/lora", "LoRA", null,
            "blocks.27.self_attn.v_proj.lora_A.weight",
            "blocks.27.adaln_modulation_cross_attn.1.lora_A.weight",
            "lora_unet_transformer_blocks_39_attn.lora_down.weight");
    }

    /// <summary>A remapped 2.9B LoRA can name only blocks 28-39, in either key spelling.</summary>
    [Test]
    public void Lora_Blocks28To39_Is29B_WithoutBlock27()
    {
        AssertClass("anima-2.9b/lora", "LoRA", null, "lora_unet_blocks_32_mlp_layer2.lora_down.weight");
        AssertClass("anima-2.9b/lora", "LoRA", null, "blocks.30.self_attn.v_proj.lora_A.weight");
        AssertClass("anima-2.9b/lora", "LoRA", null, "blocks.31.self_attn.q_proj.lora_A.weight");
        AssertClass("anima-2.9b/lora", "LoRA", null, "lora_unet_blocks_33_cross_attn_k_proj.lora_down.weight");
        AssertClass("anima-2.9b/lora", "LoRA", null, "blocks.34.mlp.layer1.lora_A.weight");
        AssertClass("anima-2.9b/lora", "LoRA", null, "lora_unet_blocks_35_adaln_modulation_self_attn_1.lora_down.weight");
    }

    /// <summary>A sparse block index only selects Anima when the key names an Anima DiT module.</summary>
    [Test]
    public void Lora_SparseForeignBlockKey_IsNotAnima()
    {
        AssertClass(null, "LoRA", null, "blocks.32.self_attn.q.lora_A.weight");
        AssertClass(null, "LoRA", null, "llm_adapter.blocks.39.self_attn.v_proj.lora_A.weight");
        AssertClass(null, "LoRA", null, "blocks.32.self_attn.v_projection.lora_A.weight");
        AssertClass(null, "LoRA", null, "lora_unet_blocks_32_mlp_layer12.lora_down.weight");
    }

    /// <summary>Block 40 or higher is 3.8B, including when block 39 is also present.</summary>
    [Test]
    public void Lora_Block40OrHigher_Is38B()
    {
        AssertClass("anima-3.8b/lora", "LoRA", null, "lora_unet_blocks_47_self_attn_v_proj.lora_down.weight");
        AssertClass("anima-3.8b/lora", "LoRA", "anima/lora",
            "blocks.39.self_attn.v_proj.lora_A.weight",
            "blocks.51.self_attn.v_proj.lora_A.weight");
    }

    /// <summary>A generic LoRA header loses to depth keys. A specific variant header is kept.</summary>
    [Test]
    public void Lora_GenericHeaderLoses_SpecificHeaderStays()
    {
        AssertClass("anima-2.9b/lora", "LoRA", "anima-preview/lora", "lora_unet_blocks_28_mlp_layer2.lora_up.weight");
        AssertClass("anima-2.9b/lora", "LoRA", "anima-29b/lora");
    }

    /// <summary>LLLite block index selects the ControlNet class.</summary>
    [Test]
    public void ControlNet_LlliteBlock_SelectsDepth()
    {
        AssertClass("anima/controlnet", "ControlNet", null,
            "lllite_dit_blocks_0_self_attn_q_proj.depth_embed",
            "lllite_dit_blocks_0_self_attn_q_proj.cond_to_film.weight",
            "lllite_dit_blocks_27_self_attn_q_proj.up.weight");
        AssertClass("anima-2.9b/controlnet", "ControlNet", null, "lllite_dit_blocks_39_self_attn_q_proj.up.weight");
        AssertClass("anima-3.8b/controlnet", "ControlNet", "anima/controlnet", "lllite_dit_blocks_51_self_attn_q_proj.up.weight");
    }

    /// <summary>Civitai BaseModel labels for the depth variants map onto the new LoRA classes.</summary>
    [Test]
    public void CivitaiBaseModel_Variants_MapToLoraClass()
    {
        Assert.That(T2ICivitaiBaseModelMap.TryGetLoraClass("Anima 2.9B")?.ID, Is.EqualTo("anima-2.9b/lora"));
        Assert.That(T2ICivitaiBaseModelMap.TryGetLoraClass("Anima-3.8B")?.ID, Is.EqualTo("anima-3.8b/lora"));
        Assert.That(T2ICivitaiBaseModelMap.TryGetLoraClass("Anima")?.ID, Is.EqualTo("anima/lora"));
    }

    /// <summary>A precise Anima BaseModel refines only generic Anima architecture metadata.</summary>
    [Test]
    public void CivitaiBaseModel_Variant_RefinesGenericAnimaArchitecture()
    {
        AssertClassWithBaseModel("anima-2.9b/lora", "anima/lora", "Anima 2.9B", "blocks.5.self_attn.v_proj.lora_A.weight");
        AssertClassWithBaseModel("anima-2.9b/lora", "anima-preview/lora", "Anima 2.9B", "blocks.5.self_attn.v_proj.lora_A.weight");
        AssertClassWithBaseModel("anima-3.8b/lora", "anima/lora", "Anima 3.8B", "blocks.5.self_attn.q_proj.lora_A.weight");
        AssertClassWithBaseModel("anima-2.9b/lora", "anima-2.9b/lora", "Anima 3.8B");
        AssertClassWithBaseModel("krea-2/lora", "krea-2/lora", "Anima 2.9B");
    }

    /// <summary>Builds the three tensors every Anima checkpoint shares, plus any extra names.</summary>
    private static string[] AnimaKeys(params string[] extra)
    {
        string[] core =
        [
            "t_embedder.1.linear_2.weight",
            "llm_adapter.blocks.0.self_attn.v_proj.weight",
            "blocks.27.adaln_modulation_cross_attn.2.weight"
        ];
        string[] all = new string[core.Length + extra.Length];
        core.CopyTo(all, 0);
        extra.CopyTo(all, core.Length);
        return all;
    }

    /// <summary>Classifies a synthetic header and asserts the architecture id.</summary>
    private static void AssertClass(string expectedId, string modelType, string architecture, params string[] keys)
    {
        JObject header = new();
        if (architecture is not null)
        {
            header["__metadata__"] = new JObject()
            {
                ["modelspec.architecture"] = architecture
            };
        }
        foreach (string key in keys)
        {
            header[key] = new JObject();
        }
        T2IModel model = new(null, "", "model.safetensors", "model");
        T2IModelClass clazz = T2IModelClassSorter.IdentifyClassFor(model, header, modelType);
        Assert.That(clazz?.ID, Is.EqualTo(expectedId));
    }

    /// <summary>Classifies a synthetic LoRA header with architecture and Civitai BaseModel metadata.</summary>
    private static void AssertClassWithBaseModel(string expectedId, string architecture, string baseModel, params string[] keys)
    {
        JObject header = new()
        {
            ["__metadata__"] = new JObject()
            {
                ["modelspec.architecture"] = architecture,
                ["BaseModel"] = baseModel
            }
        };
        foreach (string key in keys)
        {
            header[key] = new JObject();
        }
        T2IModel model = new(null, "", "model.safetensors", "model");
        T2IModelClass clazz = T2IModelClassSorter.IdentifyClassFor(model, header, "LoRA");
        Assert.That(clazz?.ID, Is.EqualTo(expectedId));
    }
}
