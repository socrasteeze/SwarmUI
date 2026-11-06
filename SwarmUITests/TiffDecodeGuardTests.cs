using ImageMagick;
using NUnit.Framework;
using SwarmUI.Builtin_TiffDecodeGuardExtension;

namespace SwarmUITests;

/// <summary>Tests that the TIFF decode guard recognizes TIFF headers and refuses them only after it is applied. Header checks do not decode the file.</summary>
[TestFixture]
public class TiffDecodeGuardTests
{
    /// <summary>Classic TIFF and BigTIFF headers are recognized, and a PNG header is not.</summary>
    [Test]
    public void TiffHeader_RecognizesClassicAndBigTiff()
    {
        byte[] little = [0x49, 0x49, 0x2A, 0x00];
        byte[] big = [0x4D, 0x4D, 0x00, 0x2A];
        byte[] littleBigTiff = [0x49, 0x49, 0x2B, 0x00];
        byte[] bigBigTiff = [0x4D, 0x4D, 0x00, 0x2B];
        byte[] png = [0x89, 0x50, 0x4E, 0x47];
        Assert.That(TiffDecodeGuardExtension.HasTiffHeader(little), Is.True);
        Assert.That(TiffDecodeGuardExtension.HasTiffHeader(big), Is.True);
        Assert.That(TiffDecodeGuardExtension.HasTiffHeader(littleBigTiff), Is.True);
        Assert.That(TiffDecodeGuardExtension.HasTiffHeader(bigBigTiff), Is.True);
        Assert.That(TiffDecodeGuardExtension.HasTiffHeader(png), Is.False);
        Assert.That(TiffDecodeGuardExtension.HasTiffHeader([0x49, 0x49]), Is.False);
    }

    /// <summary>The guard blocks TIFF only while it is active, and it leaves PNG bytes alone.</summary>
    [Test]
    public void Blocks_OnlyWhenActive()
    {
        byte[] tiff = [0x49, 0x49, 0x2A, 0x00];
        byte[] png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        bool prior = TiffDecodeGuardExtension.Active;
        try
        {
            TiffDecodeGuardExtension.Active = false;
            Assert.That(TiffDecodeGuardExtension.Blocks(tiff), Is.False);
            TiffDecodeGuardExtension.Active = true;
            Assert.That(TiffDecodeGuardExtension.Blocks(tiff), Is.True);
            Assert.That(TiffDecodeGuardExtension.Blocks(png), Is.False);
        }
        finally
        {
            TiffDecodeGuardExtension.Active = prior;
        }
    }

    /// <summary>Control: with the guard inactive, ImageMagick can still decode a TIFF, so a later refusal is the guard.</summary>
    [Test]
    public void TiffDecodes_WithoutGuard()
    {
        Assert.That(TiffDecodeGuardExtension.Active, Is.False, "This process must not unregister TIFF before the browser conversion test.");
        using MagickImage source = new(MagickColors.Red, 2, 2);
        byte[] data = source.ToByteArray(MagickFormat.Tiff);
        Assert.That(TiffDecodeGuardExtension.HasTiffHeader(data), Is.True);
        using MagickImage image = new(data);
        Assert.That(image.Width, Is.EqualTo(2));
    }
}
