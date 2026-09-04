using Newtonsoft.Json.Linq;
using NUnit.Framework;
using SwarmUI.Backends;
using SwarmUI.Core;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;

namespace SwarmUITests;

/// <summary>Tests the fail-closed remote Swarm model inventory protocol.</summary>
[TestFixture]
public class SwarmSwarmBackendTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Builds a valid, deterministic compact inventory response.</summary>
    private static JObject ValidInventory()
    {
        return JObject.Parse(
            """
            {
                "version": 1,
                "source_version": "0.9.8.3.GIT-12345678",
                "model_edit_id": 7,
                "allow_remote": true,
                "complete": true,
                "total": 3,
                "returned": 3,
                "truncated": false,
                "parameter_count": 2,
                "parameter_ids": ["height", "width"],
                "subtype_count": 2,
                "subtypes": {
                    "LoRA": {
                        "complete": true,
                        "scan_succeeded": true,
                        "total": 2,
                        "returned": 2,
                        "truncated": false,
                        "names": ["alpha.safetensors", "folder/bravo.safetensors"]
                    },
                    "Stable-Diffusion": {
                        "complete": true,
                        "scan_succeeded": true,
                        "total": 1,
                        "returned": 1,
                        "truncated": false,
                        "names": ["checkpoints/charlie.safetensors"]
                    }
                }
            }
            """);
    }

    /// <summary>Parses a test inventory against the standard local parity requirements.</summary>
    private static SwarmSwarmBackend.RemoteModelInventorySnapshot ParseInventory(JObject inventory,
        string[] requiredSubtypes = null, bool allowRemote = true, string requiredSourceVersion = "0.9.8.3.GIT-12345678")
    {
        requiredSubtypes ??= ["LoRA", "Stable-Diffusion"];
        return SwarmSwarmBackend.ParseCompactModelInventory(inventory, requiredSubtypes,
            ["height", "width"], allowRemote, requiredSourceVersion);
    }

    /// <summary>Invokes the private refresh serializer so its concurrency contract can be tested without network traffic.</summary>
    private static Task RunSerialized(SwarmSwarmBackend backend, Func<Task> action)
    {
        MethodInfo method = typeof(SwarmSwarmBackend).GetMethod("RunWithRemoteInventoryRefreshLock", BindingFlags.Instance | BindingFlags.NonPublic);
        return method.Invoke(backend, [action]) as Task;
    }

    /// <summary>Confirms a complete response is parsed into one routing and metadata snapshot.</summary>
    [Test]
    public static void TestCompactInventoryAccepted()
    {
        SwarmSwarmBackend.RemoteModelInventorySnapshot snapshot = ParseInventory(ValidInventory());
        Assert.That(snapshot.SourceVersion, Is.EqualTo("0.9.8.3.GIT-12345678"));
        Assert.That(snapshot.ModelEditID, Is.EqualTo(7));
        Assert.That(snapshot.Models.Keys, Is.EquivalentTo(new[] { "LoRA", "Stable-Diffusion" }));
        Assert.That(snapshot.Models["LoRA"], Is.EqualTo(new[] { "alpha.safetensors", "folder/bravo.safetensors" }));
        Assert.That(snapshot.RemoteModels["LoRA"], Is.Empty);
    }

    /// <summary>Confirms an explicitly truncated inventory cannot be published.</summary>
    [Test]
    public static void TestCompactInventoryRejectsTruncation()
    {
        JObject inventory = ValidInventory();
        inventory["complete"] = false;
        inventory["truncated"] = true;
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(inventory));
    }

    /// <summary>Confirms omission of a locally required subtype cannot bypass routing validation.</summary>
    [Test]
    public static void TestCompactInventoryRejectsMissingSubtype()
    {
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(
            ValidInventory(), ["Clip", "LoRA", "Stable-Diffusion"]));
    }

    /// <summary>Confirms a failed model-root scan cannot be represented as a routable inventory.</summary>
    [Test]
    public static void TestCompactInventoryRejectsFailedScan()
    {
        JObject inventory = ValidInventory();
        inventory["subtypes"]["LoRA"]["scan_succeeded"] = false;
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(inventory));
    }

    /// <summary>Confirms malformed ordering and counts cannot be accepted as a complete snapshot.</summary>
    [Test]
    public static void TestCompactInventoryRejectsMalformedSubtype()
    {
        JObject inventory = ValidInventory();
        inventory["subtypes"]["LoRA"]["names"] = new JArray("folder/bravo.safetensors", "alpha.safetensors");
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(inventory));

        inventory = ValidInventory();
        inventory["subtypes"]["LoRA"]["total"] = 3;
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(inventory));
    }

    /// <summary>Confirms a remote cannot silently change the requested forwarding behavior.</summary>
    [Test]
    public static void TestCompactInventoryRejectsForwardingMismatch()
    {
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(ValidInventory(), allowRemote: false));
    }

    /// <summary>Confirms a spoke running different code cannot be accepted for generation.</summary>
    [Test]
    public static void TestCompactInventoryRejectsVersionMismatch()
    {
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(
            ValidInventory(), requiredSourceVersion: "0.9.8.3.GIT-different"));
    }

    /// <summary>Confirms missing or extra registered generation parameters block spoke routing.</summary>
    [Test]
    public static void TestCompactInventoryRejectsParameterMismatch()
    {
        JObject inventory = ValidInventory();
        inventory["parameter_ids"] = new JArray("height", "steps");
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(inventory));
    }

    /// <summary>Confirms spoke supersets are valid while every hub-local model remains mandatory.</summary>
    [Test]
    public static void TestCompactInventoryRequiresHubModelCoverage()
    {
        SwarmSwarmBackend.RemoteModelInventorySnapshot snapshot = ParseInventory(ValidInventory());
        Dictionary<string, string[]> covered = new(StringComparer.Ordinal)
        {
            ["LoRA"] = ["alpha.safetensors"],
            ["Stable-Diffusion"] = ["checkpoints/charlie.safetensors"]
        };
        Assert.DoesNotThrow(() => SwarmSwarmBackend.ValidateModelInventoryCoverage(snapshot, covered));

        covered["LoRA"] = ["alpha.safetensors", "missing/delta.safetensors"];
        SwarmReadableErrorException exception = Assert.Throws<SwarmReadableErrorException>(
            () => SwarmSwarmBackend.ValidateModelInventoryCoverage(snapshot, covered));
        Assert.That(exception.Message, Does.Contain("missing 1 hub-local model"));
        Assert.That(exception.Message, Does.Contain("missing/delta.safetensors"));
    }

    /// <summary>Confirms remote preview proxy URLs stay hub-local and safely encode routing identities.</summary>
    [Test]
    public static void TestRemoteModelPreviewProxyUrl()
    {
        string url = SwarmSwarmBackend.BuildRemoteModelPreviewProxyUrl(23, "LoRA/Alt", "folder/a b&c.safetensors");
        Assert.That(url, Is.EqualTo($"/RemoteModelPreview/23?subtype=LoRA%2FAlt&model=folder%2Fa%20b%26c.safetensors&editid={ModelsAPI.ModelEditID}"));
    }

    /// <summary>Confirms the controller authorization header is redacted before backend settings reach logs or clients.</summary>
    [Test]
    public static void TestSwarmBackendAuthorizationRedaction()
    {
        SwarmSwarmBackend.SwarmSwarmBackendSettings settings = new()
        {
            AuthorizationHeader = "Bearer test-controller-secret"
        };
        string serialized = settings.SaveAllWithoutSecretValues("\t<secret>", "").ToString();
        Assert.That(serialized, Does.Contain("<secret>"));
        Assert.That(serialized, Does.Not.Contain("test-controller-secret"));
    }

    /// <summary>Confirms proxied previews accept bounded raster bytes and reject active or MIME-confused content.</summary>
    [Test]
    public static void TestRemoteModelPreviewValidation()
    {
        using Image<Rgba32> image = new(1, 1);
        using MemoryStream stream = new();
        image.SaveAsPng(stream);
        string encoded = Convert.ToBase64String(stream.ToArray());
        (byte[] data, string mimeType) = ModelsAPI.DecodeRemoteModelPreviewData($"data:image/png;base64,{encoded}");
        Assert.That(data, Is.Not.Empty);
        Assert.That(mimeType, Is.EqualTo("image/png"));
        Assert.Throws<SwarmReadableErrorException>(() =>
            ModelsAPI.DecodeRemoteModelPreviewData($"data:text/html;base64,{encoded}"));
        Assert.Throws<SwarmReadableErrorException>(() =>
            ModelsAPI.DecodeRemoteModelPreviewData($"data:image/jpeg;base64,{encoded}"));
        Assert.That(ModelsAPI.IsRemoteModelPreviewHopAllowed(0), Is.True);
        Assert.That(ModelsAPI.IsRemoteModelPreviewHopAllowed(ModelsAPI.RemoteModelPreviewMaxHopCount - 1), Is.True);
        Assert.That(ModelsAPI.IsRemoteModelPreviewHopAllowed(-1), Is.False);
        Assert.That(ModelsAPI.IsRemoteModelPreviewHopAllowed(ModelsAPI.RemoteModelPreviewMaxHopCount), Is.False);

        Uri safeUri = ModelsAPI.BuildSafeRemoteModelPreviewUri(
            "https://remote.example/swarm", "/ViewSpecial/LoRA/model.png?editid=1");
        Assert.That(safeUri.AbsoluteUri,
            Is.EqualTo("https://remote.example/swarm/ViewSpecial/LoRA/model.png?editid=1"));
        Assert.Throws<SwarmReadableErrorException>(() =>
            ModelsAPI.BuildSafeRemoteModelPreviewUri("https://remote.example/swarm", "../API/GetCurrentStatus"));
        Assert.Throws<SwarmReadableErrorException>(() =>
            ModelsAPI.BuildSafeRemoteModelPreviewUri("https://remote.example/swarm", "ViewSpecial/%2e%2e/API/secret"));
        Assert.Throws<SwarmReadableErrorException>(() =>
            ModelsAPI.BuildSafeRemoteModelPreviewUri("https://remote.example/swarm", "https://other.example/image.png"));
        Assert.Throws<SwarmReadableErrorException>(() =>
            ModelsAPI.BuildSafeRemoteModelPreviewUri("https://remote.example/swarm", "API/DescribeModel"));
    }

    /// <summary>Confirms full refresh work is serialized while same-flow session renewal remains reentrant.</summary>
    [Test]
    public static async Task TestRemoteInventoryRefreshSerialization()
    {
        SwarmSwarmBackend backend = new();
        TaskCompletionSource firstEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        TaskCompletionSource releaseFirst = new(TaskCreationOptions.RunContinuationsAsynchronously);
        int active = 0;
        int maximumActive = 0;
        int calls = 0;
        async Task RunFirst()
        {
            int nowActive = Interlocked.Increment(ref active);
            maximumActive = Math.Max(maximumActive, nowActive);
            Interlocked.Increment(ref calls);
            await RunSerialized(backend, () =>
            {
                Interlocked.Increment(ref calls);
                return Task.CompletedTask;
            });
            firstEntered.SetResult();
            await releaseFirst.Task;
            Interlocked.Decrement(ref active);
        }
        async Task RunSecond()
        {
            int nowActive = Interlocked.Increment(ref active);
            maximumActive = Math.Max(maximumActive, nowActive);
            Interlocked.Increment(ref calls);
            Interlocked.Decrement(ref active);
            await Task.CompletedTask;
        }

        Task first = RunSerialized(backend, RunFirst);
        await firstEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Task second = RunSerialized(backend, RunSecond);
        await Task.Delay(50);
        Assert.That(calls, Is.EqualTo(2), "The nested reentrant call should run, but the concurrent caller must still wait.");
        releaseFirst.SetResult();
        await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(2));
        Assert.That(calls, Is.EqualTo(3));
        Assert.That(maximumActive, Is.EqualTo(1));
    }

    /// <summary>Confirms generic compatibility remains opt-in while required spoke negotiation fails closed.</summary>
    [Test]
    public static void TestRequiredSpokeModeNegotiation()
    {
        SwarmSwarmBackend.SwarmSwarmBackendSettings settings = new();
        Assert.That(settings.RequireSpokeMode, Is.False);
        Assert.DoesNotThrow(() => SwarmSwarmBackend.ValidateSpokeModeRequirement(false, false));
        Assert.DoesNotThrow(() => SwarmSwarmBackend.ValidateSpokeModeRequirement(true, true));
        Assert.Throws<SwarmReadableErrorException>(() => SwarmSwarmBackend.ValidateSpokeModeRequirement(true, false));
    }

    /// <summary>Confirms spoke handshakes require an explicit, type-strict controller authorization claim.</summary>
    [Test]
    public static void TestSpokeControllerNegotiation()
    {
        Assert.DoesNotThrow(() => SwarmSwarmBackend.ValidateSpokeControllerAdvertisement(false, null));
        Assert.DoesNotThrow(() => SwarmSwarmBackend.ValidateSpokeControllerAdvertisement(true, new JValue(true)));
        Assert.Throws<SwarmReadableErrorException>(() => SwarmSwarmBackend.ValidateSpokeControllerAdvertisement(true, null));
        Assert.Throws<SwarmReadableErrorException>(() => SwarmSwarmBackend.ValidateSpokeControllerAdvertisement(true, new JValue(false)));
        Assert.Throws<SwarmReadableErrorException>(() => SwarmSwarmBackend.ValidateSpokeControllerAdvertisement(true, new JValue("true")));
    }

    /// <summary>Confirms a spoke cannot report ready without a running or pending direct generation backend.</summary>
    [Test]
    public static void TestSpokeBackendAvailability()
    {
        Assert.That(SwarmSwarmBackend.HasRoutableModelCapacity(true, 1), Is.True);
        Assert.That(SwarmSwarmBackend.HasRoutableModelCapacity(true, 0), Is.False);
        Assert.That(SwarmSwarmBackend.HasRoutableModelCapacity(false, 1), Is.False);
        Assert.That(SwarmSwarmBackend.IsPendingRemoteBackendStatus("loading"), Is.True);
        Assert.That(SwarmSwarmBackend.IsPendingRemoteBackendStatus("waiting"), Is.True);
        Assert.That(SwarmSwarmBackend.IsPendingRemoteBackendStatus("disabled"), Is.False);
        Assert.DoesNotThrow(() => SwarmSwarmBackend.ValidateSpokeBackendAvailability(true, 1, false));
        Assert.DoesNotThrow(() => SwarmSwarmBackend.ValidateSpokeBackendAvailability(true, 0, true));
        Assert.DoesNotThrow(() => SwarmSwarmBackend.ValidateSpokeBackendAvailability(false, 0, false));
        Assert.Throws<SwarmReadableErrorException>(() => SwarmSwarmBackend.ValidateSpokeBackendAvailability(true, 0, false));
    }
}
