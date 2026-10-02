using NUnit.Framework;
using SixLabors.ImageSharp;
using SwarmUI.Accounts;
using SwarmUI.Builtin_MobileEnhancementsExtension;
using System;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using ISImage = SixLabors.ImageSharp.Image<SixLabors.ImageSharp.PixelFormats.Rgba32>;

namespace SwarmUITests;

/// <summary>Tests the server filesystem image browser's bounded, non-recursive behavior.</summary>
[TestFixture]
public class SimpleImageBrowserTests : SwarmUITest
{
    /// <summary>Temporary filesystem root for the current test.</summary>
    private string TempRoot;

    /// <summary>Prepares the shared SwarmUI test state.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>Creates a fresh root before each test.</summary>
    [SetUp]
    public void SetupTempRoot()
    {
        TempRoot = Path.Combine(Path.GetTempPath(), $"swarm-simple-browser-{Guid.NewGuid():N}");
        Directory.CreateDirectory(TempRoot);
    }

    /// <summary>Removes the fresh root after each test.</summary>
    [TearDown]
    public void CleanupTempRoot()
    {
        try
        {
            Directory.Delete(TempRoot, true);
        }
        catch (Exception)
        {
            // A locked throwaway directory must not hide the primary assertion failure.
        }
    }

    /// <summary>Creates a valid small PNG file.</summary>
    private static byte[] WriteValidPng(string path, int width = 8, int height = 4)
    {
        using ISImage image = new(width, height);
        using MemoryStream data = new();
        image.SaveAsPng(data);
        byte[] bytes = data.ToArray();
        File.WriteAllBytes(path, bytes);
        return bytes;
    }

    /// <summary>Folder results are direct children, deterministic, filtered, and paged over folders then files.</summary>
    [Test]
    public void ListFolder_SortsFiltersAndPagesDirectChildren()
    {
        Directory.CreateDirectory(Path.Combine(TempRoot, "beta"));
        Directory.CreateDirectory(Path.Combine(TempRoot, "Alpha"));
        Directory.CreateDirectory(Path.Combine(TempRoot, "Alpha", "nested"));
        WriteValidPng(Path.Combine(TempRoot, "zeta.png"));
        WriteValidPng(Path.Combine(TempRoot, "Bravo.PNG"));
        File.WriteAllText(Path.Combine(TempRoot, "notes.txt"), "not an image");

        Newtonsoft.Json.Linq.JObject first = SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 3);
        Newtonsoft.Json.Linq.JObject second = SimpleImageBrowserAPI.ListFolder(TempRoot, 3, 3);

        Assert.That((int)first["total"], Is.EqualTo(4));
        Assert.That((int)first["next_offset"], Is.EqualTo(3));
        Assert.That(first["folders"].Select(row => (string)row["name"]), Is.EqualTo(new[] { "Alpha", "beta" }));
        Assert.That(first["files"].Select(row => (string)row["name"]), Is.EqualTo(new[] { "Bravo.PNG" }));
        Assert.That(second["folders"].Count(), Is.EqualTo(0));
        Assert.That(second["files"].Select(row => (string)row["name"]), Is.EqualTo(new[] { "zeta.png" }));
        Assert.That(second["next_offset"].Type, Is.EqualTo(Newtonsoft.Json.Linq.JTokenType.Null));
        Assert.That((string)first["parent"], Is.EqualTo(Directory.GetParent(Path.GetFullPath(TempRoot))?.FullName));
        Assert.That((string)SimpleImageBrowserAPI.ListFolder(TempRoot, -1, 1)["error_id"], Is.EqualTo("bad_page"));
        Assert.That((string)SimpleImageBrowserAPI.ListFolder(TempRoot, 0, 0)["error_id"], Is.EqualTo("bad_page"));
        Assert.That(SimpleImageBrowserAPI.ListFolder(TempRoot, int.MaxValue, 100)["next_offset"].Type, Is.EqualTo(Newtonsoft.Json.Linq.JTokenType.Null));
        Assert.That(SimpleImageBrowserAPI.ListFolder("", 0, 1)["parent"].Type, Is.EqualTo(Newtonsoft.Json.Linq.JTokenType.Null));
    }

    /// <summary>Invalid, relative, stream, missing, and oversized paths fail without returning source data.</summary>
    [Test]
    public void ReadImage_RejectsUnsafeAndInvalidInputs()
    {
        string corrupt = Path.Combine(TempRoot, "corrupt.png");
        string large = Path.Combine(TempRoot, "large.png");
        string imageDirectory = Path.Combine(TempRoot, "directory.png");
        File.WriteAllText(corrupt, "not an image");
        Directory.CreateDirectory(imageDirectory);
        using (FileStream stream = new(large, FileMode.CreateNew, FileAccess.Write))
        {
            stream.SetLength(SimpleImageBrowserAPI.MaximumImageBytes + 1);
        }

        Assert.That((string)SimpleImageBrowserAPI.ReadImage("relative.png", false)["error_id"], Is.EqualTo("bad_path"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage(corrupt + ":stream", false)["error_id"], Is.EqualTo("bad_path"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage("//?/C:/bypass.png", false)["error_id"], Is.EqualTo("bad_path"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage(Path.Combine(TempRoot, "notes.txt"), false)["error_id"], Is.EqualTo("bad_path"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage(imageDirectory, false)["error_id"], Is.EqualTo("missing_image"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage(Path.Combine(TempRoot, "missing.png"), false)["error_id"], Is.EqualTo("missing_image"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage(corrupt, false)["error_id"], Is.EqualTo("unsupported_image"));
        Assert.That((string)SimpleImageBrowserAPI.ReadImage(large, false)["error_id"], Is.EqualTo("image_too_large"));
        Assert.That((string)SimpleImageBrowserAPI.ListFolder(Path.Combine(TempRoot, "missing"), 0, 10)["error_id"], Is.EqualTo("missing_folder"));
    }

    /// <summary>Full reads preserve valid source bytes and previews are decodable JPEG data URIs.</summary>
    [Test]
    public void ReadImage_ReturnsOriginalBytesAndJpegPreview()
    {
        string path = Path.Combine(TempRoot, "valid.png");
        byte[] expected = WriteValidPng(path, 1024, 512);

        string original = (string)SimpleImageBrowserAPI.ReadImage(path, false)["image"];
        string preview = (string)SimpleImageBrowserAPI.ReadImage(path, true)["image"];
        byte[] originalBytes = Convert.FromBase64String(original.Split(',')[1]);
        byte[] previewBytes = Convert.FromBase64String(preview.Split(',')[1]);

        Assert.That(original.StartsWith("data:image/png;base64,", StringComparison.Ordinal), Is.True);
        Assert.That(originalBytes, Is.EqualTo(expected));
        Assert.That(preview.StartsWith("data:image/jpeg;base64,", StringComparison.Ordinal), Is.True);
        using SixLabors.ImageSharp.Image previewImage = SixLabors.ImageSharp.Image.Load(previewBytes);
        Assert.That(previewImage.Width, Is.LessThanOrEqualTo(256));
        Assert.That(previewImage.Height, Is.LessThanOrEqualTo(256));
        Assert.That(previewImage.Width, Is.EqualTo(256));
        Assert.That(previewImage.Height, Is.EqualTo(128));
    }

    /// <summary>Direct API entry points deny callers before they inspect a path.</summary>
    [Test]
    public async System.Threading.Tasks.Task Api_DeniesUsersWithoutBrowsePermission()
    {
        User user = RuntimeHelpers.GetUninitializedObject(typeof(User)) as User;
        user.CalculatedRole = new Role("browser-test");
        Session session = new() { User = user };

        Newtonsoft.Json.Linq.JObject readDenied = await SimpleImageBrowserAPI.ReadSimpleImage(session, Path.Combine(TempRoot, "never-read.png"));
        Newtonsoft.Json.Linq.JObject listDenied = await SimpleImageBrowserAPI.ListSimpleImageFolder(session, TempRoot);
        Newtonsoft.Json.Linq.JObject nullReadDenied = await SimpleImageBrowserAPI.ReadSimpleImage(null, Path.Combine(TempRoot, "never-read.png"));
        Newtonsoft.Json.Linq.JObject nullListDenied = await SimpleImageBrowserAPI.ListSimpleImageFolder(null, TempRoot);

        Assert.That((string)readDenied["error_id"], Is.EqualTo("bad_permissions"));
        Assert.That((string)listDenied["error_id"], Is.EqualTo("bad_permissions"));
        Assert.That((string)nullReadDenied["error_id"], Is.EqualTo("bad_permissions"));
        Assert.That((string)nullListDenied["error_id"], Is.EqualTo("bad_permissions"));
    }
}
