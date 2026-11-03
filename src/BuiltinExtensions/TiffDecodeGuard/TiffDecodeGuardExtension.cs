using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats;
using SixLabors.ImageSharp.Formats.Tiff;
using SixLabors.ImageSharp.PixelFormats;
using SwarmUI.Core;
using System.IO;
using System.Threading;

namespace SwarmUI.Builtin_TiffDecodeGuardExtension;

/// <summary>Fork-owned extension that refuses TIFF decoding, which blocks the TIFF decoder advisories against the pinned ImageSharp 3.1.12 (GHSA-v76p-62qx-wwq2, GHSA-wmxv-xphr-5c9g).
/// <para>shortcut: TIFF inputs stop working, delete this extension after moving to ImageSharp 3.2.0, whose build needs a Six Labors license key.</para></summary>
public class TiffDecodeGuardExtension : Extension
{
    /// <inheritdoc/>
    public override void OnPreInit()
    {
        Apply(Configuration.Default);
    }

    /// <summary>Replaces the TIFF decoder of the given configuration with one that refuses all input.</summary>
    public static void Apply(Configuration config)
    {
        config.ImageFormatsManager.SetDecoder(TiffFormat.Instance, new RefusingDecoder());
    }

    /// <summary>Image decoder that refuses all input without parsing it.</summary>
    public class RefusingDecoder : ImageDecoder
    {
        /// <summary>Builds the error thrown for all input. This is the exception type callers already handle for an unknown format.</summary>
        public static UnknownImageFormatException Refusal()
        {
            return new("TIFF images are disabled on this server.");
        }

        /// <inheritdoc/>
        protected override Image<TPixel> Decode<TPixel>(DecoderOptions options, Stream stream, CancellationToken cancellationToken)
        {
            throw Refusal();
        }

        /// <inheritdoc/>
        protected override Image Decode(DecoderOptions options, Stream stream, CancellationToken cancellationToken)
        {
            throw Refusal();
        }

        /// <inheritdoc/>
        protected override ImageInfo Identify(DecoderOptions options, Stream stream, CancellationToken cancellationToken)
        {
            throw Refusal();
        }
    }
}
