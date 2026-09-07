using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;

namespace SwarmUI.Core;

/// <summary>Spoke-only local read-through cache for model files.
/// <para>A spoke reads the hub's model tree over the network. The tree is the inventory of record and stays
/// read-only, but pulling a multi-GB checkpoint across the link on every cold load is the dominant cost of a
/// remote generation. When <see cref="Settings.PathsData.SpokeModelCache"/> is set, the first use of a model
/// copies its file to the same relative path under that root, and ComfyUI is given the root as its first
/// model path, so every later load is local. The inventory is never pointed at the cache: names come from the
/// shared tree, so the hub/spoke inventory contract is unaffected and a cache that is missing or empty only
/// costs speed, never correctness.</para>
/// <para>The cache is an accelerator, not a dependency. Any failure to fill it is logged and swallowed, and the
/// generation proceeds reading the shared tree as it always did.</para></summary>
public static class SpokeModelCache
{
    /// <summary>True when this process is a spoke with a configured cache root.</summary>
    public static bool Enabled => SpokeModePolicy.IsActive && SpokeModePolicy.CacheRoot is not null;

    /// <summary>Node input names that carry a model filename. <see cref="Builtin_ComfyUIBackend.ComfyUser.ModelNameInputNames"/>
    /// covers the path-format fixer's needs; this adds the loaders it does not touch because their values never need
    /// slash normalisation but do name a file on disk.</summary>
    public static readonly HashSet<string> ModelFileInputNames = ["ckpt_name", "unet_name", "vae_name", "lora_name", "lora_names", "clip_name", "control_net_name", "style_model_name", "model_path", "embed_name"];

    /// <summary>Which model sets to try first for a given input name. Names can legitimately repeat across sets (a
    /// 'foo/bar.safetensors' LoRA and checkpoint), so the loader's own type narrows the lookup before the fallback
    /// tries every set.</summary>
    public static readonly Dictionary<string, string[]> PreferredSetsByInput = new()
    {
        ["ckpt_name"] = ["Stable-Diffusion"],
        ["unet_name"] = ["Stable-Diffusion"],
        ["vae_name"] = ["VAE"],
        ["lora_name"] = ["LoRA"],
        ["lora_names"] = ["LoRA"],
        ["clip_name"] = ["Clip", "ClipVision"],
        ["control_net_name"] = ["ControlNet"],
        ["embed_name"] = ["Embedding"],
    };

    /// <summary>One lock per cache target, so two generations that need the same uncached model wait for one copy
    /// rather than racing to write the same file.</summary>
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> TargetLocks = new();

    private static readonly StringComparison PathComparison = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    /// <summary>Returns the path of <paramref name="rawFilePath"/> relative to whichever configured model root
    /// contains it, or null when it lives under none of them (or under the cache root itself). The relative path
    /// is what keeps the cache a mirror: the same folder names ComfyUI is told about on the shared side resolve
    /// identically on the cached side.</summary>
    public static string RelativeToModelRoot(string rawFilePath)
    {
        if (string.IsNullOrWhiteSpace(rawFilePath))
        {
            return null;
        }
        string full = Path.GetFullPath(rawFilePath);
        string cache = SpokeModePolicy.CacheRoot;
        if (cache is not null && IsUnder(full, cache))
        {
            return null;
        }
        foreach (string root in Program.ServerSettings.Paths.ActualModelRoots)
        {
            string rootFull = Path.GetFullPath(root);
            if (IsUnder(full, rootFull))
            {
                return Path.GetRelativePath(rootFull, full);
            }
        }
        return null;
    }

    /// <summary>True when <paramref name="fullPath"/> is inside <paramref name="root"/>, with a separator boundary so
    /// 'E:\models2' is not mistaken for a child of 'E:\models'.</summary>
    public static bool IsUnder(string fullPath, string root)
    {
        string rootNorm = Path.TrimEndingDirectorySeparator(root);
        return fullPath.Equals(rootNorm, PathComparison) || fullPath.StartsWith(rootNorm + Path.DirectorySeparatorChar, PathComparison) || fullPath.StartsWith(rootNorm + Path.AltDirectorySeparatorChar, PathComparison);
    }

    /// <summary>Where <paramref name="model"/> would live in the cache, or null when it is not cacheable (not under a
    /// model root, or already the cached copy).</summary>
    public static string CacheTargetFor(T2IModel model)
    {
        string relative = RelativeToModelRoot(model?.RawFilePath);
        return relative is null ? null : Path.GetFullPath(Path.Combine(SpokeModePolicy.CacheRoot, relative));
    }

    /// <summary>Ensures the cache holds a byte-complete copy of <paramref name="model"/>. Returns true when the file
    /// is now cached (whether it already was or was just copied), false when it was not cacheable or the copy failed.
    /// Never throws for a failed copy - see the class remarks - but does propagate cancellation so an interrupted
    /// generation stops copying too, with the partial file removed.</summary>
    public static async Task<bool> EnsureCached(T2IModel model, CancellationToken cancel = default)
    {
        if (!Enabled || model is null)
        {
            return false;
        }
        string target = CacheTargetFor(model);
        if (target is null)
        {
            return false;
        }
        string source = model.RawFilePath;
        SemaphoreSlim gate = TargetLocks.GetOrAdd(target, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancel);
        try
        {
            FileInfo sourceInfo = new(source);
            if (!sourceInfo.Exists)
            {
                Logs.Warning($"[SpokeCache] Source for '{model.Name}' is missing at '{source}'; not caching.");
                return false;
            }
            FileInfo targetInfo = new(target);
            if (targetInfo.Exists && targetInfo.Length == sourceInfo.Length)
            {
                Logs.Verbose($"[SpokeCache] '{model.Name}' already cached.");
                return true;
            }
            SpokeModePolicy.AssertSpokeCacheWriteAllowed(target, $"cache model '{model.Name}'");
            // A same-name file of a different size is a superseded copy (the hub replaced the model) or a torn
            // earlier write; either way the cached bytes are wrong and get replaced, never served.
            if (targetInfo.Exists)
            {
                Logs.Info($"[SpokeCache] Cached '{model.Name}' is {targetInfo.Length} bytes but source is {sourceInfo.Length}; re-copying.");
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            // Written to a sibling temp name and moved into place so a reader can never observe a half-written
            // model at the real path. ComfyUI resolves by existence, so a partial file at the final name would be
            // picked up and fail deep inside a loader with an unhelpful error.
            string partial = $"{target}.partial";
            long startTime = Environment.TickCount64;
            Logs.Info($"[SpokeCache] Caching '{model.Name}' ({sourceInfo.Length / (1024 * 1024)} MB) to local cache...");
            try
            {
                await using (FileStream input = new(source, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, FileOptions.Asynchronous | FileOptions.SequentialScan))
                await using (FileStream output = new(partial, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20, FileOptions.Asynchronous | FileOptions.SequentialScan))
                {
                    await input.CopyToAsync(output, 1 << 20, cancel);
                }
                long written = new FileInfo(partial).Length;
                if (written != sourceInfo.Length)
                {
                    throw new IOException($"copied {written} bytes but source is {sourceInfo.Length}");
                }
                File.Move(partial, target, true);
            }
            catch (OperationCanceledException)
            {
                TryDelete(partial);
                Logs.Info($"[SpokeCache] Copy of '{model.Name}' interrupted; partial file removed.");
                throw;
            }
            catch (Exception ex)
            {
                TryDelete(partial);
                Logs.Warning($"[SpokeCache] Failed to cache '{model.Name}': {ex.ReadableString()}. Generation will read the shared tree instead.");
                return false;
            }
            double seconds = (Environment.TickCount64 - startTime) / 1000.0;
            Logs.Info($"[SpokeCache] Cached '{model.Name}' in {seconds:0.0}s. Future loads on this spoke are local.");
            return true;
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>Finds every model a generated ComfyUI workflow names and ensures each is cached before the workflow
    /// is submitted. Values are ComfyUI filenames (a model's <see cref="T2IModel.Name"/> with the backend's folder
    /// separator), so they are normalised back to '/' before lookup. Names that match no known model - a raw path a
    /// custom node emitted, say - are left alone and resolve from the shared tree as they always did.</summary>
    public static async Task EnsureWorkflowCached(JObject workflow, CancellationToken cancel = default)
    {
        if (!Enabled || workflow is null)
        {
            return;
        }
        HashSet<T2IModel> models = [];
        foreach (JProperty node in workflow.Properties())
        {
            if (node.Value is not JObject nodeObj || nodeObj["inputs"] is not JObject inputs)
            {
                continue;
            }
            foreach (JProperty input in inputs.Properties())
            {
                if (!ModelFileInputNames.Contains(input.Name) || input.Value.Type != JTokenType.String)
                {
                    continue;
                }
                // lora_names is a comma-joined list on Swarm's own loader node; everything else is one name.
                foreach (string rawName in input.Value.ToString().Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    T2IModel model = FindModel(input.Name, rawName.Replace('\\', '/'));
                    if (model is not null)
                    {
                        models.Add(model);
                    }
                }
            }
        }
        foreach (T2IModel model in models)
        {
            cancel.ThrowIfCancellationRequested();
            await EnsureCached(model, cancel);
        }
    }

    /// <summary>Looks a ComfyUI filename up across the model sets, preferring the set the input's loader type
    /// implies. Returns null for an unknown name.</summary>
    public static T2IModel FindModel(string inputName, string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }
        if (PreferredSetsByInput.TryGetValue(inputName, out string[] preferred))
        {
            foreach (string setName in preferred)
            {
                if (Program.T2IModelSets.TryGetValue(setName, out T2IModelHandler handler) && handler.Models.TryGetValue(name, out T2IModel model))
                {
                    return model;
                }
            }
        }
        foreach (T2IModelHandler handler in Program.T2IModelSets.Values)
        {
            if (handler.Models.TryGetValue(name, out T2IModel model))
            {
                return model;
            }
        }
        return null;
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception ex)
        {
            Logs.Verbose($"[SpokeCache] Could not remove partial file '{path}': {ex.Message}");
        }
    }
}
