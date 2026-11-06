using ImageMagick;
using SwarmUI.Core;
using SwarmUI.Utils;

namespace SwarmUI.Builtin_TiffDecodeGuardExtension;

/// <summary>Fork-owned extension that refuses TIFF decoding. ImageSharp is gone; its TIFF decoder advisories (GHSA-v76p-62qx-wwq2, GHSA-wmxv-xphr-5c9g) stay closed because that library is not referenced.
/// <para>TIFF inputs still fail. ImageMagick's TIFF coders are unregistered for the process, and readers check <see cref="Blocks"/> before they decode.</para></summary>
public class TiffDecodeGuardExtension : Extension
{
    /// <summary>True after <see cref="Apply"/> so readers can refuse TIFF without handing the bytes to a decoder.</summary>
    public static volatile bool Active;

    /// <inheritdoc/>
    public override void OnPreInit()
    {
        Apply();
    }

    /// <summary>Refuses TIFF for the rest of this process.</summary>
    public static void Apply()
    {
        Active = true;
        try
        {
            DisableTiffCoders();
        }
        catch (Exception ex)
        {
            Logs.Warning($"TIFF decode guard could not disable an ImageMagick TIFF coder: {ex.Message}");
        }
    }

    /// <summary>True when <paramref name="data"/> is a classic TIFF or BigTIFF header. This reads four bytes and does not decode the file.</summary>
    public static bool HasTiffHeader(ReadOnlySpan<byte> data)
    {
        if (data.Length < 4)
        {
            return false;
        }
        bool little = data[0] == (byte)'I' && data[1] == (byte)'I' && data[2] == 0x2A && data[3] == 0x00;
        bool big = data[0] == (byte)'M' && data[1] == (byte)'M' && data[2] == 0x00 && data[3] == 0x2A;
        bool littleBigTiff = data[0] == (byte)'I' && data[1] == (byte)'I' && data[2] == 0x2B && data[3] == 0x00;
        bool bigBigTiff = data[0] == (byte)'M' && data[1] == (byte)'M' && data[2] == 0x00 && data[3] == 0x2B;
        return little || big || littleBigTiff || bigBigTiff;
    }

    /// <summary>True when TIFF bytes must be rejected before a decoder sees them.</summary>
    public static bool Blocks(ReadOnlySpan<byte> data)
    {
        return Active && HasTiffHeader(data);
    }

    /// <summary>Unregisters every readable ImageMagick format whose MIME type is TIFF.</summary>
    private static void DisableTiffCoders()
    {
        List<MagickFormatInfo> formats = [];
        foreach (IMagickFormatInfo info in MagickNET.SupportedFormats)
        {
            if (info is MagickFormatInfo format && format.SupportsReading && string.Equals(format.MimeType, "image/tiff", StringComparison.OrdinalIgnoreCase))
            {
                formats.Add(format);
            }
        }
        MagickFormatInfo tiff = MagickFormatInfo.Create(MagickFormat.Tiff) as MagickFormatInfo;
        if (tiff is not null && tiff.SupportsReading && !formats.Contains(tiff))
        {
            formats.Add(tiff);
        }
        foreach (MagickFormatInfo format in formats)
        {
            format.Unregister();
        }
    }
}
