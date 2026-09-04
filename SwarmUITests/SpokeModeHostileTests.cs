using Newtonsoft.Json.Linq;
using NUnit.Framework;
using SwarmUI.Accounts;
using SwarmUI.Backends;
using SwarmUI.Builtin_ComfyUIBackend;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;

namespace SwarmUITests;

/// <summary>Hostile boundary tests for spoke-mode refusal, inventory validation, and remote child linkage.</summary>
[TestFixture]
[NonParallelizable]
public class SpokeModeHostileTests : SwarmUITest
{
    /// <summary>Expected source version in the isolated compact-inventory samples.</summary>
    private const string SourceVersion = "0.9.8.3.GIT-hostile";

    /// <summary>Prepares shared test primitives.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Restores normal runtime mode after every policy test.</summary>
    [TearDown]
    public static void ResetSpokeMode()
    {
        SetSpokeMode(false);
    }

    /// <summary>Updates the otherwise immutable runtime-mode flag for isolated tests.</summary>
    private static void SetSpokeMode(bool active)
    {
        PropertyInfo property = typeof(Program).GetProperty(nameof(Program.IsSpokeMode), BindingFlags.Public | BindingFlags.Static);
        MethodInfo setter = property.GetSetMethod(true);
        setter.Invoke(null, [active]);
    }

    /// <summary>Builds a valid deterministic compact inventory for hostile mutations.</summary>
    private static JObject ValidInventory()
    {
        return JObject.Parse(
            $$"""
            {
                "version": 1,
                "source_version": "{{SourceVersion}}",
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

    /// <summary>Parses a hostile sample against an exact local subtype and parameter contract.</summary>
    private static SwarmSwarmBackend.RemoteModelInventorySnapshot ParseInventory(JObject inventory)
    {
        return SwarmSwarmBackend.ParseCompactModelInventory(inventory, ["LoRA", "Stable-Diffusion"],
            ["height", "width"], true, SourceVersion);
    }

    /// <summary>Confirms a spoke refusal is typed and gives the operator the exact blocked action and recovery point.</summary>
    [Test]
    public static void TestSpokePolicyRefusalMessage()
    {
        SetSpokeMode(true);

        SpokeModeWriteException exception = Assert.Throws<SpokeModeWriteException>(
            () => SpokeModePolicy.AssertModelTreeWriteAllowed("rename a model"));

        Assert.That(exception.Message,
            Is.EqualTo("Spoke mode blocks model-tree writes (rename a model). Manage models on the hub."));
        Assert.That(exception, Is.InstanceOf<SwarmReadableErrorException>());

        exception = Assert.Throws<SpokeModeWriteException>(
            () => SpokeModePolicy.AssertRuntimeMutationAllowed("update PyTorch"));
        Assert.That(exception.Message,
            Is.EqualTo("Spoke mode blocks runtime changes (update PyTorch). Update dependencies on the hub and redeploy the spoke."));
    }

    /// <summary>Confirms a spoke refuses local generation before backend work while a controller reaches the normal cancellation gate.</summary>
    [Test]
    public static async Task TestGenerationRequiresSpokeControllerSession()
    {
        SetSpokeMode(true);
        Session session = new()
        {
            IsSpokeController = false
        };
        int outputCount = 0;
        int saveCount = 0;
        string error = null;
        T2IParamInput input = new(session);
        using (Session.GenClaim claim = session.Claim())
        {
            claim.LocalClaimInterrupt.Cancel();
            await T2IEngine.CreateImageTask(input, "spoke-gate-test", claim, _ => outputCount++,
                message => error = message, false, 0.01f, (_, _) => saveCount++, false);
        }
        Assert.That(error, Is.EqualTo("Spoke mode accepts generation only from its hub controller."));
        Assert.That(outputCount, Is.Zero);
        Assert.That(saveCount, Is.Zero);

        session.IsSpokeController = true;
        error = null;
        input = new T2IParamInput(session);
        using (Session.GenClaim claim = session.Claim())
        {
            claim.LocalClaimInterrupt.Cancel();
            await T2IEngine.CreateImageTask(input, "spoke-gate-test", claim, _ => outputCount++,
                message => error = message, false, 0.01f, (_, _) => saveCount++, false);
        }
        Assert.That(error, Is.Null);
        Assert.That(outputCount, Is.Zero);
        Assert.That(saveCount, Is.Zero);

        foreach (string workflowParameter in new[] { "comfyworkflowraw", "comfyuicustomworkflow" })
        {
            error = null;
            input = new T2IParamInput(session);
            input.InternalSet.ValuesInput[workflowParameter] = "{}";
            using Session.GenClaim claim = session.Claim();
            claim.LocalClaimInterrupt.Cancel();
            await T2IEngine.CreateImageTask(input, "spoke-workflow-gate-test", claim, _ => outputCount++,
                message => error = message, false, 0.01f, (_, _) => saveCount++, false);
            Assert.That(error, Is.EqualTo("Spoke mode does not accept custom Comfy workflows. Use standard hub generation parameters."),
                workflowParameter);
        }
        Assert.That(outputCount, Is.Zero);
        Assert.That(saveCount, Is.Zero);
    }

    /// <summary>Confirms controller elevation requires an exact configured authorization value in active spoke mode.</summary>
    [Test]
    public static void TestSpokeControllerAuthorizationIsExact()
    {
        const string required = "Bearer controller-secret";

        Assert.That(BasicAPIFeatures.IsAuthorizedSpokeControllerRequest(true, true, required, required), Is.True);
        Assert.That(BasicAPIFeatures.IsAuthorizedSpokeControllerRequest(false, true, required, required), Is.False);
        Assert.That(BasicAPIFeatures.IsAuthorizedSpokeControllerRequest(true, false, required, required), Is.False);
        Assert.That(BasicAPIFeatures.IsAuthorizedSpokeControllerRequest(true, true, "", ""), Is.False);
        Assert.That(BasicAPIFeatures.IsAuthorizedSpokeControllerRequest(true, true, "   ", "   "), Is.False);
        Assert.That(BasicAPIFeatures.IsAuthorizedSpokeControllerRequest(true, true, required, null), Is.False);
        Assert.That(BasicAPIFeatures.IsAuthorizedSpokeControllerRequest(true, true, required, "bearer controller-secret"), Is.False);
        Assert.That(BasicAPIFeatures.IsAuthorizedSpokeControllerRequest(true, true, required, required + " "), Is.False);
    }

    /// <summary>Confirms ordinary spoke sessions can read status but cannot invoke any state-changing API.</summary>
    [Test]
    public static void TestSpokeApiMutationRequiresController()
    {
        Assert.That(API.IsSpokeRequestAuthorized(true, false, false), Is.True);
        Assert.That(API.IsSpokeRequestAuthorized(true, true, false), Is.False);
        Assert.That(API.IsSpokeRequestAuthorized(true, true, true), Is.True);
        Assert.That(API.IsSpokeRequestAuthorized(false, true, false), Is.True);
    }

    /// <summary>Confirms model-path refresh coupling cannot be bypassed with alternate setting-key casing.</summary>
    [Test]
    public static void TestModelPathRefreshTriggerIsCaseInsensitive()
    {
        Assert.That(AdminAPI.IsModelPathAffectingSetting("paths.modelroot"), Is.True);
        Assert.That(AdminAPI.IsModelPathAffectingSetting("Paths.ModelRoot"), Is.True);
        Assert.That(AdminAPI.IsModelPathAffectingSetting("PATHS.MODELROOT"), Is.True);
        Assert.That(AdminAPI.IsModelPathAffectingSetting("Performance.AllowGPUSpecific"), Is.True);
        Assert.That(AdminAPI.IsModelPathAffectingSetting("network.port"), Is.False);
    }

    /// <summary>Confirms a transient controller session cannot be picked up by periodic persistence after creation.</summary>
    [Test]
    public static void TestTransientSessionRetainsNonpersistentFlag()
    {
        SessionHandler handler = RuntimeHelpers.GetUninitializedObject(typeof(SessionHandler)) as SessionHandler;
        handler.SessionIDLength = 40;
        handler.Sessions = [];
        handler.Users = [];
        handler.Roles = [];
        handler.DBLock = new();
        User user = new(handler, new User.DatabaseEntry()
        {
            ID = "spoke-controller-test",
            RawSettings = "\n"
        });
        handler.Users[user.UserID] = user;

        Session session = handler.CreateSession("hostile-test", user.UserID, persist: false);

        Assert.That(session.Persist, Is.False);
        Assert.That(handler.Sessions[session.ID], Is.SameAs(session));
        Assert.That(user.CurrentSessions[session.ID], Is.SameAs(session));

        session.IsSpokeController = true;
        session.LastUsedTime = Environment.TickCount64 - 1000;
        handler.MaxSpokeControllerSessionAge = TimeSpan.Zero;
        Assert.That(handler.CleanExpiredSpokeControllerSessions(), Is.EqualTo(1));
        Assert.That(handler.Sessions.ContainsKey(session.ID), Is.False);
        Assert.That(user.CurrentSessions.ContainsKey(session.ID), Is.False);
    }

    /// <summary>Confirms direct Comfy prompt aliases cannot evade security checks through case, query text, or slashes.</summary>
    [Test]
    public static void TestDirectComfyRouteNormalization()
    {
        Assert.That(ComfyUIRedirectHelper.NormalizeDirectRoutePath("prompt"), Is.EqualTo("prompt"));
        Assert.That(ComfyUIRedirectHelper.NormalizeDirectRoutePath("/prompt/"), Is.EqualTo("prompt"));
        Assert.That(ComfyUIRedirectHelper.NormalizeDirectRoutePath("prompt/?client_id=test"), Is.EqualTo("prompt"));
        Assert.That(ComfyUIRedirectHelper.NormalizeDirectRoutePath("api/prompt?client_id=test"), Is.EqualTo("api/prompt"));
        Assert.That(ComfyUIRedirectHelper.NormalizeDirectRoutePath("/API/Prompt/?client_id=test"), Is.EqualTo("api/prompt"));
        Assert.That(ComfyUIRedirectHelper.NormalizeDirectRoutePath(null), Is.Empty);
        Assert.That(ComfyUIRedirectHelper.IsSpokeDirectRequestAllowed("GET", "object_info", false), Is.True);
        Assert.That(ComfyUIRedirectHelper.IsSpokeDirectRequestAllowed("get", "/API/Object_Info/?x=1", false), Is.True);
        Assert.That(ComfyUIRedirectHelper.IsSpokeDirectRequestAllowed("POST", "object_info", false), Is.False);
        Assert.That(ComfyUIRedirectHelper.IsSpokeDirectRequestAllowed("GET", "object_info", true), Is.False);
        Assert.That(ComfyUIRedirectHelper.IsSpokeDirectRequestAllowed("POST", "manager/install", false), Is.False);
        Assert.That(ComfyUIRedirectHelper.IsSpokeDirectRequestAllowed("GET", "", false), Is.False);
        Assert.That(ComfyUIAPIBackend.IsLoopbackAddress("http://localhost:8188"), Is.True);
        Assert.That(ComfyUIAPIBackend.IsLoopbackAddress("http://127.0.0.1:8188"), Is.True);
        Assert.That(ComfyUIAPIBackend.IsLoopbackAddress("http://[::1]:8188"), Is.True);
        Assert.That(ComfyUIAPIBackend.IsLoopbackAddress("http://0.0.0.0:8188"), Is.False);
        Assert.That(ComfyUIAPIBackend.IsLoopbackAddress("http://192.0.2.10:8188"), Is.False);
        string listenerArgs = ComfyUISelfStartBackend.ApplySpokeLoopbackListener("--listen 0.0.0.0 --port 8188", true);
        Assert.That(listenerArgs, Does.EndWith("--listen 127.0.0.1"));
        Assert.That(listenerArgs.LastIndexOf("--listen", StringComparison.Ordinal),
            Is.GreaterThan(listenerArgs.IndexOf("--listen", StringComparison.Ordinal)));
        Assert.That(ComfyUISelfStartBackend.ApplySpokeLoopbackListener("--port 8188", false), Is.EqualTo("--port 8188"));
    }

    /// <summary>Confirms scalar fields are type-strict and negative counters fail closed.</summary>
    [Test]
    public static void TestCompactInventoryRejectsWrongScalarTypes()
    {
        (string Field, JToken Value)[] mutations =
        [
            ("version", new JValue("1")),
            ("model_edit_id", new JValue(-1)),
            ("allow_remote", new JValue("true")),
            ("complete", new JValue(1)),
            ("parameter_count", new JValue(2.0))
        ];
        foreach ((string field, JToken value) in mutations)
        {
            JObject inventory = ValidInventory();
            inventory[field] = value;
            Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(inventory), field);
        }
    }

    /// <summary>Confirms ordered identity arrays reject duplicates, reordering, blank values, and aggregate-count lies.</summary>
    [Test]
    public static void TestCompactInventoryRejectsNonDeterministicIdentityData()
    {
        JObject inventory = ValidInventory();
        inventory["parameter_ids"] = new JArray("width", "height");
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(inventory), "parameter order");

        inventory = ValidInventory();
        inventory["parameter_ids"] = new JArray("height", "height");
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(inventory), "duplicate parameter");

        inventory = ValidInventory();
        inventory["subtypes"]["LoRA"]["names"] = new JArray("alpha.safetensors", "alpha.safetensors");
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(inventory), "duplicate model");

        inventory = ValidInventory();
        inventory["subtypes"]["LoRA"]["names"] = new JArray("", "folder/bravo.safetensors");
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(inventory), "blank model");

        inventory = ValidInventory();
        inventory["total"] = 4;
        inventory["returned"] = 4;
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(inventory), "aggregate counts");
    }

    /// <summary>Confirms subtype ordering and exact subtype parity are part of the inventory contract.</summary>
    [Test]
    public static void TestCompactInventoryRejectsSubtypeOrderAndExtras()
    {
        JObject inventory = ValidInventory();
        JObject originalSubtypes = inventory["subtypes"] as JObject;
        inventory["subtypes"] = new JObject(
            new JProperty("Stable-Diffusion", originalSubtypes["Stable-Diffusion"].DeepClone()),
            new JProperty("LoRA", originalSubtypes["LoRA"].DeepClone()));
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(inventory), "subtype order");

        inventory = ValidInventory();
        inventory["subtype_count"] = 3;
        inventory["subtypes"]["VAE"] = new JObject()
        {
            ["complete"] = true,
            ["scan_succeeded"] = true,
            ["total"] = 0,
            ["returned"] = 0,
            ["truncated"] = false,
            ["names"] = new JArray()
        };
        Assert.Throws<SwarmReadableErrorException>(() => ParseInventory(inventory), "extra subtype");
    }

    /// <summary>Confirms non-real children retain both handler and Swarm parent links and refuse incomplete inventory.</summary>
    [Test]
    public static void TestNonrealSwarmChildRetainsParentAndFailsClosed()
    {
        BackendHandler handler = new();
        BackendHandler.BackendType queuedSwarmType = handler.SwarmBackendType with { CanLoadFast = false };
        SwarmSwarmBackend parentBackend = new()
        {
            RemoteInventoryReady = false
        };
        BackendHandler.T2IBackendData parentData = new()
        {
            Backend = parentBackend,
            ID = 23
        };
        parentBackend.BackendData = parentData;

        BackendHandler.T2IBackendData childData = handler.AddNewNonrealBackend(queuedSwarmType, parentData,
            new SwarmSwarmBackend.SwarmSwarmBackendSettings(), data =>
            {
                SwarmSwarmBackend child = data.AbstractBackend as SwarmSwarmBackend;
                child.LinkedRemoteBackendID = 41;
                child.LinkedRemoteBackendType = "hostile-test-backend";
                child.Parent = parentBackend;
                parentBackend.ControlledNonrealBackends.TryAdd(41, data as BackendHandler.T2IBackendData);
            }) as BackendHandler.T2IBackendData;
        SwarmSwarmBackend childBackend = childData.Backend as SwarmSwarmBackend;

        Assert.That(childData.Parent, Is.SameAs(parentData));
        Assert.That(childData.AbstractParent, Is.SameAs(parentData));
        Assert.That(childBackend.Parent, Is.SameAs(parentBackend));
        Assert.That(childBackend.IsReal, Is.False);

        MethodInfo setInventoryStatus = typeof(SwarmSwarmBackend).GetMethod(
            "SetRemoteInventoryStatus", BindingFlags.Instance | BindingFlags.NonPublic);
        setInventoryStatus.Invoke(parentBackend, [BackendStatus.ERRORED, null]);
        Assert.That(parentBackend.Status, Is.EqualTo(BackendStatus.ERRORED));
        Assert.That(childBackend.Status, Is.EqualTo(BackendStatus.ERRORED));
        setInventoryStatus.Invoke(parentBackend, [BackendStatus.RUNNING, null]);

        T2IParamInput blockedInput = new(null);
        Assert.That(childBackend.IsValidForThisBackend(blockedInput), Is.False);
        Assert.That(blockedInput.RefusalReasons, Does.Contain("Remote model inventory is not complete."));

        parentBackend.RemoteInventoryReady = true;
        T2IParamInput allowedInput = new(null);
        Assert.That(childBackend.IsValidForThisBackend(allowedInput), Is.True);

        parentData.TimeLastRelease = 0;
        childData.TimeLastRelease = 0;
        using (T2IBackendAccess access = new(childData))
        {
            Assert.That(childData.Usages, Is.EqualTo(1));
        }
        Assert.That(childData.Usages, Is.Zero);
        Assert.That(childData.TimeLastRelease, Is.GreaterThan(0));
        Assert.That(parentData.TimeLastRelease, Is.GreaterThanOrEqualTo(childData.TimeLastRelease));
    }

    /// <summary>Confirms session renewal cannot reconnect a removed or shutting-down Swarm backend.</summary>
    [Test]
    public static void TestSwarmSessionRenewalHonorsLifecycle()
    {
        SwarmSwarmBackend backend = new()
        {
            ShutDownReserve = true,
            Status = BackendStatus.IDLE
        };
        Assert.ThrowsAsync<SwarmReadableErrorException>(async () => await backend.ValidateAndBuild());

        backend.ShutDownReserve = false;
        backend.Status = BackendStatus.DISABLED;
        Assert.ThrowsAsync<SwarmReadableErrorException>(async () => await backend.ValidateAndBuild());
    }
}
