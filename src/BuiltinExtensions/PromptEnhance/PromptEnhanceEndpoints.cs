using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Core;
using SwarmUI.Utils;
using System.IO;
using System.Net.Http;

namespace SwarmUI.Builtin_PromptEnhanceExtension;

/// <summary>One configured writer-host endpoint: an address the Enhance feature can send a chat request
/// to, plus the settings that request needs.</summary>
/// <param name="ID">Short identifier, used as the stored config key and the API/override value.</param>
/// <param name="Url">Base URL of the writer host, trailing slash stripped.</param>
/// <param name="Kind">Either <c>ollama</c> (<c>POST /api/chat</c>) or <c>openai</c> (an OpenAI-compatible
/// server such as LM Studio, <c>POST /v1/chat/completions</c>).</param>
/// <param name="Model">Writer model name to request.</param>
/// <param name="KeepAlive">Ollama <c>keep_alive</c> value stored in the endpoint file. Enhance chat requests
/// send <c>5m</c> regardless (see <see cref="PromptEnhanceClient.EnhanceKeepAlive"/>). Ignored for the
/// <c>openai</c> kind.</param>
/// <param name="TimeoutSeconds">Request timeout in seconds.</param>
/// <param name="Enabled">Whether this endpoint should be considered at all.</param>
/// <param name="NumCtx">Optional Ollama <c>num_ctx</c>. Null omits the option so Ollama keeps its default
/// context length. Ignored for the <c>openai</c> kind.</param>
/// <param name="Label">Optional display name from the endpoint file. Blank falls back to the model, then the id.</param>
/// <param name="Backends">Exact generation backend IDs served by this endpoint. Null allows only loopback for the desktop.</param>
/// <param name="Machine">Optional machine name shown when the writer is unavailable.</param>
public record class PromptEnhanceEndpoint(string ID, string Url, string Kind, string Model, string KeepAlive, int TimeoutSeconds, bool Enabled, int? NumCtx = null, string Label = null, int[] Backends = null, string Machine = null)
{
    /// <summary>Whether the endpoint serves this backend, including legacy desktop loopback entries.</summary>
    public bool ServesBackend(int backendId)
    {
        return Backends?.Contains(backendId) ?? (backendId == 0 && Uri.TryCreate(Url, UriKind.Absolute, out Uri uri) && uri.IsLoopback);
    }
}

/// <summary>Loads and holds the ordered list of configured writer-host endpoints, and probes them for
/// reachability.
/// <para>The first healthy endpoint within the selected backend's scope wins. The config lives under
/// <see cref="Program.DataDir"/> so a user's writer-host address is never committed.</para></summary>
public static class PromptEnhanceEndpoints
{
    /// <summary>All configured endpoints, in the order they should be tried.</summary>
    public static List<PromptEnhanceEndpoint> Endpoints = [];

    /// <summary>Full path to the endpoint config file.</summary>
    public static string ConfigPath => $"{Program.DataDir}/PromptEnhance/endpoints.json";

    /// <summary>How long a health probe result is trusted before it is re-checked, in milliseconds.
    /// A failed or successful writer call records into the same cache, so a retry does not probe a host
    /// that just answered or just refused.</summary>
    private const long HealthCacheMs = 5000;

    /// <summary>Cached health by writer service, with the <see cref="Environment.TickCount64"/> it was taken at.</summary>
    private static readonly Dictionary<(string Url, string Kind), (bool Healthy, long CheckedAtMs)> HealthCache = [];

    /// <summary>Guards <see cref="HealthCache"/> against concurrent probes.</summary>
    private static readonly object HealthLock = new();

    /// <summary>Loads <see cref="Endpoints"/> from <see cref="ConfigPath"/>, writing a default config file
    /// on first run. Never throws: a missing or malformed file logs an error and leaves <see cref="Endpoints"/>
    /// empty so the API reports the writer as unavailable.</summary>
    public static void Init()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath));
            if (!File.Exists(ConfigPath))
            {
                File.WriteAllText(ConfigPath, BuildDefaultConfig().ToString(Formatting.Indented));
            }
            JObject data = JObject.Parse(File.ReadAllText(ConfigPath));
            List<PromptEnhanceEndpoint> loaded = [];
            HashSet<string> usedIds = [];
            if (data["endpoints"] is JArray array)
            {
                for (int index = 0; index < array.Count; index++)
                {
                    if (array[index] is not JObject entry)
                    {
                        continue;
                    }
                    string kind = (entry.Value<string>("kind") ?? "ollama").ToLowerFast();
                    if (kind != "ollama" && kind != "openai")
                    {
                        Logs.Error($"[PromptEnhance] Endpoint config entry {index} has an unsupported kind '{kind}' (expected 'ollama' or 'openai') - skipping it.");
                        continue;
                    }
                    string id = entry.Value<string>("id");
                    if (string.IsNullOrWhiteSpace(id))
                    {
                        id = $"endpoint{index}";
                    }
                    if (!usedIds.Add(id))
                    {
                        string original = id;
                        id = $"{id}{index}";
                        usedIds.Add(id);
                        Logs.Warning($"[PromptEnhance] Endpoint config entry {index} duplicates id '{original}' - renamed to '{id}'.");
                    }
                    string url = (entry.Value<string>("url") ?? "").TrimEnd('/');
                    string label = (entry.Value<string>("label") ?? "").Trim();
                    JToken backendIds = entry["backends"];
                    if (backendIds is not null && (backendIds is not JArray ids || ids.Any(value => value.Type != JTokenType.Integer || !int.TryParse(value.ToString(), out _))))
                    {
                        Logs.Error($"[PromptEnhance] Endpoint config entry {index} has invalid backend IDs - skipping it.");
                        continue;
                    }
                    loaded.Add(new(
                        id,
                        url,
                        kind,
                        entry.Value<string>("model") ?? "",
                        entry.Value<string>("keep_alive") ?? "5m",
                        entry.Value<int?>("timeout_seconds") ?? 120,
                        entry.Value<bool?>("enabled") ?? true,
                        entry.Value<int?>("num_ctx"),
                        string.IsNullOrWhiteSpace(label) ? null : label,
                        backendIds?.ToObject<int[]>(),
                        entry.Value<string>("machine")?.Trim()));
                }
            }
            Endpoints = loaded;
        }
        catch (Exception ex)
        {
            Logs.Error($"[PromptEnhance] Could not load endpoint config '{ConfigPath}': {ex.ReadableString()}");
            Endpoints = [];
        }
    }

    /// <summary>Builds the default config written on first run: one local Ollama endpoint, disabled by
    /// nothing (enabled), pointed at loopback so it never leaks a real host.</summary>
    private static JObject BuildDefaultConfig()
    {
        return new JObject()
        {
            ["_comment"] = "Ordered writer endpoints. List the Exact Backend IDs served by each endpoint in backends (0 is desktop or unpinned). Optional machine names the host in UI errors. kind is 'ollama' or 'openai'. Optional num_ctx caps Ollama context length.",
            ["endpoints"] = new JArray()
            {
                new JObject()
                {
                    ["id"] = "writer",
                    ["url"] = "http://127.0.0.1:11434",
                    ["kind"] = "ollama",
                    ["model"] = "huihui_ai/qwen3-vl-abliterated:8b-instruct",
                    ["keep_alive"] = "5m",
                    ["timeout_seconds"] = 120,
                    ["backends"] = new JArray(0),
                    ["machine"] = "desktop",
                    ["enabled"] = true
                }
            }
        };
    }

    /// <summary>Parses the generation target. An unpinned request uses the desktop. An invalid pin has no scope.</summary>
    public static int? BackendId(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return 0;
        }
        return int.TryParse(value, out int backendId) ? backendId : null;
    }

    /// <summary>Enabled writers for the selected backend, in config order.</summary>
    public static List<PromptEnhanceEndpoint> ForBackend(int? backendId)
    {
        return backendId is int id ? [.. Endpoints.Where(endpoint => endpoint.Enabled && endpoint.ServesBackend(id))] : [];
    }

    /// <summary>Records a health result for <paramref name="endpoint"/> so the next few seconds reuse it
    /// instead of probing again. A writer call that connected, or that failed to connect, is the probe.</summary>
    public static void RememberHealth(PromptEnhanceEndpoint endpoint, bool healthy)
    {
        if (endpoint is null)
        {
            return;
        }
        lock (HealthLock)
        {
            HealthCache[(endpoint.Url, endpoint.Kind)] = (healthy, Environment.TickCount64);
        }
    }

    /// <summary>The cached health of <paramref name="endpoint"/> when it is still inside <see cref="HealthCacheMs"/>,
    /// otherwise null.</summary>
    public static bool? CachedHealth(PromptEnhanceEndpoint endpoint)
    {
        if (endpoint is null)
        {
            return null;
        }
        long now = Environment.TickCount64;
        lock (HealthLock)
        {
            if (HealthCache.TryGetValue((endpoint.Url, endpoint.Kind), out (bool Healthy, long CheckedAtMs) cached) && (now - cached.CheckedAtMs) < HealthCacheMs)
            {
                return cached.Healthy;
            }
        }
        return null;
    }

    /// <summary>Error for the requested machine, including when the machine has no enabled endpoints.</summary>
    public static string UnreachableMessage(int? backendId)
    {
        PromptEnhanceEndpoint namedEndpoint = backendId is int id
            ? Endpoints.FirstOrDefault(endpoint => endpoint.ServesBackend(id) && !string.IsNullOrWhiteSpace(endpoint.Machine))
            : null;
        string machine = namedEndpoint?.Machine ?? backendId switch
        {
            0 => "desktop",
            18 or -2 => "laptop",
            null => "selected backend",
            _ => $"backend {backendId}"
        };
        return $"Can't enhance: {machine} Ollama is unavailable";
    }

    /// <summary>Whether <paramref name="ex"/> is a connection failure rather than a timeout or a bad reply.
    /// Those two transport messages are the ones <see cref="PromptEnhanceClient.ChatStream"/> uses when the
    /// host cannot be contacted at all.</summary>
    public static bool IsUnreachable(Exception ex)
    {
        string message = ex?.Message ?? "";
        return message.Contains("could not be reached", StringComparison.OrdinalIgnoreCase)
            || message.Contains("connection failed", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Whether an endpoint answers its health probe (<c>GET /api/tags</c> for <c>ollama</c>,
    /// <c>GET /v1/models</c> for <c>openai</c>) within 5 seconds. Status may reuse fresh cached results.</summary>
    private static async Task<bool> IsHealthy(PromptEnhanceEndpoint endpoint, bool useCache)
    {
        bool? cached = useCache ? CachedHealth(endpoint) : null;
        if (cached.HasValue)
        {
            return cached.Value;
        }
        bool healthy = await ProbeHealth(endpoint);
        RememberHealth(endpoint, healthy);
        return healthy;
    }

    /// <summary>Actually sends the health-probe request. Never throws: any failure (unreachable host,
    /// timeout, bad response) simply means "not healthy".</summary>
    private static async Task<bool> ProbeHealth(PromptEnhanceEndpoint endpoint)
    {
        try
        {
            string path = endpoint.Kind == "openai" ? "/v1/models" : "/api/tags";
            using CancellationTokenSource cancel = new(TimeSpan.FromSeconds(5));
            using HttpResponseMessage response = await PromptEnhanceClient.Client.GetAsync($"{endpoint.Url}{path}", HttpCompletionOption.ResponseHeadersRead, cancel.Token);
            return response.IsSuccessStatusCode;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>Finds the first eligible writer that answers a fresh health probe.</summary>
    public static async Task<PromptEnhanceEndpoint> FirstHealthy(IEnumerable<PromptEnhanceEndpoint> scoped)
    {
        HashSet<(string Url, string Kind)> checkedHosts = [];
        foreach (PromptEnhanceEndpoint endpoint in scoped)
        {
            if (checkedHosts.Add((endpoint.Url, endpoint.Kind)) && await IsHealthy(endpoint, false))
            {
                return endpoint;
            }
        }
        return null;
    }

    /// <summary>Health for scoped status rows. A lone writer uses its cached result, if any.</summary>
    public static async Task<List<(PromptEnhanceEndpoint Endpoint, bool? Healthy)>> HealthAll(List<PromptEnhanceEndpoint> scoped)
    {
        List<(PromptEnhanceEndpoint Endpoint, bool? Healthy)> results = [];
        foreach (PromptEnhanceEndpoint endpoint in scoped)
        {
            bool? healthy = scoped.Count == 1 ? CachedHealth(endpoint) : await IsHealthy(endpoint, true);
            results.Add((endpoint, healthy));
        }
        return results;
    }
}
