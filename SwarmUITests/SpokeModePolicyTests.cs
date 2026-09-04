using NUnit.Framework;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using System;
using System.IO;
using System.Reflection;

namespace SwarmUITests;

/// <summary>Tests spoke-mode model-tree write enforcement and refresh completeness.</summary>
[TestFixture]
[NonParallelizable]
public class SpokeModePolicyTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Restores normal runtime mode after each test.</summary>
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

    /// <summary>Confirms the central write assertion denies spokes and permits normal instances.</summary>
    [Test]
    public static void TestModelTreeWritePolicy()
    {
        SetSpokeMode(true);
        Assert.Throws<SpokeModeWriteException>(() => SpokeModePolicy.AssertModelTreeWriteAllowed("test write"));
        SetSpokeMode(false);
        Assert.DoesNotThrow(() => SpokeModePolicy.AssertModelTreeWriteAllowed("test write"));
    }

    /// <summary>Confirms missing spoke folders are neither created nor reported as a complete refresh.</summary>
    [Test]
    public static void TestMissingSpokeModelFolderFailsRefreshClosed()
    {
        string testRoot = Path.Combine(Path.GetTempPath(), $"swarm-spoke-refresh-{Guid.NewGuid():N}");
        string existing = Path.Combine(testRoot, "existing");
        string missing = Path.Combine(testRoot, "missing");
        Directory.CreateDirectory(existing);
        try
        {
            SetSpokeMode(true);
            T2IModelHandler handler = new()
            {
                ModelType = "Test",
                FolderPaths = [existing, missing]
            };
            T2IModel previousModel = new(handler, existing, Path.Combine(existing, "previous.ckpt"), "previous.ckpt");
            handler.Models[previousModel.Name] = previousModel;
            handler.Refresh();
            Assert.That(handler.LastRefreshSucceeded, Is.False);
            Assert.That(Directory.Exists(missing), Is.False);
            Assert.That(handler.Models[previousModel.Name], Is.SameAs(previousModel));

            handler.FolderPaths = [existing];
            handler.Refresh();
            Assert.That(handler.LastRefreshSucceeded, Is.True);
        }
        finally
        {
            SetSpokeMode(false);
            Directory.Delete(existing);
            Directory.Delete(testRoot);
        }
    }
}
