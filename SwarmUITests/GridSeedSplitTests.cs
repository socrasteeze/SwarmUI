using NUnit.Framework;
using SwarmUI.Builtin_GridGeneratorExtension;

namespace SwarmUITests;

/// <summary>Random-seed grid cells keep the same image count and do not turn one batch into seed+i.</summary>
[TestFixture]
public class GridSeedSplitTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>The toggle off leaves a batch as one generation.</summary>
    [Test]
    public static void TestToggleOffKeepsOneBatch()
    {
        GridGeneratorExtension.GridCellSeedSplit plan = GridGeneratorExtension.PlanPerImageSeeds(4, false, true, true, true);
        Assert.That(plan.Count, Is.EqualTo(4));
        Assert.That(plan.Separate, Is.False);
        Assert.That(plan.RerollSeed, Is.False);
        Assert.That(plan.RerollVariation, Is.False);
    }

    /// <summary>A random seed splits a batch into that same number of images, not more.</summary>
    [Test]
    public static void TestRandomBatchSplitsWithoutAddingImages()
    {
        GridGeneratorExtension.GridCellSeedSplit plan = GridGeneratorExtension.PlanPerImageSeeds(4, true, true, true, false);
        Assert.That(plan.Count, Is.EqualTo(4));
        Assert.That(plan.Separate, Is.True);
        Assert.That(plan.RerollSeed, Is.True);
        Assert.That(plan.RerollVariation, Is.True);
    }

    /// <summary>One image stays one generation even when the toggle is on.</summary>
    [Test]
    public static void TestSingleImageDoesNotSplit()
    {
        GridGeneratorExtension.GridCellSeedSplit plan = GridGeneratorExtension.PlanPerImageSeeds(1, true, true, true, true);
        Assert.That(plan.Count, Is.EqualTo(1));
        Assert.That(plan.Separate, Is.False);
        Assert.That(plan.RerollSeed, Is.False);
    }

    /// <summary>A fixed seed is not re-rolled. An active -1 variation seed is, still at the same count.</summary>
    [Test]
    public static void TestFixedSeedDoesNotSplitUnlessVariationApplies()
    {
        GridGeneratorExtension.GridCellSeedSplit idle = GridGeneratorExtension.PlanPerImageSeeds(4, true, false, true, false);
        Assert.That(idle.Separate, Is.False);
        Assert.That(idle.Count, Is.EqualTo(4));
        GridGeneratorExtension.GridCellSeedSplit varied = GridGeneratorExtension.PlanPerImageSeeds(4, true, false, true, true);
        Assert.That(varied.Count, Is.EqualTo(4));
        Assert.That(varied.Separate, Is.True);
        Assert.That(varied.RerollSeed, Is.False);
        Assert.That(varied.RerollVariation, Is.True);
    }

    /// <summary>A Seed axis or preset value replaces the locked random. A later -1 is random again.</summary>
    [Test]
    public static void TestConcreteSeedWinsOverTheLockedRandom()
    {
        Assert.That(GridGeneratorExtension.ValueStillAuto(true, true, 99, 5), Is.False);
        Assert.That(GridGeneratorExtension.ValueStillAuto(true, true, 5, 5), Is.True);
        Assert.That(GridGeneratorExtension.ValueStillAuto(false, true, 42, 42), Is.False);
        Assert.That(GridGeneratorExtension.ValueStillAuto(false, true, -1, 42), Is.True);
        Assert.That(GridGeneratorExtension.ValueStillAuto(true, false, 0, 5), Is.False);
    }
}
