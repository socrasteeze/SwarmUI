using NUnit.Framework;
using SwarmUI.Builtin_PromptEnhanceExtension;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using System;
using System.Collections.Generic;
using System.IO;

namespace SwarmUITests;

/// <summary>Tests the pure/testable surface of the Prompt Enhance extension: profile resolution order,
/// cache-key stability, the writer-stream line parsers, hard-stop detection, and Swarm-syntax shield/unshield
/// round trips. No network access anywhere in this file - <see cref="PromptEnhanceClient.ChatStream"/> and the
/// live health probes in <see cref="PromptEnhanceEndpoints"/> are deliberately not exercised here.</summary>
[TestFixture]
public class PromptEnhanceTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Builds a minimal <see cref="T2IModel"/> for resolution tests, with an optional class/compat
    /// class ID pair. The handler is deliberately null: <see cref="T2IModel"/> only stores it, never reads it.</summary>
    private static T2IModel MakeModel(string name, string classId = null, string compatId = null)
    {
        T2IModel model = new(null, "", "", name);
        if (classId is not null)
        {
            model.ModelClass = new T2IModelClass()
            {
                ID = classId,
                CompatClass = compatId is null ? null : new T2IModelCompatClass() { ID = compatId }
            };
        }
        return model;
    }

    #region PromptEnhanceProfiles.Resolve

    /// <summary>A manual override naming a known profile wins over everything else - including a model whose
    /// filename would otherwise match a filename override (illustrious) AND whose class/compat would otherwise
    /// resolve to yet another, different profile (flux2-klein-4b), so this actually proves precedence over
    /// both other resolution paths rather than over an unmapped no-op case.</summary>
    [Test]
    public void Resolve_ManualOverride_WinsOverEverything()
    {
        PromptEnhanceProfiles.Register(new("pe-test-override", "Test Override", "TestModel", "system text"));
        PromptEnhanceProfiles.Register(new("illustriousxl", "IllustriousXL", "IllustriousXL", "ixl system text"));
        PromptEnhanceProfiles.Register(new("flux2-klein-4b", "FLUX.2 klein 4B", "FLUX.2-klein-4B", "klein4b system text"));
        T2IModel model = MakeModel("illustriousMix_v1.safetensors", "flux-2-klein-4b", "flux-2-klein-4b");
        PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, "pe-test-override", out string reason);
        Assert.That(resolved, Is.Not.Null);
        Assert.That(resolved.ID, Is.EqualTo("pe-test-override"));
        Assert.That(reason, Is.Null);
    }

    /// <summary>A manual override naming a profile that does not exist is a hard miss: it must not fall
    /// through to automatic selection, even when automatic selection would otherwise have succeeded.</summary>
    [Test]
    public void Resolve_UnknownManualOverride_ReturnsNullWithReason()
    {
        T2IModel model = MakeModel("some_checkpoint.safetensors", "flux-2-klein-4b", "flux-2-klein-4b");
        PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, "not-a-real-profile-id", out string reason);
        Assert.That(resolved, Is.Null);
        Assert.That(reason, Is.EqualTo("Unknown profile override 'not-a-real-profile-id'"));
    }

    /// <summary>No model loaded resolves to null with the exact contracted reason string.</summary>
    [Test]
    public void Resolve_NullModel_ReasonIsNoModelSelected()
    {
        PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(null, null, out string reason);
        Assert.That(resolved, Is.Null);
        Assert.That(reason, Is.EqualTo("No model selected"));
    }

    /// <summary>Anima now has its own distinct compat class (rather than sharing the SDXL bucket), so it
    /// resolves through <c>CompatClassMap</c> directly - no filename guess needed.</summary>
    [Test]
    public void Resolve_CompatClassMap_AnimaResolves()
    {
        PromptEnhanceProfiles.Register(new("anima", "Anima", "Anima", "anima system text"));
        T2IModel model = MakeModel("animaAesthetic_v1.safetensors", "anima", "anima");
        PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, null, out string reason);
        Assert.That(resolved?.ID, Is.EqualTo("anima"));
        Assert.That(reason, Is.Null);
    }

    /// <summary>A model merely named "animagineXL" (containing the substring "anima") but classed as plain
    /// SDXL must not misroute to the Anima profile - the unanchored "anima" filename override that used to
    /// cause this has been removed.</summary>
    [Test]
    public void Resolve_AnimagineFilename_DoesNotMisrouteToAnima()
    {
        PromptEnhanceProfiles.Register(new("anima", "Anima", "Anima", "anima system text"));
        T2IModel model = MakeModel("animagineXL_v3.safetensors", "stable-diffusion-xl-v1", "stable-diffusion-xl-v1");
        PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, null, out string reason);
        Assert.That(resolved, Is.Null);
        Assert.That(reason, Is.EqualTo("No writer profile for model class 'stable-diffusion-xl-v1'"));
    }

    /// <summary>The Illustrious/NoobAI filename override matches "noob" as well as "illustrious".</summary>
    [Test]
    public void Resolve_FilenameOverride_NoobMatchesIllustriousXLProfile()
    {
        PromptEnhanceProfiles.Register(new("illustriousxl", "IllustriousXL", "IllustriousXL", "ixl system text"));
        T2IModel model = MakeModel("noobaiXL_v9.safetensors", "stable-diffusion-xl-v1", "stable-diffusion-xl-v1");
        PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, null, out string reason);
        Assert.That(resolved?.ID, Is.EqualTo("illustriousxl"));
        Assert.That(reason, Is.Null);
    }

    /// <summary>With no filename override match, the model's own class ID resolves the profile.</summary>
    [Test]
    public void Resolve_ModelClassMap_WhenNoFilenameOverrideMatches()
    {
        PromptEnhanceProfiles.Register(new("flux2-klein-4b", "FLUX.2 klein 4B", "FLUX.2-klein-4B", "klein4b system text"));
        T2IModel model = MakeModel("some_checkpoint.safetensors", "flux-2-klein-4b", "flux-2-klein-4b");
        PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, null, out string reason);
        Assert.That(resolved?.ID, Is.EqualTo("flux2-klein-4b"));
        Assert.That(reason, Is.Null);
    }

    /// <summary>When the class ID itself is not in the class map (eg an unrecognised sub-variant) but the
    /// compat class ID is, the compat map still resolves it.</summary>
    [Test]
    public void Resolve_CompatClassMap_WhenClassIdItselfUnmapped()
    {
        PromptEnhanceProfiles.Register(new("flux2-klein-9b", "FLUX.2 klein 9B", "FLUX.2-klein-9B", "klein9b system text"));
        T2IModel model = MakeModel("some_variant.safetensors", "flux-2-klein-9b-variant", "flux-2-klein-9b");
        PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, null, out string reason);
        Assert.That(resolved?.ID, Is.EqualTo("flux2-klein-9b"));
        Assert.That(reason, Is.Null);
    }

    /// <summary>Krea 2 has its own distinct compat class (like Anima), so it resolves through
    /// <c>CompatClassMap</c> directly - no filename guess needed.</summary>
    [Test]
    public void Resolve_CompatClassMap_Krea2Resolves()
    {
        PromptEnhanceProfiles.Register(new("krea-2", "Krea 2", "Krea-2", "krea-2 system text"));
        T2IModel model = MakeModel("krea2_raw_bf16.safetensors", "krea-2", "krea-2");
        PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, null, out string reason);
        Assert.That(resolved?.ID, Is.EqualTo("krea-2"));
        Assert.That(reason, Is.Null);
    }

    /// <summary>A model that matches no filename override, class, or compat class resolves to null with a
    /// reason naming the unresolved class.</summary>
    [Test]
    public void Resolve_NoMatchAnywhere_ReturnsNullWithReason()
    {
        T2IModel model = MakeModel("plain_sdxl_checkpoint.safetensors", "stable-diffusion-xl-v1", "stable-diffusion-xl-v1");
        PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, null, out string reason);
        Assert.That(resolved, Is.Null);
        Assert.That(reason, Is.EqualTo("No writer profile for model class 'stable-diffusion-xl-v1'"));
    }

    #endregion

    #region PromptEnhanceProfiles filename/folder override config

    /// <summary>A '^ill/' folder-pattern override (loaded from the user-editable overrides config) resolves
    /// checkpoints under 'ill/' to the IllustriousXL profile even when the filename itself carries no
    /// "illustrious" substring at all - the escape hatch for a library where most Illustrious derivatives
    /// don't name themselves that.</summary>
    [Test]
    public void Resolve_ConfiguredFolderOverride_IllFolderResolvesIllustriousXL()
    {
        PromptEnhanceProfiles.Register(new("illustriousxl", "IllustriousXL", "IllustriousXL", "ixl system text"));
        WithTempOverridesConfig("""{"overrides":[{"pattern":"^ill/","profile":"illustriousxl"}]}""", () =>
        {
            T2IModel model = MakeModel("ill/Auralis_v3.safetensors", "stable-diffusion-xl-v1", "stable-diffusion-xl-v1");
            PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, null, out string reason);
            Assert.That(resolved?.ID, Is.EqualTo("illustriousxl"));
            Assert.That(reason, Is.Null);
        });
    }

    /// <summary>A plain SDXL checkpoint living outside any configured folder override still resolves to null
    /// with a reason - the folder map must not accidentally widen to unrelated models.</summary>
    [Test]
    public void Resolve_PlainSdxlOutsideOverrideFolders_StillReturnsNullWithReason()
    {
        WithTempOverridesConfig("""{"overrides":[{"pattern":"^ill/","profile":"illustriousxl"},{"pattern":"^anima/","profile":"anima"}]}""", () =>
        {
            T2IModel model = MakeModel("sdxl/foo.safetensors", "stable-diffusion-xl-v1", "stable-diffusion-xl-v1");
            PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, null, out string reason);
            Assert.That(resolved, Is.Null);
            Assert.That(reason, Is.EqualTo("No writer profile for model class 'stable-diffusion-xl-v1'"));
        });
    }

    /// <summary>A malformed regex pattern in the override config is logged and skipped, never thrown - and a
    /// valid sibling entry in the same file still loads and resolves normally.</summary>
    [Test]
    public void LoadOverrides_MalformedRegex_IsSkippedNotThrown()
    {
        PromptEnhanceProfiles.Register(new("anima", "Anima", "Anima", "anima system text"));
        Assert.DoesNotThrow(() => WithTempOverridesConfig(
            """{"overrides":[{"pattern":"(unterminated","profile":"anima"},{"pattern":"^anima/","profile":"anima"}]}""",
            () =>
            {
                T2IModel model = MakeModel("anima/Foo.safetensors", "stable-diffusion-xl-v1", "stable-diffusion-xl-v1");
                PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, null, out string reason);
                Assert.That(resolved?.ID, Is.EqualTo("anima"));
                Assert.That(reason, Is.Null);
            }));
    }

    /// <summary>Precedence still holds with the folder override map in play: a manual override wins over a
    /// configured folder pattern that would otherwise match.</summary>
    [Test]
    public void Resolve_ManualOverride_StillWinsOverConfiguredFolderOverride()
    {
        PromptEnhanceProfiles.Register(new("pe-test-manual-wins", "Test Manual", "TestModel", "system text"));
        PromptEnhanceProfiles.Register(new("illustriousxl", "IllustriousXL", "IllustriousXL", "ixl system text"));
        WithTempOverridesConfig("""{"overrides":[{"pattern":"^ill/","profile":"illustriousxl"}]}""", () =>
        {
            T2IModel model = MakeModel("ill/Auralis_v3.safetensors", "stable-diffusion-xl-v1", "stable-diffusion-xl-v1");
            PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, "pe-test-manual-wins", out string reason);
            Assert.That(resolved?.ID, Is.EqualTo("pe-test-manual-wins"));
            Assert.That(reason, Is.Null);
        });
    }

    /// <summary>Precedence still holds with the folder override map in play: it wins over the model-class and
    /// compat-class maps too, for a model whose folder is configured but whose class would otherwise resolve
    /// to a different profile entirely.</summary>
    [Test]
    public void Resolve_ConfiguredFolderOverride_WinsOverModelClassMap()
    {
        PromptEnhanceProfiles.Register(new("anima", "Anima", "Anima", "anima system text"));
        PromptEnhanceProfiles.Register(new("flux2-klein-4b", "FLUX.2 klein 4B", "FLUX.2-klein-4B", "klein4b system text"));
        WithTempOverridesConfig("""{"overrides":[{"pattern":"^anima/","profile":"anima"}]}""", () =>
        {
            T2IModel model = MakeModel("anima/Foo.safetensors", "flux-2-klein-4b", "flux-2-klein-4b");
            PromptEnhanceProfile resolved = PromptEnhanceProfiles.Resolve(model, null, out string reason);
            Assert.That(resolved?.ID, Is.EqualTo("anima"));
            Assert.That(reason, Is.Null);
        });
    }

    /// <summary>Runs <paramref name="body"/> with <see cref="PromptEnhanceProfiles"/>'s override config
    /// redirected to a throwaway data directory holding exactly <paramref name="json"/>, then restores
    /// <see cref="Program.DataDir"/> afterward - mirrors <c>CachePutTryGet_RoundTrips</c>'s isolation pattern so
    /// this never touches the real <c>Data/PromptEnhance/overrides.json</c>.</summary>
    private static void WithTempOverridesConfig(string json, Action body)
    {
        string tempDir = Path.Combine(Path.GetTempPath(), $"swarmui-promptenhance-overrides-{Guid.NewGuid():N}");
        string previousDataDir = Program.DataDir;
        Program.DataDir = tempDir;
        try
        {
            Directory.CreateDirectory($"{tempDir}/PromptEnhance");
            File.WriteAllText($"{tempDir}/PromptEnhance/overrides.json", json);
            PromptEnhanceProfiles.LoadOverrides();
            body();
        }
        finally
        {
            Program.DataDir = previousDataDir;
            try
            {
                Directory.Delete(tempDir, true);
            }
            catch (Exception)
            {
                // Best-effort - a stray open handle on a throwaway temp dir is not worth failing the test over.
            }
        }
    }

    #endregion

    #region PromptEnhanceCache.Key

    /// <summary>The cache key is stable for identical inputs, and changes whenever the pack version differs -
    /// which is what makes a stale profile pack (or a repeat prompt after a profile update) miss the cache.</summary>
    [Test]
    public void CacheKey_IsStableAndChangesWithPackVersion()
    {
        string keyA1 = PromptEnhanceCache.Key("a prompt", "profile1", "1.0.0", "writer-model", "faithful");
        string keyA2 = PromptEnhanceCache.Key("a prompt", "profile1", "1.0.0", "writer-model", "faithful");
        Assert.That(keyA1, Is.EqualTo(keyA2));
        string keyDifferentVersion = PromptEnhanceCache.Key("a prompt", "profile1", "2.0.0", "writer-model", "faithful");
        Assert.That(keyDifferentVersion, Is.Not.EqualTo(keyA1));
        string keyDifferentPrompt = PromptEnhanceCache.Key("a different prompt", "profile1", "1.0.0", "writer-model", "faithful");
        Assert.That(keyDifferentPrompt, Is.Not.EqualTo(keyA1));
    }

    /// <summary>The cache key changes across every effective strength for otherwise identical inputs, and is
    /// stable when re-computed for the same strength - this is what keeps a 'full' rewrite and a 'faithful'
    /// pass-through of the same idea from colliding on one cache entry.</summary>
    [Test]
    public void CacheKey_DiffersAcrossStrengths_StablePerStrength()
    {
        string faithful1 = PromptEnhanceCache.Key("a prompt", "profile1", "1.0.0", "writer-model", "faithful");
        string faithful2 = PromptEnhanceCache.Key("a prompt", "profile1", "1.0.0", "writer-model", "faithful");
        string expand = PromptEnhanceCache.Key("a prompt", "profile1", "1.0.0", "writer-model", "expand");
        string full = PromptEnhanceCache.Key("a prompt", "profile1", "1.0.0", "writer-model", "full");
        Assert.That(faithful1, Is.EqualTo(faithful2));
        Assert.That(faithful1, Is.Not.EqualTo(expand));
        Assert.That(faithful1, Is.Not.EqualTo(full));
        Assert.That(expand, Is.Not.EqualTo(full));
    }

    /// <summary>Put followed by TryGet round-trips the stored result, isolated to a throwaway data directory
    /// so this test never touches the real <c>Data/PromptEnhance/cache.json</c>.</summary>
    [Test]
    public void CachePutTryGet_RoundTrips()
    {
        string tempDir = Path.Combine(Path.GetTempPath(), $"swarmui-promptenhance-tests-{Guid.NewGuid():N}");
        string previousDataDir = Program.DataDir;
        Program.DataDir = tempDir;
        try
        {
            string key = PromptEnhanceCache.Key("round trip prompt", "profile1", "1.0.0", "writer-model", "faithful");
            Assert.That(PromptEnhanceCache.TryGet(key, out string missing), Is.False);
            Assert.That(missing, Is.Null);
            PromptEnhanceCache.Put(key, "the enhanced result");
            Assert.That(PromptEnhanceCache.TryGet(key, out string found), Is.True);
            Assert.That(found, Is.EqualTo("the enhanced result"));
        }
        finally
        {
            Program.DataDir = previousDataDir;
            try
            {
                Directory.Delete(tempDir, true);
            }
            catch (Exception)
            {
                // Best-effort - a stray open handle on a throwaway temp dir is not worth failing the test over.
            }
        }
    }

    #endregion

    #region PromptEnhanceClient line parsers

    /// <summary>A typical Ollama NDJSON content chunk.</summary>
    [Test]
    public void ParseOllamaLine_TypicalContentChunk()
    {
        (string content, bool done) = PromptEnhanceClient.ParseOllamaLine(
            """{"model":"m","created_at":"t","message":{"role":"assistant","content":"Hello"},"done":false}""");
        Assert.That(content, Is.EqualTo("Hello"));
        Assert.That(done, Is.False);
    }

    /// <summary>The final Ollama line, with <c>done: true</c>.</summary>
    [Test]
    public void ParseOllamaLine_DoneTrue()
    {
        (string content, bool done) = PromptEnhanceClient.ParseOllamaLine(
            """{"model":"m","message":{"role":"assistant","content":""},"done":true}""");
        Assert.That(content, Is.EqualTo(""));
        Assert.That(done, Is.True);
    }

    /// <summary>Garbage input is tolerated, not thrown - it just contributes nothing.</summary>
    [Test]
    public void ParseOllamaLine_Garbage_ReturnsEmptyNotDone()
    {
        (string content, bool done) = PromptEnhanceClient.ParseOllamaLine("not json at all {{{");
        Assert.That(content, Is.EqualTo(""));
        Assert.That(done, Is.False);
    }

    /// <summary>A blank line is tolerated the same way as garbage.</summary>
    [Test]
    public void ParseOllamaLine_BlankLine_ReturnsEmptyNotDone()
    {
        (string content, bool done) = PromptEnhanceClient.ParseOllamaLine("   ");
        Assert.That(content, Is.EqualTo(""));
        Assert.That(done, Is.False);
    }

    /// <summary>A typical OpenAI-compatible SSE delta chunk.</summary>
    [Test]
    public void ParseOpenAILine_TypicalDeltaChunk()
    {
        (string content, bool done) = PromptEnhanceClient.ParseOpenAILine(
            """data: {"choices":[{"delta":{"content":"Hi"}}]}""");
        Assert.That(content, Is.EqualTo("Hi"));
        Assert.That(done, Is.False);
    }

    /// <summary>The SSE stream's terminal sentinel line.</summary>
    [Test]
    public void ParseOpenAILine_DoneSentinel()
    {
        (string content, bool done) = PromptEnhanceClient.ParseOpenAILine("data: [DONE]");
        Assert.That(content, Is.EqualTo(""));
        Assert.That(done, Is.True);
    }

    /// <summary>A non-<c>data:</c> SSE line (eg an event/comment line) contributes nothing.</summary>
    [Test]
    public void ParseOpenAILine_NonDataLine_Ignored()
    {
        (string content, bool done) = PromptEnhanceClient.ParseOpenAILine("event: ping");
        Assert.That(content, Is.EqualTo(""));
        Assert.That(done, Is.False);
    }

    /// <summary>Malformed JSON after a <c>data:</c> prefix is tolerated, not thrown.</summary>
    [Test]
    public void ParseOpenAILine_Garbage_ReturnsEmptyNotDone()
    {
        (string content, bool done) = PromptEnhanceClient.ParseOpenAILine("data: {not valid json");
        Assert.That(content, Is.EqualTo(""));
        Assert.That(done, Is.False);
    }

    #endregion

    #region PromptEnhanceClient.IsHardStop

    /// <summary>A <c>CONFLICT:</c> reply is detected even behind leading whitespace/newlines.</summary>
    [Test]
    public void IsHardStop_ConflictWithLeadingWhitespace()
    {
        bool hard = PromptEnhanceClient.IsHardStop("   \n  CONFLICT: too many subjects for one image.\nmore text", out string kind, out string line);
        Assert.That(hard, Is.True);
        Assert.That(kind, Is.EqualTo("conflict"));
        Assert.That(line, Is.EqualTo("CONFLICT: too many subjects for one image."));
    }

    /// <summary>A <c>NEEDS INPUT:</c> reply is detected and given the <c>needs_input</c> kind.</summary>
    [Test]
    public void IsHardStop_NeedsInput()
    {
        bool hard = PromptEnhanceClient.IsHardStop("NEEDS INPUT: which character?", out string kind, out string line);
        Assert.That(hard, Is.True);
        Assert.That(kind, Is.EqualTo("needs_input"));
        Assert.That(line, Is.EqualTo("NEEDS INPUT: which character?"));
    }

    /// <summary>An ordinary rewritten prompt is never mistaken for a hard stop.</summary>
    [Test]
    public void IsHardStop_NormalReply_IsFalse()
    {
        bool hard = PromptEnhanceClient.IsHardStop("a beautiful landscape, mountains, sunset", out string kind, out string line);
        Assert.That(hard, Is.False);
        Assert.That(kind, Is.Null);
        Assert.That(line, Is.Null);
    }

    /// <summary>An empty reply is never a hard stop.</summary>
    [Test]
    public void IsHardStop_EmptyReply_IsFalse()
    {
        bool hard = PromptEnhanceClient.IsHardStop("", out string kind, out string line);
        Assert.That(hard, Is.False);
    }

    #endregion

    #region PromptEnhanceClient.Shield / Unshield

    /// <summary>A single <c>&lt;lora:...&gt;</c> tag is stripped out and comes back verbatim on unshield.</summary>
    [Test]
    public void ShieldUnshield_LoraTag_RoundTrips()
    {
        string prompt = "a cat, <lora:a:0.7>, sitting";
        string shielded = PromptEnhanceClient.Shield(prompt, out List<string> extracted);
        Assert.That(shielded, Does.Not.Contain("<lora:"));
        Assert.That(extracted, Has.Count.EqualTo(1));
        Assert.That(extracted[0], Is.EqualTo("<lora:a:0.7>"));
        string unshielded = PromptEnhanceClient.Unshield("A cat sitting.", extracted);
        Assert.That(unshielded, Does.Contain("<lora:a:0.7>"));
    }

    /// <summary>A <c>__wildcard__</c> token is stripped out and extracted verbatim.</summary>
    [Test]
    public void ShieldUnshield_Wildcard_RoundTrips()
    {
        string prompt = "a __species__ in a forest";
        string shielded = PromptEnhanceClient.Shield(prompt, out List<string> extracted);
        Assert.That(shielded, Does.Not.Contain("__species__"));
        Assert.That(extracted, Has.Count.EqualTo(1));
        Assert.That(extracted[0], Is.EqualTo("__species__"));
    }

    /// <summary>A bare <c>embedding:name</c> token (no angle brackets) is not real Swarm syntax - SwarmUI's
    /// actual embedding tag is <c>&lt;embed:name&gt;</c>/<c>&lt;embedding:name&gt;</c>, already covered by the
    /// angle-tag branch - so the bare form is left untouched and never extracted.</summary>
    [Test]
    public void Shield_BareEmbeddingToken_IsNotExtracted()
    {
        string prompt = "a portrait, embedding:foo, detailed";
        string shielded = PromptEnhanceClient.Shield(prompt, out List<string> extracted);
        Assert.That(shielded, Does.Contain("embedding:foo"));
        Assert.That(extracted, Is.Empty);
    }

    /// <summary>The real, angle-bracketed <c>&lt;embedding:name&gt;</c> form is shielded like any other tag.</summary>
    [Test]
    public void ShieldUnshield_AngleEmbeddingTag_RoundTrips()
    {
        string prompt = "a portrait, <embedding:foo>, detailed";
        string shielded = PromptEnhanceClient.Shield(prompt, out List<string> extracted);
        Assert.That(shielded, Does.Not.Contain("<embedding:"));
        Assert.That(extracted, Has.Count.EqualTo(1));
        Assert.That(extracted[0], Is.EqualTo("<embedding:foo>"));
    }

    /// <summary>A nested tag (<c>&lt;random:&lt;lora:a&gt;|&lt;lora:b&gt;&gt;</c>) is extracted as one whole
    /// balanced token, not split on its inner angle brackets.</summary>
    [Test]
    public void ShieldUnshield_NestedRandomTag_RoundTrips()
    {
        string prompt = "a scene, <random:<lora:a>|<lora:b>>, epic";
        string shielded = PromptEnhanceClient.Shield(prompt, out List<string> extracted);
        Assert.That(shielded, Does.Not.Contain("<random:"));
        Assert.That(extracted, Has.Count.EqualTo(1));
        Assert.That(extracted[0], Is.EqualTo("<random:<lora:a>|<lora:b>>"));
        string unshielded = PromptEnhanceClient.Unshield("An epic scene.", extracted);
        Assert.That(unshielded, Does.Contain("<random:<lora:a>|<lora:b>>"));
    }

    /// <summary>With nothing extracted, Unshield returns the reply unchanged.</summary>
    [Test]
    public void Unshield_NoExtractedTokens_ReturnsReplyUnchanged()
    {
        string reply = PromptEnhanceClient.Unshield("plain reply", []);
        Assert.That(reply, Is.EqualTo("plain reply"));
    }

    /// <summary>Removing a token from between two commas collapses the orphaned "<c>, ,</c>" down to one
    /// comma with normalised spacing, without otherwise reformatting the line.</summary>
    [Test]
    public void Shield_CollapsesOrphanedCommaRun()
    {
        string prompt = "cat, <lora:a:0.7>, dog";
        string shielded = PromptEnhanceClient.Shield(prompt, out List<string> extracted);
        Assert.That(shielded, Is.EqualTo("cat, dog"));
    }

    /// <summary>Shield must not flatten or collapse newline characters - it only repairs what token removal
    /// orphans on the same line (doubled commas, stray spaces), never touching intentional line breaks.</summary>
    [Test]
    public void Shield_PreservesNewlinesAroundRemovedToken()
    {
        string prompt = "a cat\n<lora:a:0.7>\na dog";
        string shielded = PromptEnhanceClient.Shield(prompt, out List<string> extracted);
        Assert.That(extracted, Has.Count.EqualTo(1));
        Assert.That(shielded, Is.EqualTo("a cat\n\na dog"));
    }

    #endregion

    #region PromptEnhanceClient.ExtractNotes

    /// <summary>A single NOTES: line is split out of the reply and returned separately.</summary>
    [Test]
    public void ExtractNotes_SingleNotesLine_SplitOut()
    {
        (string promptText, string notes) = PromptEnhanceClient.ExtractNotes("a cat sitting in a garden\nNOTES: assumed a house cat");
        Assert.That(promptText, Is.EqualTo("a cat sitting in a garden"));
        Assert.That(notes, Is.EqualTo("NOTES: assumed a house cat"));
    }

    /// <summary>Multiple NOTES: lines (not necessarily adjacent) are all removed from the prompt text and
    /// joined by newline in the returned notes.</summary>
    [Test]
    public void ExtractNotes_MultipleNotesLines_JoinedByNewline()
    {
        (string promptText, string notes) = PromptEnhanceClient.ExtractNotes("line one\nNOTES: first note\nline two\nNOTES: second note");
        Assert.That(promptText, Is.EqualTo("line one\nline two"));
        Assert.That(notes, Is.EqualTo("NOTES: first note\nNOTES: second note"));
    }

    /// <summary>A reply with no NOTES: line returns the reply unchanged and an empty notes string.</summary>
    [Test]
    public void ExtractNotes_NoNotesLines_ReturnsReplyAndEmptyNotes()
    {
        (string promptText, string notes) = PromptEnhanceClient.ExtractNotes("a plain rewritten prompt");
        Assert.That(promptText, Is.EqualTo("a plain rewritten prompt"));
        Assert.That(notes, Is.EqualTo(""));
    }

    #endregion

    #region PromptEnhanceClient.ApplyStrength

    /// <summary>Strength <c>faithful</c> sends the shielded prompt unchanged - exactly the pre-Strength
    /// behavior.</summary>
    [Test]
    public void ApplyStrength_Faithful_SendsPromptUnchanged()
    {
        string result = PromptEnhanceClient.ApplyStrength("a cat", "a cat", "faithful", false, out string effective, out string note);
        Assert.That(result, Is.EqualTo("a cat"));
        Assert.That(effective, Is.EqualTo("faithful"));
        Assert.That(note, Is.Null);
    }

    /// <summary>Strength <c>expand</c> prepends exactly <see cref="PromptEnhanceClient.ExpandDirective"/>.</summary>
    [Test]
    public void ApplyStrength_Expand_PrependsExpandDirective()
    {
        string result = PromptEnhanceClient.ApplyStrength("a cat", "a cat", "expand", false, out string effective, out string note);
        Assert.That(result, Is.EqualTo("Mode: expand\n\na cat"));
        Assert.That(effective, Is.EqualTo("expand"));
        Assert.That(note, Is.Null);
    }

    /// <summary>Strength <c>full</c> prepends the exact full-scene directive from the spec, verbatim.</summary>
    [Test]
    public void ApplyStrength_Full_PrependsFullDirective()
    {
        string result = PromptEnhanceClient.ApplyStrength("a cat", "a cat", "full", false, out string effective, out string note);
        Assert.That(result, Is.EqualTo(
            "Mode: expand\n\nBuild this into a complete, vivid image prompt in this profile's output format: add a fitting setting, lighting, camera framing, mood and material detail that suit the subject. Keep every detail I gave unchanged, and keep the art style I asked for; do not introduce a different style.\n\na cat"));
        Assert.That(effective, Is.EqualTo("full"));
        Assert.That(note, Is.Null);
    }

    /// <summary>A blank strength falls back to the default, <c>full</c>.</summary>
    [Test]
    public void ApplyStrength_Blank_FallsBackToFull()
    {
        PromptEnhanceClient.ApplyStrength("a cat", "a cat", "", false, out string effective, out string note);
        Assert.That(effective, Is.EqualTo("full"));
        Assert.That(note, Is.Null);
    }

    /// <summary>An unrecognized strength value falls back to <c>full</c>, same as blank.</summary>
    [Test]
    public void ApplyStrength_Unknown_FallsBackToFull()
    {
        PromptEnhanceClient.ApplyStrength("a cat", "a cat", "extra-spicy", false, out string effective, out string note);
        Assert.That(effective, Is.EqualTo("full"));
    }

    /// <summary>Strength is matched case-insensitively - <c>"FULL"</c> behaves exactly like <c>"full"</c>.</summary>
    [Test]
    public void ApplyStrength_IsCaseInsensitive()
    {
        string result = PromptEnhanceClient.ApplyStrength("a cat", "a cat", "ExPaNd", false, out string effective, out string note);
        Assert.That(result, Is.EqualTo("Mode: expand\n\na cat"));
        Assert.That(effective, Is.EqualTo("expand"));
    }

    /// <summary>Each of the profile pack's own shortcuts, at the start of the raw prompt, wins over any
    /// requested strength: no directive is added, and the effective strength reports as <c>user</c>.</summary>
    [Test]
    [TestCase("/rewrite make it moodier")]
    [TestCase("/expand make it moodier")]
    [TestCase("/positive make it moodier")]
    [TestCase("/full make it moodier")]
    [TestCase("/explain make it moodier")]
    [TestCase("/json make it moodier")]
    [TestCase("Mode: expand\n\nmake it moodier")]
    [TestCase("mode: expand\n\nmake it moodier")]
    public void ApplyStrength_UserShortcutOrMode_Passthrough_NoDirective(string rawPrompt)
    {
        string shielded = rawPrompt; // shielding is irrelevant to this check - no Swarm-syntax tokens present
        string result = PromptEnhanceClient.ApplyStrength(rawPrompt, shielded, "full", false, out string effective, out string note);
        Assert.That(result, Is.EqualTo(shielded));
        Assert.That(effective, Is.EqualTo("user"));
        Assert.That(note, Is.Null);
    }

    /// <summary>Leading whitespace before a shortcut is trimmed before the check, same as the profile pack's
    /// own contract.</summary>
    [Test]
    public void ApplyStrength_UserShortcut_LeadingWhitespaceTrimmed()
    {
        string result = PromptEnhanceClient.ApplyStrength("   /json give me structured output", "/json give me structured output", "full", false, out string effective, out string note);
        Assert.That(result, Is.EqualTo("/json give me structured output"));
        Assert.That(effective, Is.EqualTo("user"));
    }

    /// <summary>A shortcut must match as a whole token - <c>/fully</c> is not <c>/full</c>, so it does not
    /// trigger the user passthrough and the requested strength is applied normally.</summary>
    [Test]
    public void ApplyStrength_ShortcutPrefixOfLongerWord_DoesNotMatch()
    {
        string result = PromptEnhanceClient.ApplyStrength("/fully render this", "/fully render this", "expand", false, out string effective, out string note);
        Assert.That(effective, Is.EqualTo("expand"));
        Assert.That(result, Is.EqualTo("Mode: expand\n\n/fully render this"));
    }

    /// <summary>On an edit profile, strength <c>full</c> is capped down to <c>expand</c>, and a note explains
    /// the cap.</summary>
    [Test]
    public void ApplyStrength_EditProfile_FullIsCappedToExpandWithNote()
    {
        string result = PromptEnhanceClient.ApplyStrength("edit the sky", "edit the sky", "full", true, out string effective, out string note);
        Assert.That(result, Is.EqualTo("Mode: expand\n\nedit the sky"));
        Assert.That(effective, Is.EqualTo("expand"));
        Assert.That(note, Is.EqualTo("Full scene is not available for edit profiles; used Expand."));
    }

    /// <summary>On an edit profile, strengths <c>faithful</c> and <c>expand</c> are unaffected by the cap - it
    /// only ever downgrades <c>full</c>.</summary>
    [Test]
    public void ApplyStrength_EditProfile_FaithfulAndExpand_Unaffected()
    {
        string faithfulResult = PromptEnhanceClient.ApplyStrength("edit the sky", "edit the sky", "faithful", true, out string faithfulEffective, out string faithfulNote);
        Assert.That(faithfulResult, Is.EqualTo("edit the sky"));
        Assert.That(faithfulEffective, Is.EqualTo("faithful"));
        Assert.That(faithfulNote, Is.Null);
        string expandResult = PromptEnhanceClient.ApplyStrength("edit the sky", "edit the sky", "expand", true, out string expandEffective, out string expandNote);
        Assert.That(expandResult, Is.EqualTo("Mode: expand\n\nedit the sky"));
        Assert.That(expandEffective, Is.EqualTo("expand"));
        Assert.That(expandNote, Is.Null);
    }

    /// <summary>A shield -> ApplyStrength -> (simulated writer reply) -> Unshield round trip still restores the
    /// extracted token byte-identical with a directive applied in between - proves the directive text can never
    /// interact with the shield/unshield mechanism.</summary>
    [Test]
    public void ShieldApplyStrengthUnshield_RoundTrips_WithDirective()
    {
        string prompt = "a cat, <lora:x:0.7>, sitting";
        string shielded = PromptEnhanceClient.Shield(prompt, out List<string> extracted);
        string directed = PromptEnhanceClient.ApplyStrength(prompt, shielded, "full", false, out string effective, out _);
        Assert.That(effective, Is.EqualTo("full"));
        Assert.That(directed, Does.StartWith("Mode: expand\n\n"));
        Assert.That(directed, Does.Not.Contain("<lora:"));
        // Simulate the writer's reply: it never saw the directive as prompt content to preserve verbatim, it
        // just rewrote the (directive-prefixed) idea into a plain rewritten prompt, same as any other reply.
        string simulatedReply = "A cat sitting in a sunlit garden.";
        string unshielded = PromptEnhanceClient.Unshield(simulatedReply, extracted);
        Assert.That(unshielded, Is.EqualTo("A cat sitting in a sunlit garden.\n<lora:x:0.7>"));
    }

    #endregion
}
