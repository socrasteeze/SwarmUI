using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;

namespace SwarmUI.Core;

/// <summary>Spoke-only local cache for model files, filled in the background after a job.
/// <para>A spoke reads the hub's model tree over the network. The tree is the inventory of record and stays
/// read-only, but pulling a multi-GB checkpoint across the link on every cold load is the dominant cost of a
/// remote generation. When <see cref="Settings.PathsData.SpokeModelCache"/> is set, each job queues a copy of
/// every model file it named to the same relative path under that root, and ComfyUI is given the root as its
/// first model path, so every later cold load is local. The inventory is never pointed at the cache: names come
/// from the shared tree, so the hub/spoke inventory contract is unaffected and a cache that is missing or empty
/// only costs speed, never correctness.</para>
/// <para>Copies never run in the request path. An earlier version copied before submitting the workflow, which
/// held the spoke silent for the length of the copy; the hub's claim on the job timed out and the generation
/// was reported as interrupted. The copy is now queued when the job finishes, runs on a background task, and is
/// serialized so at most one stream competes with live generations for the link. The first cold load of a
/// model therefore still crosses the network exactly as before; the second does not.</para>
/// <para>The cache is an accelerator, not a dependency. Any failure to fill it is logged and swallowed.</para></summary>
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

    /// <summary>One lock per cache target, so two jobs that name the same uncached model produce one copy rather
    /// than racing to write the same file.</summary>
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> TargetLocks = new();

    /// <summary>Serializes background copies. The link to the shared tree is the bottleneck a live generation is
    /// also using, so one copy at a time bounds the contention.</summary>
    private static readonly SemaphoreSlim CopyQueue = new(1, 1);

    /// <summary>Coalesces queued jobs before they allocate a waiting background task.</summary>
    private static readonly ConcurrentDictionary<string, byte> PendingTargets = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Retries a failed target at most once in five minutes, unless the shared source changes.</summary>
    private static readonly ConcurrentDictionary<string, (long Length, DateTime Modified, long RetryAt)> FailedTargets = new(StringComparer.OrdinalIgnoreCase);

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
        string partial = $"{target}.partial";
        try
        {
            FileInfo sourceInfo = new(source);
            if (!sourceInfo.Exists)
            {
                Logs.Warning($"[SpokeCache] Source for '{model.Name}' is missing at '{source}'; not caching.");
                return false;
            }
            FileInfo targetInfo = new(target);
            DateTime sourceModified = sourceInfo.LastWriteTimeUtc;
            long sourceLength = sourceInfo.Length;
            if (targetInfo.Exists && targetInfo.Length == sourceLength && targetInfo.LastWriteTimeUtc == sourceModified)
            {
                FailedTargets.TryRemove(target, out _);
                Logs.Verbose($"[SpokeCache] '{model.Name}' already cached.");
                return true;
            }
            if (FailedTargets.TryGetValue(target, out (long Length, DateTime Modified, long RetryAt) failure)
                && failure.Length == sourceLength && failure.Modified == sourceModified && Environment.TickCount64 < failure.RetryAt)
            {
                return false;
            }
            SpokeModePolicy.AssertSpokeCacheWriteAllowed(target, $"cache model '{model.Name}'");
            // Retire a stale entry BEFORE the expensive transfer. Windows model mappings can deny replacement
            // even with a writable ACL. If this rename is blocked, no multi-GB source stream is opened.
            if (targetInfo.Exists)
            {
                string retired = $"{target}.{Guid.NewGuid():N}.stale";
                File.Move(target, retired);
                TryDelete(retired);
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            // Written to a sibling temp name and moved into place so a reader can never observe a half-written
            // model at the real path. ComfyUI resolves by existence, so a partial file at the final name would be
            // picked up and fail deep inside a loader with an unhelpful error.
            long startTime = Environment.TickCount64;
            Logs.Info($"[SpokeCache] Caching '{model.Name}' ({sourceInfo.Length / (1024 * 1024)} MB) to local cache...");
            try
            {
                await using (FileStream input = new(source, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, FileOptions.Asynchronous | FileOptions.SequentialScan))
                await using (FileStream output = new(partial, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20, FileOptions.Asynchronous | FileOptions.SequentialScan))
                {
                    byte[] buffer = new byte[1 << 20];
                    while (true)
                    {
                        await WaitForIdle(cancel);
                        int read = await input.ReadAsync(buffer.AsMemory(), cancel);
                        if (read == 0)
                        {
                            break;
                        }
                        await output.WriteAsync(buffer.AsMemory(0, read), cancel);
                    }
                }
                long written = new FileInfo(partial).Length;
                if (written != sourceInfo.Length)
                {
                    throw new IOException($"copied {written} bytes but source is {sourceInfo.Length}");
                }
                sourceInfo.Refresh();
                if (!sourceInfo.Exists || sourceInfo.Length != sourceLength || sourceInfo.LastWriteTimeUtc != sourceModified)
                {
                    throw new IOException("shared source changed while copying");
                }
                File.SetLastWriteTimeUtc(partial, sourceModified);
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
                FailedTargets[target] = (sourceLength, sourceModified, Environment.TickCount64 + 300_000);
                return false;
            }
            FailedTargets.TryRemove(target, out _);
            double seconds = (Environment.TickCount64 - startTime) / 1000.0;
            Logs.Info($"[SpokeCache] Cached '{model.Name}' in {seconds:0.0}s. Future loads on this spoke are local.");
            return true;
        }
        catch (OperationCanceledException)
        {
            TryDelete(partial);
            throw;
        }
        catch (Exception ex)
        {
            TryDelete(partial);
            FileInfo sourceInfo = new(source);
            if (sourceInfo.Exists)
            {
                FailedTargets[target] = (sourceInfo.Length, sourceInfo.LastWriteTimeUtc, Environment.TickCount64 + 300_000);
            }
            Logs.Warning($"[SpokeCache] Cannot prepare cache for '{model.Name}': {ex.Message}. Will retry after five minutes; generation uses the shared tree.");
            return false;
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>Queues a background cache fill for every model a ComfyUI workflow names. Returns immediately; the
    /// copies run one at a time on a checked task and never surface an exception to the caller. Safe to call from
    /// a finally block: a job that failed or was interrupted still named real models worth caching.</summary>
    public static void QueueWorkflowCache(JObject workflow)
    {
        if (!Enabled || workflow is null)
        {
            return;
        }
        HashSet<T2IModel> models;
        try
        {
            models = CollectWorkflowModels(workflow);
        }
        catch (Exception ex)
        {
            Logs.Warning($"[SpokeCache] Could not read models from workflow: {ex.ReadableString()}");
            return;
        }
        if (models.Count == 0)
        {
            return;
        }
        foreach (T2IModel model in models)
        {
            string target = CacheTargetFor(model);
            if (target is null || !PendingTargets.TryAdd(target, 0))
            {
                continue;
            }
            _ = Utilities.RunCheckedTask(async () =>
            {
                try
                {
                    await CopyQueue.WaitAsync(Program.GlobalProgramCancel);
                    try
                    {
                        // Queued generations get first use of the share. This wait is only on the worker;
                        // submission and progress feedback never wait for cache work.
                        await WaitForIdle(Program.GlobalProgramCancel);
                        await EnsureCached(model, Program.GlobalProgramCancel);
                    }
                    finally
                    {
                        CopyQueue.Release();
                    }
                }
                finally
                {
                    PendingTargets.TryRemove(target, out _);
                }
            });
        }
    }

    /// <summary>Pauses only background transfers while generation is queued or using a backend.</summary>
    private static async Task WaitForIdle(CancellationToken cancel)
    {
        while (Program.Backends is not null && Program.Backends.QueuedRequests > 0)
        {
            await Task.Delay(1000, cancel);
        }
    }

    /// <summary>Finds every known model a generated ComfyUI workflow names. Values are ComfyUI filenames (a model's
    /// <see cref="T2IModel.Name"/> with the backend's folder separator), so they are normalised back to '/' before
    /// lookup. Names that match no known model - a raw path a custom node emitted, say - are skipped and resolve
    /// from the shared tree as they always did.</summary>
    public static HashSet<T2IModel> CollectWorkflowModels(JObject workflow)
    {
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
        return models;
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
