using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Media;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.IO;
using System.Net.WebSockets;
using System.Security.Cryptography;

namespace SwarmUI.Builtin_TagDexExtension;

public partial class TagDexExtension
{
    /// <summary>Serializes thumbnail generation across the whole extension.
    /// <para>Deliberately a single slot. A "generate all visible" sweep over a filtered page is an obvious thing to
    /// want, and fanning it out would occupy every backend for as long as it ran - a typical install has one to four,
    /// so a 200-thumbnail sweep would lock the user out of their own app. Serialized, the sweep is interruptible and
    /// the user keeps a usable queue.</para></summary>
    public static SemaphoreSlim ThumbGate = new(1, 1);

    /// <summary>How many generations are waiting on <see cref="ThumbGate"/>, for UI reporting.</summary>
    public static int ThumbQueueDepth = 0;

    /// <summary>API route: generates one reference thumbnail using the caller's own model and settings.</summary>
    [API.APIDescription("Generates a TagDex reference thumbnail with the user's current model, streaming generation progress.", "\"success\": true, \"thumb\": \"/TagDexThumb/...\"")]
    public async Task<JObject> TagDexGenerateThumbnail(Session session, WebSocket ws,
        [API.APIParameter("Dataset ID.")] string source,
        [API.APIParameter("Exact tag name to generate a reference for.")] string name,
        [API.APIParameter("The full request payload; the generation parameters live under its 'rawInput' key.")] JObject rawInput,
        [API.APIParameter("Whether to include the entry's core tags in the prompt.")] bool includeCoreTags = true)
    {
        TagDexList list = TagDexData.EnsureLoaded(source);
        if (list is null)
        {
            await ws.SendJson(new JObject() { ["error"] = $"Dataset '{source}' is not loaded." }, API.WebsocketTimeout);
            return null;
        }
        if (!list.ByName.TryGetValue(name, out int index))
        {
            await ws.SendJson(new JObject() { ["error"] = $"No entry named '{name}'." }, API.WebsocketTimeout);
            return null;
        }
        TagDexEntry entry = list.Entries[index];
        Interlocked.Increment(ref ThumbQueueDepth);
        try
        {
            await ws.SendJson(new JObject() { ["status"] = "queued", ["queue_depth"] = ThumbQueueDepth }, API.WebsocketTimeout);
            await ThumbGate.WaitAsync(Program.GlobalProgramCancel);
        }
        catch (OperationCanceledException)
        {
            Interlocked.Decrement(ref ThumbQueueDepth);
            return null;
        }
        try
        {
            TagDexPrefs prefs = TagDexPrefs.For(session);
            // A JObject API parameter is bound to the WHOLE request payload, not to the field matching its name -
            // see APICallReflectBuilder, which just dups the input and strips 'session_id'. So the generation
            // parameters have to be dug out of the nested 'rawInput' key; passing the outer object straight to
            // RequestToParams feeds it 'source'/'name'/'rawInput' as unknown params and no model, which fails the
            // whole gen with "No model input given".
            JObject genParams = rawInput?["rawInput"] as JObject ?? [];
            T2IParamInput input = T2IAPI.RequestToParams(session, genParams, true);
            string prompt = entry.Trigger;
            if (includeCoreTags && !string.IsNullOrWhiteSpace(entry.CoreTags))
            {
                prompt = $"{prompt}, {entry.CoreTags}";
            }
            if (!string.IsNullOrWhiteSpace(prefs.ThumbPromptSuffix))
            {
                prompt = $"{prompt}, {prefs.ThumbPromptSuffix}";
            }
            input.Set(T2IParamTypes.Prompt, prompt);
            input.Set(T2IParamTypes.Seed, StableSeed(entry.Name));
            // Without this the reference lands in the user's output folder and image history. A thumbnail is not a
            // generation they asked to keep - we write the file ourselves, below.
            input.Set(T2IParamTypes.DoNotSave, true);
            string written = null;
            string failure = null;
            using Session.GenClaim claim = session.Claim(gens: 1);
            await T2IEngine.CreateImageTask(input, "0", claim, data =>
            {
                // Forward live preview frames so the card shows the reference rendering in place.
                ws.SendJson(data, API.WebsocketTimeout).Wait();
            }, error => failure = error, true, (image, metadata) =>
            {
                try
                {
                    written = image?.File is ImageFile produced
                        ? WriteThumbAndSync(list, in entry, produced)
                        : null;
                }
                catch (Exception ex)
                {
                    failure = $"Could not write thumbnail: {ex.Message}";
                    Logs.Error($"[TagDex] Thumbnail write failed for '{entry.Name}': {ex.ReadableString()}");
                }
            });
            if (failure is not null)
            {
                await ws.SendJson(new JObject() { ["error"] = failure }, API.WebsocketTimeout);
                return null;
            }
            if (written is null)
            {
                await ws.SendJson(new JObject() { ["error"] = "Generation produced no image." }, API.WebsocketTimeout);
                return null;
            }
            TagDexData.InvalidateThumbs(source);
            await ws.SendJson(new JObject() { ["success"] = true, ["name"] = entry.Name, ["thumb"] = written }, API.WebsocketTimeout);
            return null;
        }
        catch (Exception ex)
        {
            Logs.Error($"[TagDex] Thumbnail generation failed for '{name}': {ex.ReadableString()}");
            await ws.SendJson(new JObject() { ["error"] = $"Generation failed: {ex.Message}" }, API.WebsocketTimeout);
            return null;
        }
        finally
        {
            Interlocked.Decrement(ref ThumbQueueDepth);
            ThumbGate.Release();
        }
    }

    /// <summary>API route: sets one entry's reference thumbnail from an image the user already has.
    /// <para>Complements <see cref="TagDexGenerateThumbnail"/>: the image you want is often one you already made and
    /// then edited, inpainted, or upscaled, which regenerating from the tag alone would never reproduce.</para></summary>
    [API.APIDescription("Sets a TagDex reference thumbnail from an existing image.", "\"success\": true, \"thumb\": \"/TagDexThumb/...\"")]
    public async Task<JObject> TagDexSetThumbnail(Session session,
        [API.APIParameter("Dataset ID.")] string source,
        [API.APIParameter("Exact tag name to set the reference for.")] string name,
        [API.APIParameter("Image-data-string of the new reference image.")] string image,
        [API.APIParameter("Whether to forward this image on to a configured AnimaDex instance. Pass false when the image CAME from AnimaDex, to stop it echoing straight back.")] bool syncBack = true)
    {
        TagDexList list = TagDexData.EnsureLoaded(source);
        if (list is null)
        {
            return new JObject() { ["error"] = $"Dataset '{source}' is not loaded." };
        }
        if (!list.ByName.TryGetValue(name, out int index))
        {
            return new JObject() { ["error"] = $"No entry named '{name}'." };
        }
        if (string.IsNullOrWhiteSpace(image))
        {
            return new JObject() { ["error"] = "No image given." };
        }
        TagDexEntry entry = list.Entries[index];
        string written;
        try
        {
            ImageFile incoming = ImageFile.FromDataString(image);
            // syncBack=false is how AnimaDex breaks the cycle: without it, an image AnimaDex just
            // pushed here would be pushed straight back, rewriting the file it came from and bumping
            // its version a second time.
            written = syncBack ? WriteThumbAndSync(list, in entry, incoming)
                               : WriteThumb(list, in entry, incoming);
        }
        catch (Exception ex)
        {
            Logs.Error($"[TagDex] Thumbnail write failed for '{entry.Name}': {ex.ReadableString()}");
            return new JObject() { ["error"] = $"Could not write thumbnail: {ex.Message}" };
        }
        if (written is null)
        {
            return new JObject() { ["error"] = "Image could not be read." };
        }
        TagDexData.InvalidateThumbs(source);
        return new JObject() { ["success"] = true, ["name"] = entry.Name, ["thumb"] = written };
    }

    /// <summary>Writes a generated image out as this entry's thumbnail, returning its served URL.
    /// <para>Reuses <see cref="ImageFile.ToMetadataJpg"/> - the same 256px-short-side JPEG helper the model preview
    /// system uses - rather than introducing a second resize path. Falls back to the raw image if the conversion is
    /// not applicable, so an unusual output type still produces a usable card.</para></summary>
    public static string WriteThumb(TagDexList list, in TagDexEntry entry, T2IEngine.ImageOutput image)
    {
        return image?.File is not ImageFile file ? null : WriteThumb(list, in entry, file);
    }

    /// <summary>Writes the thumbnail, then pushes the ORIGINAL image on to AnimaDex if that sync is
    /// configured.
    /// <para>Split from <see cref="WriteThumb"/> so the push sees the full-resolution file rather than
    /// the 256px JPEG stored here - AnimaDex derives its own thumbnail from what it receives, so sending
    /// the downscaled copy would cap its quality permanently. <see cref="WriteThumb"/> does not mutate
    /// its argument (<c>ToMetadataJpg</c> returns a new file), so the original is still intact.</para></summary>
    public static string WriteThumbAndSync(TagDexList list, in TagDexEntry entry, ImageFile file)
    {
        string written = WriteThumb(list, in entry, file);
        if (written is not null)
        {
            TagDexAnimaDex.PushAsync(list.Source.ID, entry.Name, file);
        }
        return written;
    }

    /// <summary>Writes an image file out as this entry's thumbnail, returning its served URL.
    /// <para>Shared by the generate route and the "use an image I already made" route, so both land in the same
    /// place in the same format.</para></summary>
    public static string WriteThumb(TagDexList list, in TagDexEntry entry, ImageFile file)
    {
        if (file is null)
        {
            return null;
        }
        ImageFile small = file.ToMetadataJpg(null) ?? file;
        string root = $"{TagDexData.ThumbsPath}/{list.Source.ID}";
        Directory.CreateDirectory(root);
        string stem = TagDexNames.SafeFileName(entry.Name);
        string path = $"{root}/{stem}.jpg";
        // Write to a temp name then move, so an interrupted write cannot leave a truncated file that the thumbnail
        // listing would then treat as valid.
        string temp = $"{path}.tmp";
        File.WriteAllBytes(temp, small.RawData);
        if (File.Exists(path))
        {
            File.Delete(path);
        }
        File.Move(temp, path);
        return ThumbUrl(list.Source.ID, $"{stem}.jpg");
    }

    /// <summary>Derives a stable seed from a tag name, so regenerating the same entry reproduces the same image
    /// unless the model or settings changed.
    /// <para>Uses a hash of the name rather than <see cref="string.GetHashCode"/>, which is randomized per process
    /// in .NET and would give a different image on every server restart.</para></summary>
    public static long StableSeed(string name)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(name ?? ""));
        return BitConverter.ToUInt32(hash, 0) % int.MaxValue;
    }

    /// <summary>API route: deletes one generated thumbnail.</summary>
    [API.APIDescription("Deletes a TagDex thumbnail.", "\"success\": true")]
    public async Task<JObject> TagDexDeleteThumbnail(Session session,
        [API.APIParameter("Dataset ID.")] string source,
        [API.APIParameter("Exact tag name.")] string name)
    {
        if (TagDexData.SourceFor(source) is null)
        {
            return new JObject() { ["error"] = $"Unknown dataset '{source}'." };
        }
        string root = $"{TagDexData.ThumbsPath}/{source}";
        string stem = TagDexNames.SafeFileName(name);
        int removed = 0;
        foreach (string ext in new[] { ".jpg", ".webp", ".png" })
        {
            string path = $"{root}/{stem}{ext}";
            (string checkedPath, string consoleError, string userError) = WebServer.CheckFilePath(root, $"{stem}{ext}");
            if (consoleError is not null || userError is not null)
            {
                continue;
            }
            if (File.Exists(checkedPath))
            {
                File.Delete(checkedPath);
                removed++;
            }
        }
        TagDexData.InvalidateThumbs(source);
        return new JObject() { ["success"] = true, ["removed"] = removed };
    }
}
