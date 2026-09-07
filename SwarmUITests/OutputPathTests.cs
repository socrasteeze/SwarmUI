using NUnit.Framework;
using SwarmUI.Accounts;
using SwarmUI.Utils;

namespace SwarmUITests;

/// <summary>Tests the output-path build fixes: <see cref="User.ClampOutPathDepth(string, int)"/> (enforcing the previously-dead
/// 'MaxOutPathDepth' role setting), and <see cref="Utilities.StrictFilenameCleanKeepDots(string)"/> as used for the final output-path
/// clean in <see cref="User.BuildImageOutputPath(SwarmUI.Text2Image.T2IParamInput, int)"/> (keeping interior dots like a 'v1.0' prefix
/// while still rejecting '..' traversal, leading/trailing dots, and reserved Windows device names).</summary>
[TestFixture]
public class OutputPathTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    // ---- User.ClampOutPathDepth ----

    /// <summary>A path within the depth limit is returned unchanged.</summary>
    [Test]
    public static void TestClampOutPathDepth_WithinLimit()
    {
        Assert.That(User.ClampOutPathDepth("a/b/c/file", 5), Is.EqualTo("a/b/c/file"));
    }

    /// <summary>A path exactly at the depth limit is returned unchanged.</summary>
    [Test]
    public static void TestClampOutPathDepth_ExactlyAtLimit()
    {
        Assert.That(User.ClampOutPathDepth("a/b/c/d/e/file", 5), Is.EqualTo("a/b/c/d/e/file"));
    }

    /// <summary>A path one directory over the default (5) limit collapses its excess directories into one, rather than being rejected.</summary>
    [Test]
    public static void TestClampOutPathDepth_OverLimitCollapses()
    {
        Assert.That(User.ClampOutPathDepth("a/b/c/d/e/f/file", 5), Is.EqualTo("a/b/c/d/e_f/file"));
    }

    /// <summary>A path many directories over the limit still collapses to exactly the limit, joining every excess directory into one segment.</summary>
    [Test]
    public static void TestClampOutPathDepth_FarOverLimitCollapsesToOneSegment()
    {
        Assert.That(User.ClampOutPathDepth("a/b/c/d/e/f/g/h/file", 2), Is.EqualTo("a/b_c_d_e_f_g_h/file"));
    }

    /// <summary>A limit of 0 drops all directory nesting entirely and keeps only the filename.</summary>
    [Test]
    public static void TestClampOutPathDepth_ZeroLimitDropsAllDirectories()
    {
        Assert.That(User.ClampOutPathDepth("a/b/file", 0), Is.EqualTo("file"));
    }

    /// <summary>A negative limit (should never occur from config, but must not misbehave) is clamped to 0 rather than throwing or
    /// producing a negative-count range.</summary>
    [Test]
    public static void TestClampOutPathDepth_NegativeLimitClampsToZero()
    {
        Assert.That(() => User.ClampOutPathDepth("a/b/file", -3), Throws.Nothing);
        Assert.That(User.ClampOutPathDepth("a/b/file", -3), Is.EqualTo("file"));
    }

    /// <summary>A bare filename with no directories at all is returned unchanged regardless of the limit, including a limit of 0.</summary>
    [Test]
    public static void TestClampOutPathDepth_BareFilenameUnaffected()
    {
        Assert.That(User.ClampOutPathDepth("file", 5), Is.EqualTo("file"));
        Assert.That(User.ClampOutPathDepth("file", 0), Is.EqualTo("file"));
    }

    /// <summary>Empty segments from doubled-up slashes do not count as real directories, so they cannot be used to inflate the
    /// apparent depth or leak into the collapsed segment.</summary>
    [Test]
    public static void TestClampOutPathDepth_EmptySegmentsNotCounted()
    {
        Assert.That(User.ClampOutPathDepth("a//b/file", 1), Is.EqualTo("a_b/file"));
    }

    /// <summary>A user-supplied prefix cannot itself increase directory depth beyond the limit - simulating the fork's insertion
    /// (prefix glued onto the filename segment, contributing zero extra '/' characters) followed by the depth clamp, on a path that
    /// is already at the limit before the prefix is added.</summary>
    [Test]
    public static void TestClampOutPathDepth_AfterPrefixInsertionStillEnforced()
    {
        string path = User.InsertFilenamePrefix("a/b/c/d/e/f/file", "OC01", 40);
        Assert.That(path, Is.EqualTo("a/b/c/d/e/f/OC01file"));
        Assert.That(User.ClampOutPathDepth(path, 5), Is.EqualTo("a/b/c/d/e_f/OC01file"));
    }

    /// <summary>Backslashes count as directory separators too. The outpath format is raw user text ('Override Outpath Format' has no
    /// Clean callback) and the final clean rewrites '\' to '/', so a backslash-written format must not be able to skip the limit.</summary>
    [Test]
    public static void TestClampOutPathDepth_BackslashSeparatorsCounted()
    {
        Assert.That(User.ClampOutPathDepth(@"a\b\c\d\e\f\file", 5), Is.EqualTo("a/b/c/d/e_f/file"));
        Assert.That(User.ClampOutPathDepth(@"a/b\c/d\e/f\file", 5), Is.EqualTo("a/b/c/d/e_f/file"));
        // And the clamp is what actually holds: without it, the final clean would turn this into a 6-deep path.
        Assert.That(Utilities.StrictFilenameCleanKeepDots(@"a\b\c\d\e\f\file").Split('/').Length - 1, Is.EqualTo(6));
        Assert.That(Utilities.StrictFilenameCleanKeepDots(User.ClampOutPathDepth(@"a\b\c\d\e\f\file", 5)).Split('/').Length - 1, Is.EqualTo(5));
    }

    /// <summary>A within-limit path is returned byte-identical, original separators and all - the clamp only rewrites when it must.</summary>
    [Test]
    public static void TestClampOutPathDepth_WithinLimitLeavesSeparatorsAlone()
    {
        Assert.That(User.ClampOutPathDepth(@"a\b\file", 5), Is.EqualTo(@"a\b\file"));
    }

    // ---- Utilities.StrictFilenameCleanKeepDots, as used for the final output-path clean ----

    /// <summary>The fix under test: a path containing an interior-dot segment (eg a 'v1.0' prefix stitched onto a filename) survives
    /// the final output-path clean intact, where plain <see cref="Utilities.StrictFilenameClean(string)"/> would have stripped the dot
    /// and turned it into 'v10'.</summary>
    [Test]
    public static void TestFinalPathClean_KeepsInteriorDot()
    {
        Assert.That(Utilities.StrictFilenameCleanKeepDots("model/OC01v1.0-2026"), Is.EqualTo("model/OC01v1.0-2026"));
        Assert.That(Utilities.StrictFilenameClean("model/OC01v1.0-2026"), Is.EqualTo("model/OC01v10-2026"));
    }

    /// <summary>The final path clean still collapses '..' runs, so directory traversal via dots cannot survive even though interior
    /// dots are now kept.</summary>
    [Test]
    public static void TestFinalPathClean_RejectsTraversal()
    {
        Assert.That(Utilities.StrictFilenameCleanKeepDots("model/../secret").Contains(".."), Is.False);
        Assert.That(Utilities.StrictFilenameCleanKeepDots("model/../secret"), Is.EqualTo("model/secret"));
    }

    /// <summary>The final path clean still trims leading and trailing dots per segment, so a segment cannot be a bare '.' or hide
    /// itself behind a leading dot.</summary>
    [Test]
    public static void TestFinalPathClean_TrimsEdgeDots()
    {
        Assert.That(Utilities.StrictFilenameCleanKeepDots("model/.hidden."), Is.EqualTo("model/hidden"));
        Assert.That(Utilities.StrictFilenameCleanKeepDots("model/."), Is.EqualTo("model"));
    }

    /// <summary>The final path clean still guards Windows reserved device names, even with a dot-bearing extension attached.</summary>
    [Test]
    public static void TestFinalPathClean_GuardsReservedNames()
    {
        Assert.That(Utilities.StrictFilenameCleanKeepDots("model/con.txt"), Is.EqualTo("model/con_.txt"));
        Assert.That(Utilities.StrictFilenameCleanKeepDots("con"), Is.EqualTo("con_"));
    }
}
