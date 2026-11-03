using NUnit.Framework;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats;
using SixLabors.ImageSharp.Formats.Png;
using SixLabors.ImageSharp.Formats.Tiff;
using SwarmUI.Builtin_TiffDecodeGuardExtension;
using System.IO;
using ISImage = SixLabors.ImageSharp.Image<SixLabors.ImageSharp.PixelFormats.Rgba32>;

namespace SwarmUITests;

/// <summary>Tests that the TIFF decode guard refuses TIFF and leaves other formats alone. Uses a private configuration, as the guard's target configuration is otherwise process-wide.</summary>
[TestFixture]
public class TiffDecodeGuardTests
{
    /// <summary>Builds decoder options on a new configuration that handles PNG and TIFF.</summary>
    private static DecoderOptions NewOptions()
    {
        return new() { Configuration = new Configuration(new PngConfigurationModule(), new TiffConfigurationModule()) };
    }

    /// <summary>Encodes a small image as TIFF.</summary>
    private static byte[] TiffBytes()
    {
        using ISImage source = new(2, 2);
        using MemoryStream stream = new();
        source.SaveAsTiff(stream);
        return stream.ToArray();
    }

    /// <summary>Control: without the guard the same bytes decode, so the refusal below comes from the guard.</summary>
    [Test]
    public void TiffDecodes_WithoutGuard()
    {
        using SixLabors.ImageSharp.Image image = SixLabors.ImageSharp.Image.Load(NewOptions(), TiffBytes());
        Assert.That(image.Width, Is.EqualTo(2));
    }

    /// <summary>The guard refuses both decoding and identifying a TIFF.</summary>
    [Test]
    public void TiffIsRefused_WithGuard()
    {
        DecoderOptions options = NewOptions();
        TiffDecodeGuardExtension.Apply(options.Configuration);
        byte[] data = TiffBytes();
        Assert.Throws<UnknownImageFormatException>(() => SixLabors.ImageSharp.Image.Load(options, data).Dispose());
        Assert.Throws<UnknownImageFormatException>(() => SixLabors.ImageSharp.Image.Identify(options, data));
    }

    /// <summary>The guard leaves other formats working.</summary>
    [Test]
    public void PngStillDecodes_WithGuard()
    {
        DecoderOptions options = NewOptions();
        TiffDecodeGuardExtension.Apply(options.Configuration);
        using ISImage source = new(2, 2);
        using MemoryStream stream = new();
        source.SaveAsPng(stream);
        using SixLabors.ImageSharp.Image image = SixLabors.ImageSharp.Image.Load(options, stream.ToArray());
        Assert.That(image.Width, Is.EqualTo(2));
    }
}
