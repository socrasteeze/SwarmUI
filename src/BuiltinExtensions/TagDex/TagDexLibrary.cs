using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;

namespace SwarmUI.Builtin_TagDexExtension;

/// <summary>Local AnimaDex library proxy, exact LoRA resolver, and archive acquisition service.</summary>
public static class TagDexLibrary
{
    /// <summary>Serializes receipt read-modify-write publication.</summary>
    public static readonly object ReceiptLock = new();
    /// <summary>Installation receipt persisted after a verified archive download.</summary>
    public record class InstallReceipt(string ArchiveSha256, string LogicalName, string Path, long Size, long ModifiedUtc);

    /// <summary>Receipt file path.</summary>
    public static string ReceiptPath => $"{TagDexData.FolderPath}/library-installs.json";

    /// <summary>Loads installation receipts without exposing them to clients.</summary>
    public static Dictionary<string, InstallReceipt> LoadReceipts()
    {
        try
        {
            if (!File.Exists(ReceiptPath))
            {
                return [];
            }
            JArray rows = JArray.Parse(File.ReadAllText(ReceiptPath));
            return rows.Values<JObject>().Select(row => new InstallReceipt(
                row.Value<string>("archive_sha256"), row.Value<string>("logical_name"), row.Value<string>("path"),
                row.Value<long>("size"), row.Value<long>("modified_utc")))
                .Where(row => IsSha256(row.ArchiveSha256) && !string.IsNullOrWhiteSpace(row.Path))
                .ToDictionary(row => row.ArchiveSha256, StringComparer.OrdinalIgnoreCase);
        }
        catch (Exception ex)
        {
            Logs.Warning($"[TagDex] Could not read library install receipts: {ex.ReadableString()}");
            return [];
        }
    }

    /// <summary>Atomically writes installation receipts.</summary>
    public static void SaveReceipts(Dictionary<string, InstallReceipt> receipts)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(ReceiptPath));
        JArray rows = new(receipts.Values.OrderBy(row => row.ArchiveSha256).Select(row => new JObject()
        {
            ["archive_sha256"] = row.ArchiveSha256,
            ["logical_name"] = row.LogicalName,
            ["path"] = row.Path,
            ["size"] = row.Size,
            ["modified_utc"] = row.ModifiedUtc
        }));
        string temp = $"{ReceiptPath}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temp, rows.ToString());
        File.Move(temp, ReceiptPath, true);
    }

    /// <summary>Returns true only for a normalized SHA-256 hex string.</summary>
    public static bool IsSha256(string value)
    {
        return value is not null && value.Length == 64 && value.All(Uri.IsHexDigit);
    }

    /// <summary>Builds a collision-safe filename from archive metadata.</summary>
    public static string DownloadName(string name, string version, string sha)
    {
        string stem = Utilities.StrictFilenameCleanKeepDots($"{name}-{version}").Replace('/', '-').Replace('\\', '-').Trim(' ', '.');
        if (string.IsNullOrWhiteSpace(stem))
        {
            stem = "library-lora";
        }
        return $"{stem}-{sha[..12]}.safetensors";
    }

    /// <summary>Computes an exact full-file SHA-256 without mutating model metadata.</summary>
    public static string FullHash(string path)
    {
        using FileStream stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    /// <summary>Computes an exact SHA-256 for in-memory immutable blobs.</summary>
    public static string FullHashBytes(byte[] data)
    {
        return Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();
    }

    /// <summary>Checks a receipt against the exact current file bytes.</summary>
    public static bool ReceiptMatches(InstallReceipt receipt)
    {
        if (receipt is null || !IsSha256(receipt.ArchiveSha256) || !File.Exists(receipt.Path))
        {
            return false;
        }
        return FullHash(receipt.Path) == receipt.ArchiveSha256;
    }

    /// <summary>Resolves every LoRA in a variant recipe against verified local files.</summary>
    public static JObject ResolveRecipe(JObject record, string model = null)
    {
        JObject data = record?["data"] as JObject ?? [];
        JObject recipe = data["recipe"] as JObject ?? [];
        JArray loras = recipe["loras"] as JArray ?? [];
        Dictionary<string, InstallReceipt> receipts = LoadReceipts();
        JArray resolved = [];
        long totalBytes = 0;
        T2IModelHandler handler = Program.T2IModelSets.GetValueOrDefault("LoRA");
        string baseFamily = recipe.Value<string>("base_family") ?? "";
        string checkpoint = recipe.Value<string>("checkpoint") ?? "";
        string targetCheckpoint = string.IsNullOrWhiteSpace(checkpoint) ? (model ?? "") : checkpoint;
        string checkpointFamily = CheckpointFamily(targetCheckpoint);
        string expectedFamily = string.IsNullOrWhiteSpace(baseFamily) ? checkpointFamily : baseFamily;
        foreach (JObject lora in loras.Values<JObject>())
        {
            string archiveHash = (lora.Value<string>("archive_sha256") ?? "").ToLowerInvariant();
            string weightsHash = (lora.Value<string>("weights_sha256") ?? "").ToLowerInvariant();
            string status = "not_downloaded";
            string logicalName = null;
            long knownBytes = 0;
            if (receipts.TryGetValue(archiveHash, out InstallReceipt receipt) && ReceiptMatches(receipt))
            {
                FileInfo info = new(receipt.Path);
                logicalName = receipt.LogicalName;
                knownBytes = info.Length;
                T2IModel installed = handler?.Models.GetValueOrDefault(logicalName);
                if (installed is null || !File.Exists(installed.RawFilePath) || FullHash(installed.RawFilePath) != archiveHash)
                {
                    status = "unverified";
                }
                else
                {
                    status = ModelFamilyStatus(installed, expectedFamily);
                    knownBytes = new FileInfo(installed.RawFilePath).Length;
                }
            }
            if (status != "ready" && handler is not null)
            {
                static string cleanHash(string value)
                {
                    string clean = (value ?? "").Trim().ToLowerInvariant();
                    return clean.StartsWith("0x") ? clean[2..] : clean;
                }
                T2IModel candidate = handler.Models.Values.FirstOrDefault(model =>
                    cleanHash(model.Metadata?.Hash) == archiveHash
                    || (IsSha256(weightsHash) && cleanHash(model.Metadata?.Hash) == weightsHash));
                if (candidate is not null)
                {
                    logicalName = candidate.Name;
                    FileInfo candidateInfo = new(candidate.RawFilePath);
                    knownBytes = candidateInfo.Length;
                    if (FullHash(candidate.RawFilePath) == archiveHash)
                    {
                        status = ModelFamilyStatus(candidate, expectedFamily);
                        lock (ReceiptLock)
                        {
                            Dictionary<string, InstallReceipt> installedReceipts = LoadReceipts();
                            installedReceipts[archiveHash] = new(archiveHash, logicalName, candidate.RawFilePath,
                                candidateInfo.Length, candidateInfo.LastWriteTimeUtc.Ticks);
                            SaveReceipts(installedReceipts);
                        }
                    }
                    else
                    {
                        status = "unverified";
                    }
                }
            }
            totalBytes += knownBytes;
            resolved.Add(new JObject()
            {
                ["archive_sha256"] = archiveHash,
                ["weights_sha256"] = string.IsNullOrWhiteSpace(weightsHash) ? null : weightsHash,
                ["name"] = lora.Value<string>("name"),
                ["version"] = lora.Value<string>("version"),
                ["weight"] = lora.Value<double?>("weight") ?? 1,
                ["status"] = status,
                ["logical_name"] = logicalName,
                ["bytes"] = knownBytes
            });
        }
        return new JObject()
        {
            ["ok"] = true,
            ["variant_id"] = record?.Value<string>("id"),
            ["revision"] = record?.Value<string>("revision"),
            ["checkpoint"] = targetCheckpoint,
            ["base_family"] = baseFamily,
            ["loras"] = resolved,
            ["total_known_bytes"] = totalBytes,
            ["checkpoint_status"] = CheckpointStatus(targetCheckpoint, baseFamily),
            ["ready"] = resolved.Values<JObject>().All(row => row.Value<string>("status") == "ready")
                && CheckpointStatus(targetCheckpoint, baseFamily) == "ready"
        };
    }

    /// <summary>Returns exact compatibility state for a full-file verified model.</summary>
    public static string ModelFamilyStatus(T2IModel model, string baseFamily)
    {
        if (model is null)
        {
            return "unverified";
        }
        string installedFamily = model.Metadata?.ModelClassType ?? model.ModelClass?.ID ?? "";
        if (string.IsNullOrWhiteSpace(installedFamily))
        {
            return "unverified";
        }
        return !string.IsNullOrWhiteSpace(baseFamily) && !FamilyMatches(baseFamily, installedFamily) ? "incompatible" : "ready";
    }

    /// <summary>Compares normalized model-family identifiers without fuzzy model-name matching.</summary>
    public static bool FamilyMatches(string expected, string actual)
    {
        static string norm(string value) => new(value.ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());
        static string canonical(string value)
        {
            string clean = norm(value);
            if (clean is "illustrious" or "illustriousxl" or "noob" or "noobai" or "pony" or "sdxl"
                || clean.StartsWith("stablediffusionxl"))
            {
                return "sdxl";
            }
            if (clean is "sd15" or "sd1" || clean.StartsWith("stablediffusionv1"))
            {
                return "sd1";
            }
            if (clean is "flux" || clean.StartsWith("flux1"))
            {
                return "flux1";
            }
            if (clean.StartsWith("anima"))
            {
                return "anima";
            }
            return clean;
        }
        return canonical(expected) == canonical(actual);
    }

    /// <summary>Returns ready, not_downloaded, or incompatible for an explicit checkpoint.</summary>
    public static string CheckpointStatus(string checkpoint, string baseFamily)
    {
        if (string.IsNullOrWhiteSpace(checkpoint))
        {
            return "unverified";
        }
        T2IModelHandler checkpointHandler = Program.T2IModelSets.GetValueOrDefault("Stable-Diffusion");
        T2IModel model = checkpointHandler?.GetModel(checkpoint);
        if (model is null)
        {
            return "not_downloaded";
        }
        string actual = model.Metadata?.ModelClassType ?? model.ModelClass?.ID ?? "";
        if (string.IsNullOrWhiteSpace(actual))
        {
            return "unverified";
        }
        return !string.IsNullOrWhiteSpace(baseFamily) && !string.IsNullOrWhiteSpace(actual) && !FamilyMatches(baseFamily, actual)
            ? "incompatible" : "ready";
    }

    /// <summary>Returns the actual local architecture for a selected checkpoint.</summary>
    public static string CheckpointFamily(string checkpoint)
    {
        if (string.IsNullOrWhiteSpace(checkpoint))
        {
            return "";
        }
        T2IModelHandler checkpointHandler = Program.T2IModelSets.GetValueOrDefault("Stable-Diffusion");
        T2IModel model = checkpointHandler?.GetModel(checkpoint);
        return model?.Metadata?.ModelClassType ?? model?.ModelClass?.ID ?? "";
    }

    /// <summary>Creates an origin-bound HTTP client that never forwards credentials across redirects.</summary>
    public static HttpClient Client(int timeoutSeconds)
    {
        HttpClientHandler handler = new() { AllowAutoRedirect = false };
        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(timeoutSeconds) };
    }

    /// <summary>Downloads one archive object without following redirects, so archive credentials never leave the configured origin.</summary>
    public static async Task DownloadArchive(TagDexLocal.ArchiveConfig cfg, string sha, string path,
        Action<long, long, long> progress, CancellationToken cancellationToken)
    {
        Uri origin = new(cfg.Url, UriKind.Absolute);
        Uri target = new(origin, $"/api/models/{sha}/file");
        if (target.Scheme != origin.Scheme || target.Host != origin.Host || target.Port != origin.Port)
        {
            throw new SwarmReadableErrorException("The archive download URL left the configured origin.");
        }
        using HttpClient client = Client(cfg.TimeoutSeconds);
        using HttpRequestMessage request = new(HttpMethod.Get, target);
        if (!string.IsNullOrWhiteSpace(cfg.Token))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.Token);
        }
        using HttpResponseMessage response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if ((int)response.StatusCode is >= 300 and < 400)
        {
            throw new SwarmReadableErrorException("The archive refused a direct download. Redirects are blocked to protect its token.");
        }
        if (!response.IsSuccessStatusCode)
        {
            throw new SwarmReadableErrorException($"The archive download failed with HTTP {(int)response.StatusCode}.");
        }
        long total = response.Content.Headers.ContentLength ?? 0;
        long current = 0;
        long started = Environment.TickCount64;
        using Stream input = await response.Content.ReadAsStreamAsync(cancellationToken);
        using FileStream output = new(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        byte[] buffer = new byte[1024 * 1024];
        while (true)
        {
            int read = await input.ReadAsync(buffer, cancellationToken);
            if (read == 0)
            {
                break;
            }
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            hash.AppendData(buffer, 0, read);
            current += read;
            long elapsed = Math.Max(1, Environment.TickCount64 - started);
            progress(current, total, current * 1000 / elapsed);
        }
        string actual = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        if (actual != sha)
        {
            throw new SwarmReadableErrorException("The archive download failed SHA-256 verification.");
        }
    }

    /// <summary>Sends one authenticated request to the configured local library.</summary>
    public static async Task<JObject> LibraryRequest(HttpMethod method, string path, JObject body = null)
    {
        TagDexLocal.LibraryConfig cfg = TagDexLocal.Library();
        if (!cfg.Enabled || string.IsNullOrWhiteSpace(cfg.Url) || string.IsNullOrWhiteSpace(cfg.Key))
        {
            return new JObject() { ["ok"] = false, ["error"] = "The character library is not configured.", ["code"] = "library_not_configured" };
        }
        using HttpClient client = Client(cfg.TimeoutSeconds);
        using HttpRequestMessage request = new(method, $"{cfg.Url}/api/library/{path.TrimStart('/')}");
        request.Headers.Add("X-AnimaDex-Library-Key", cfg.Key);
        if (body is not null)
        {
            request.Content = new StringContent(body.ToString(Newtonsoft.Json.Formatting.None), Encoding.UTF8, "application/json");
        }
        try
        {
            using HttpResponseMessage response = await client.SendAsync(request);
            string text = await response.Content.ReadAsStringAsync();
            JObject result = string.IsNullOrWhiteSpace(text) ? new JObject() : JObject.Parse(text);
            result["http_status"] = (int)response.StatusCode;
            return result;
        }
        catch (Exception ex)
        {
            return new JObject() { ["ok"] = false, ["error"] = $"The character library is unavailable: {ex.Message}", ["code"] = "library_unavailable" };
        }
    }
}

public partial class TagDexExtension
{
    /// <summary>Extracts the nested payload from the reflection API binder's full request object.</summary>
    public static JObject LibrarySaveBody(JObject request)
    {
        return request?["body"] as JObject ?? [];
    }

    /// <summary>Lists custom library characters.</summary>
    public async Task<JObject> TagDexLibraryCharacters(Session session, string q = "", int offset = 0, int limit = 50, bool includeArchived = false)
    {
        return await TagDexLibrary.LibraryRequest(HttpMethod.Get, $"characters?q={Uri.EscapeDataString(q ?? "")}&offset={Math.Max(0, offset)}&limit={Math.Clamp(limit, 1, 250)}&include_archived={(includeArchived ? 1 : 0)}");
    }

    /// <summary>Gets a character and all variants.</summary>
    public async Task<JObject> TagDexLibraryCharacter(Session session, string id)
    {
        return await FetchCompleteCollection($"characters/{Uri.EscapeDataString(id)}", "variants");
    }

    /// <summary>Gets a variant and its full gallery.</summary>
    public async Task<JObject> TagDexLibraryVariant(Session session, string id)
    {
        return await FetchCompleteCollection($"variants/{Uri.EscapeDataString(id)}", "images");
    }

    /// <summary>Searches or fetches one archive model through local AnimaDex without exposing archive credentials.</summary>
    public async Task<JObject> TagDexLibraryArchive(Session session, string q = "", string sha = "", int offset = 0, int limit = 50)
    {
        string path = string.IsNullOrWhiteSpace(sha)
            ? $"archive/models?q={Uri.EscapeDataString(q ?? "")}&offset={Math.Max(0, offset)}&limit={Math.Clamp(limit, 1, 250)}"
            : $"archive/models/{Uri.EscapeDataString(sha)}";
        return await TagDexLibrary.LibraryRequest(HttpMethod.Get, path);
    }

    /// <summary>Starts local-AnimaDex reference generation for an exact variant revision.</summary>
    public async Task<JObject> TagDexLibraryStartGenerate(Session session, string variantId, string revision)
    {
        return await TagDexLibrary.LibraryRequest(HttpMethod.Post, $"variants/{Uri.EscapeDataString(variantId)}/generate",
            new JObject() { ["base_revision"] = revision });
    }

    /// <summary>Reads one local-AnimaDex generation job.</summary>
    public async Task<JObject> TagDexLibraryJob(Session session, string jobId)
    {
        return await TagDexLibrary.LibraryRequest(HttpMethod.Get, $"jobs/{Uri.EscapeDataString(jobId)}");
    }

    /// <summary>Loads every bounded child page for one detail response.</summary>
    public static async Task<JObject> FetchCompleteCollection(string path, string collection)
    {
        const int pageSize = 250;
        int offset = 0;
        JObject combined = null;
        JArray rows = [];
        while (true)
        {
            JObject page = await TagDexLibrary.LibraryRequest(HttpMethod.Get,
                $"{path}?offset={offset}&limit={pageSize}");
            if (!(page.Value<bool?>("ok") ?? false))
            {
                return page;
            }
            combined ??= page;
            JArray current = page[collection] as JArray ?? [];
            foreach (JToken row in current)
            {
                rows.Add(row);
            }
            offset += current.Count;
            int total = page.Value<int?>("total") ?? offset;
            if (current.Count == 0 || offset >= total)
            {
                combined[collection] = rows;
                combined["offset"] = 0;
                combined["limit"] = rows.Count;
                return combined;
            }
        }
    }

    /// <summary>Returns one authenticated immutable library image for use as a local reference.</summary>
    public async Task<JObject> TagDexLibraryImage(Session session, string sha, string mime)
    {
        if (!TagDexLibrary.IsSha256(sha))
        {
            return new JObject() { ["ok"] = false, ["error"] = "The image hash is invalid." };
        }
        TagDexLocal.LibraryConfig cfg = TagDexLocal.Library();
        if (!cfg.Enabled || string.IsNullOrWhiteSpace(cfg.Url) || string.IsNullOrWhiteSpace(cfg.Key))
        {
            return new JObject() { ["ok"] = false, ["error"] = "The character library is not configured." };
        }
        try
        {
            using HttpClient client = TagDexLibrary.Client(cfg.TimeoutSeconds);
            using HttpRequestMessage request = new(HttpMethod.Get, $"{cfg.Url}/api/library/blobs/{sha.ToLowerInvariant()}");
            request.Headers.Add("X-AnimaDex-Library-Key", cfg.Key);
            using HttpResponseMessage response = await client.SendAsync(request);
            if (!response.IsSuccessStatusCode)
            {
                return new JObject() { ["ok"] = false, ["error"] = "The reference image is unavailable." };
            }
            byte[] bytes = await response.Content.ReadAsByteArrayAsync();
            if (TagDexLibrary.FullHashBytes(bytes) != sha.ToLowerInvariant())
            {
                return new JObject() { ["ok"] = false, ["error"] = "The reference image failed checksum verification." };
            }
            string safeMime = mime is "image/png" or "image/jpeg" or "image/webp" ? mime : "image/png";
            return new JObject() { ["ok"] = true, ["image"] = $"data:{safeMime};base64,{Convert.ToBase64String(bytes)}" };
        }
        catch (Exception ex)
        {
            return new JObject() { ["ok"] = false, ["error"] = $"The reference image is unavailable: {ex.Message}" };
        }
    }

    /// <summary>Creates or updates a library entity through a fixed route allowlist.</summary>
    public async Task<JObject> TagDexLibrarySave(Session session, string action, string id, JObject body)
    {
        JObject requestBody = LibrarySaveBody(body);
        return action switch
        {
            "create_character" => await TagDexLibrary.LibraryRequest(HttpMethod.Post, "characters", requestBody),
            "update_character" => await TagDexLibrary.LibraryRequest(HttpMethod.Put, $"characters/{Uri.EscapeDataString(id)}", requestBody),
            "create_variant" => await TagDexLibrary.LibraryRequest(HttpMethod.Post, $"characters/{Uri.EscapeDataString(id)}/variants", requestBody),
            "update_variant" => await TagDexLibrary.LibraryRequest(HttpMethod.Put, $"variants/{Uri.EscapeDataString(id)}", requestBody),
            "upload_image" => await TagDexLibrary.LibraryRequest(HttpMethod.Post, $"variants/{Uri.EscapeDataString(id)}/images", requestBody),
            "update_image" => await TagDexLibrary.LibraryRequest(HttpMethod.Put, $"images/{Uri.EscapeDataString(id)}", requestBody),
            "favorite" => await TagDexLibrary.LibraryRequest(HttpMethod.Post, "favorites", requestBody),
            "resolve_conflict" => await TagDexLibrary.LibraryRequest(HttpMethod.Post, $"conflicts/{Uri.EscapeDataString(id)}/resolve", requestBody),
            _ => new JObject() { ["ok"] = false, ["error"] = "Unknown library action.", ["code"] = "invalid_action" }
        };
    }

    /// <summary>Lists favorites, conflicts, or entity history.</summary>
    public async Task<JObject> TagDexLibraryReview(Session session, string view, string id = "", int offset = 0, int limit = 50)
    {
        string path = view switch
        {
            "favorites" => "favorites",
            "conflicts" => $"conflicts?offset={Math.Max(0, offset)}&limit={Math.Clamp(limit, 1, 250)}",
            "history" => $"history/{Uri.EscapeDataString(id)}?offset={Math.Max(0, offset)}&limit={Math.Clamp(limit, 1, 250)}",
            _ => null
        };
        return path is null ? new JObject() { ["ok"] = false, ["error"] = "Unknown library view." }
            : await TagDexLibrary.LibraryRequest(HttpMethod.Get, path);
    }

    /// <summary>Fetches the authoritative recipe and reports exact local availability.</summary>
    public async Task<JObject> TagDexLibraryResolve(Session session, string variantId, string revision, string model = "")
    {
        JObject detail = await TagDexLibrary.LibraryRequest(HttpMethod.Get, $"variants/{Uri.EscapeDataString(variantId)}");
        JObject record = detail["record"] as JObject;
        if (record is null)
        {
            return detail;
        }
        if (!string.Equals(record.Value<string>("revision"), revision, StringComparison.Ordinal))
        {
            return new JObject() { ["ok"] = false, ["error"] = "The variant changed. Reload it before applying.", ["code"] = "stale_revision" };
        }
        JObject stateError = await ValidateVariantState(record);
        if (stateError is not null)
        {
            return stateError;
        }
        return TagDexLibrary.ResolveRecipe(record, model);
    }

    /// <summary>Rejects conflicted, archived, or parent-archived variants.</summary>
    public static async Task<JObject> ValidateVariantState(JObject record)
    {
        if (record.Value<bool?>("conflict") ?? false)
        {
            return new JObject() { ["ok"] = false, ["error"] = "Resolve this variant conflict before use.", ["code"] = "variant_conflict" };
        }
        JObject data = record["data"] as JObject ?? [];
        if (data.Value<bool?>("archived") ?? false)
        {
            return new JObject() { ["ok"] = false, ["error"] = "This variant is archived.", ["code"] = "variant_archived" };
        }
        string characterId = data.Value<string>("character_id");
        JObject parent = await TagDexLibrary.LibraryRequest(HttpMethod.Get, $"characters/{Uri.EscapeDataString(characterId ?? "")}");
        JObject parentRecord = parent["record"] as JObject;
        if (parentRecord is null)
        {
            return parent;
        }
        if ((parentRecord.Value<bool?>("conflict") ?? false) || (parentRecord["data"]?.Value<bool?>("archived") ?? false))
        {
            return new JObject() { ["ok"] = false, ["error"] = "The parent character is archived or conflicted.", ["code"] = "character_unavailable" };
        }
        return null;
    }

    /// <summary>Downloads one archive object into the normal LoRA folder after exact hash verification.</summary>
    public async Task<JObject> TagDexLibraryAcquire(Session session, WebSocket ws, string archiveSha256, string name, string version)
    {
        string sha = (archiveSha256 ?? "").ToLowerInvariant();
        if (!TagDexLibrary.IsSha256(sha))
        {
            return new JObject() { ["error"] = "The archive hash is invalid." };
        }
        TagDexLocal.ArchiveConfig cfg = TagDexLocal.Archive();
        if (!cfg.Enabled || string.IsNullOrWhiteSpace(cfg.Url))
        {
            return new JObject() { ["error"] = "The model archive is not configured." };
        }
        T2IModelHandler handler = Program.T2IModelSets.GetValueOrDefault("LoRA");
        if (handler is null)
        {
            return new JObject() { ["error"] = "The LoRA model handler is unavailable." };
        }
        SpokeModePolicy.AssertModelTreeWriteAllowed("download a library LoRA");
        string fileName = TagDexLibrary.DownloadName(name, version, sha);
        string outputPath = Path.Combine(handler.DownloadFolderPath, fileName);
        Directory.CreateDirectory(handler.DownloadFolderPath);
        if (File.Exists(outputPath))
        {
            return new JObject() { ["error"] = "A model already exists at the selected archive path." };
        }
        string tempPath = $"{outputPath}.{Guid.NewGuid():N}.tmp";
        using CancellationTokenSource cancel = new();
        try
        {
            Task download = TagDexLibrary.DownloadArchive(cfg, sha, tempPath, (current, total, speed) =>
            {
                ws.SendJsonNoError(new JObject() { ["current_percent"] = total > 0 ? current / (double)total : 0, ["per_second"] = speed }, API.WebsocketTimeout).Wait();
            }, cancel.Token);
            Task listener = Utilities.RunCheckedTask(async () =>
            {
                while (!download.IsCompleted && ws.State == WebSocketState.Open)
                {
                    JObject signal = await ws.ReceiveJson(4096, true);
                    if (signal?.Value<string>("signal") == "cancel")
                    {
                        cancel.Cancel();
                    }
                }
            });
            await download;
            File.Move(tempPath, outputPath, false);
            using (Program.RefreshLock.LockWrite())
            {
                handler.Refresh();
                Interlocked.Increment(ref ModelsAPI.ModelEditID);
            }
            try
            {
                await Program.Backends.RefreshRemoteModelInventoriesAsync();
            }
            catch (Exception ex)
            {
                Logs.Error($"Library LoRA '{fileName}' installed locally, but remote inventory refresh failed: {ex.ReadableString()}");
                FileInfo refreshInfo = new(outputPath);
                lock (TagDexLibrary.ReceiptLock)
                {
                    Dictionary<string, TagDexLibrary.InstallReceipt> refreshReceipts = TagDexLibrary.LoadReceipts();
                    refreshReceipts[sha] = new(sha, fileName, outputPath, refreshInfo.Length, refreshInfo.LastWriteTimeUtc.Ticks);
                    TagDexLibrary.SaveReceipts(refreshReceipts);
                }
                return new JObject() { ["error"] = "The verified model was installed, but remote model inventory refresh failed. Refresh backends before use.", ["local_mutation_completed"] = true };
            }
            string logicalName = handler.Models.Values.FirstOrDefault(model => Path.GetFullPath(model.RawFilePath) == Path.GetFullPath(outputPath))?.Name;
            if (logicalName is null)
            {
                FileInfo installedInfo = new(outputPath);
                lock (TagDexLibrary.ReceiptLock)
                {
                    Dictionary<string, TagDexLibrary.InstallReceipt> installedReceipts = TagDexLibrary.LoadReceipts();
                    installedReceipts[sha] = new(sha, fileName, outputPath, installedInfo.Length, installedInfo.LastWriteTimeUtc.Ticks);
                    TagDexLibrary.SaveReceipts(installedReceipts);
                }
                return new JObject() { ["error"] = "The verified model was installed, but inventory could not resolve it. Refresh models before use.", ["local_mutation_completed"] = true };
            }
            FileInfo info = new(outputPath);
            lock (TagDexLibrary.ReceiptLock)
            {
                Dictionary<string, TagDexLibrary.InstallReceipt> receipts = TagDexLibrary.LoadReceipts();
                receipts[sha] = new(sha, logicalName, outputPath, info.Length, info.LastWriteTimeUtc.Ticks);
                TagDexLibrary.SaveReceipts(receipts);
            }
            return new JObject() { ["success"] = true, ["logical_name"] = logicalName, ["archive_sha256"] = sha };
        }
        finally
        {
            if (File.Exists(tempPath))
            {
                File.Delete(tempPath);
            }
        }
    }

    /// <summary>Generates one transient image from an authoritative ready recipe.</summary>
    public async Task<JObject> TagDexLibraryGenerate(Session session, string variantId, string revision, JObject rawInput = null)
    {
        JObject detail = await TagDexLibrary.LibraryRequest(HttpMethod.Get, $"variants/{Uri.EscapeDataString(variantId)}");
        JObject record = detail["record"] as JObject;
        if (record is null || record.Value<string>("revision") != revision)
        {
            return record is null ? detail : new JObject() { ["ok"] = false, ["error"] = "The variant changed. Reload it before generating.", ["code"] = "stale_revision" };
        }
        JObject stateError = await ValidateVariantState(record);
        if (stateError is not null)
        {
            return stateError;
        }
        string requestedModel = rawInput?.Value<string>("model") ?? "";
        JObject resolution = TagDexLibrary.ResolveRecipe(record, requestedModel);
        if (!(resolution.Value<bool?>("ready") ?? false))
        {
            return new JObject() { ["ok"] = false, ["error"] = "Download every required LoRA before generating.", ["code"] = "loras_not_ready", ["resolution"] = resolution };
        }
        JObject recipe = record["data"]?["recipe"] as JObject ?? [];
        JArray resolved = resolution["loras"] as JArray ?? [];
        JObject input = [];
        foreach (string key in new[] { "model", "width", "height", "steps", "cfgscale", "seed" })
        {
            if (rawInput?[key] is JToken value)
            {
                input[key] = value.DeepClone();
            }
        }
        input.Merge(new JObject()
        {
            ["prompt"] = recipe.Value<string>("prompt") ?? "",
            ["negativeprompt"] = recipe.Value<string>("negative_prompt") ?? "",
            ["loras"] = new JArray(resolved.Values<JObject>().Select(row => row.Value<string>("logical_name"))),
            ["loraweights"] = new JArray(resolved.Values<JObject>().Select(row => (row.Value<double?>("weight") ?? 1).ToString(CultureInfo.InvariantCulture))),
            ["donotsave"] = true
        }, new JsonMergeSettings() { MergeArrayHandling = MergeArrayHandling.Replace });
        string checkpoint = recipe.Value<string>("checkpoint") ?? "";
        if (!string.IsNullOrWhiteSpace(checkpoint))
        {
            input["model"] = checkpoint;
        }
        JObject generated = await T2IAPI.GenerateText2Image(session, 1, input);
        string image = generated["images"]?.First?.ToString();
        return image is null ? generated : new JObject()
        {
            ["ok"] = true,
            ["image"] = image,
            ["recipe_snapshot"] = input.DeepClone()
        };
    }
}
