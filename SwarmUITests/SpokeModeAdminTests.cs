using Newtonsoft.Json.Linq;
using NUnit.Framework;
using SwarmUI.Core;
using SwarmUI.WebAPI;
using System.Reflection;
using System.Threading.Tasks;

namespace SwarmUITests;

/// <summary>Tests runtime-only spoke settings metadata and admin mutation refusals.</summary>
[TestFixture]
[NonParallelizable]
public class SpokeModeAdminTests : SwarmUITest
{
    /// <summary>Prepares shared test primitives.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
        Program.Web ??= new WebServer();
    }

    /// <summary>Restores normal runtime mode after every test.</summary>
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

    /// <summary>Confirms the synthetic spoke group reports runtime state without becoming a writable server setting.</summary>
    [Test]
    public static async Task TestSpokeSettingsGroupIsRuntimeOnly()
    {
        SetSpokeMode(false);
        JObject response = await AdminAPI.ListServerSettings(null);
        JObject settings = response["settings"] as JObject;
        JObject spoke = settings["spoke"] as JObject;
        JObject enabled = spoke["value"]["enabled"] as JObject;

        Assert.That((string)spoke["name"], Is.EqualTo("Spoke"));
        Assert.That((string)spoke["description"], Is.EqualTo("Runtime profile inactive"));
        Assert.That((bool)enabled["value"], Is.False);
        Assert.That((bool)enabled["read_only"], Is.True);
        Assert.That(Program.ServerSettings.TryGetFieldInternalData("spoke.enabled", out _), Is.Null);

        JObject mutation = await AdminAPI.ChangeServerSettings(null, new JObject()
        {
            ["settings"] = new JObject() { ["spoke.enabled"] = true }
        });
        Assert.That((string)mutation["error_id"], Is.EqualTo("spoke_runtime_only"));
    }

    /// <summary>Confirms spoke mode marks server settings read-only and blocks every remaining admin mutation route.</summary>
    [Test]
    public static async Task TestSpokeAdminMutationsFailBeforeSideEffects()
    {
        SetSpokeMode(true);
        JObject response = await AdminAPI.ListServerSettings(null);
        JObject settings = response["settings"] as JObject;
        JObject spoke = settings["spoke"] as JObject;

        Assert.That((string)spoke["description"], Is.EqualTo("Runtime profile active"));
        Assert.That((bool)spoke["value"]["enabled"]["value"], Is.True);
        Assert.That((bool)settings["network"]["value"]["host"]["read_only"], Is.True);

        JObject[] refusals =
        [
            await AdminAPI.ChangeServerSettings(null, new JObject() { ["settings"] = new JObject() }),
            await AdminAPI.UpdateAndRestart(null, new JObject()),
            await AdminAPI.InstallExtension(null, "test"),
            await AdminAPI.UpdateExtension(null, "test"),
            await AdminAPI.UninstallExtension(null, "test"),
            await AdminAPI.SetExtensionEnabled(null, "test", true),
            await AdminAPI.InstallDotnetUpdate(null)
        ];
        foreach (JObject refusal in refusals)
        {
            Assert.That((string)refusal["error_id"], Is.EqualTo("spoke_read_only"));
        }
    }
}
