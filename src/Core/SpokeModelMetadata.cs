using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using System.IO;
using System.Text;
using System.Text.Json;

namespace SwarmUI.Core;

/// <summary>Spoke-only model metadata storage and parsing that avoids retaining library previews.</summary>
public static class SpokeModelMetadata
{
    /// <summary>Separate local cache, leaving the rich metadata database available for normal mode and rollback.</summary>
    public const string CacheFileName = "model_metadata_spoke.ldb";

    /// <summary>Global bound on concurrent raw headers and sidecar JSON, independent of nested directory traversal.</summary>
    private static readonly SemaphoreSlim HeaderReadSlots = new(4, 4);

    /// <summary>Preview fields and padding that are unnecessary to identify or generate with a model.</summary>
    private static readonly HashSet<string> ExcludedJsonKeys = new(StringComparer.Ordinal)
    {
        "modelspec.preview_image", "modelspec.thumbnail", "thumbnail", "preview_image", "__spacer"
    };

    /// <summary>Removes presentation-only data in spoke mode while retaining every generation-relevant field.</summary>
    public static void TrimForSpoke(T2IModelHandler.ModelMetadataStore metadata)
    {
        if (!SpokeModePolicy.IsActive || metadata is null)
        {
            return;
        }
        metadata.PreviewImage = null;
        metadata.Description = null;
        metadata.Author = null;
        metadata.License = null;
        metadata.UsageHint = null;
        metadata.Tags = null;
        metadata.MergedFrom = null;
        metadata.Date = null;
    }

    /// <summary>Reads a safetensors header without decoding base64 previews into managed strings. GGUF uses its existing binary reader.</summary>
    public static JObject ReadHeader(string modelPath)
    {
        HeaderReadSlots.Wait();
        try
        {
            return ReadHeaderInternal(modelPath);
        }
        finally
        {
            HeaderReadSlots.Release();
        }
    }

    /// <summary>Reads one model header while the caller holds a shared allocation slot.</summary>
    private static JObject ReadHeaderInternal(string modelPath)
    {
        if (modelPath.EndsWith(".gguf"))
        {
            JObject header = T2IModel.GetMetadataHeaderFrom(modelPath);
            if (header["__metadata__"] is JObject metadata)
            {
                foreach (string key in ExcludedJsonKeys)
                {
                    metadata.Remove(key);
                }
            }
            return header;
        }
        using FileStream file = File.OpenRead(modelPath);
        if (file.Length < 8)
        {
            throw new SwarmReadableErrorException($"Improper file {modelPath}. File too short to be valid (file length = {file.Length}. May be filesystem issue, or an incomplete download?)");
        }
        byte[] lengthBytes = new byte[8];
        file.ReadExactly(lengthBytes);
        long length = BitConverter.ToInt64(lengthBytes);
        if (length < 0 || length > 100 * 1024 * 1024)
        {
            throw new SwarmReadableErrorException($"Improper safetensors file {modelPath}. Wrong file type, or unreasonable header length: {length}");
        }
        byte[] headerBytes = new byte[length];
        file.ReadExactly(headerBytes);
        return ParseWithoutPreviews(headerBytes);
    }

    /// <summary>Reads attached JSON metadata without decoding previews that the spoke will never use.</summary>
    public static JObject ReadSidecar(string path)
    {
        HeaderReadSlots.Wait();
        try
        {
            return ParseWithoutPreviews(File.ReadAllBytes(path));
        }
        finally
        {
            HeaderReadSlots.Release();
        }
    }

    /// <summary>Projects JSON in UTF-8 before Newtonsoft materializes strings, avoiding the large base64 string copies.</summary>
    public static JObject ParseWithoutPreviews(byte[] bytes)
    {
        ReadOnlyMemory<byte> json = bytes;
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
        {
            json = json[3..];
        }
        using JsonDocument document = JsonDocument.Parse(json, new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
        using MemoryStream filtered = new();
        using (Utf8JsonWriter writer = new(filtered))
        {
            WriteWithoutPreviews(document.RootElement, writer);
        }
        return Encoding.UTF8.GetString(filtered.GetBuffer(), 0, checked((int)filtered.Length)).ParseToJson();
    }

    /// <summary>Copies JSON structure while omitting preview properties and metadata padding before string decoding.</summary>
    private static void WriteWithoutPreviews(JsonElement element, Utf8JsonWriter writer)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            writer.WriteStartObject();
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!ExcludedJsonKeys.Contains(property.Name))
                {
                    writer.WritePropertyName(property.Name);
                    WriteWithoutPreviews(property.Value, writer);
                }
            }
            writer.WriteEndObject();
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            writer.WriteStartArray();
            foreach (JsonElement item in element.EnumerateArray())
            {
                WriteWithoutPreviews(item, writer);
            }
            writer.WriteEndArray();
        }
        else
        {
            element.WriteTo(writer);
        }
    }
}
