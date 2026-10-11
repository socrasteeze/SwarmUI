using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Core;
using SwarmUI.Utils;
using System.IO;
using System.Net.Http;

namespace SwarmUI.Builtin_PromptEnhanceExtension;

/// <summary>One configured writer-host endpoint: an address the Enhance feature can send a chat request
/// to, plus the settings that request needs.
/// <para>Modeled on <c>InterrogateBackends.Backends</c>: an ordered list rather than a single address, so
/// a second writer host or a hub-local fallback is a config line, not a refactor.</para></summary>
/// <param name="ID">Short identifier, used as the stored config key and the API/override value.</param>
/// <param name="Url">Base URL of the writer host, trailing slash stripped.</param>
/// <param name="Kind">Either <c>ollama</c> (<c>POST /api/chat</c>) or <c>openai</c> (an OpenAI-compatible
/// server such as LM Studio, <c>POST /v1/chat/completions</c>).</param>
/// <param name="Model">Writer model name to request.</param>
/// <param name="KeepAlive">Ollama <c>keep_alive</c> value, eg <c>30m</c>. Ignored for the <c>openai</c> kind.</param>
/// <param name="TimeoutSeconds">Request timeout in seconds.</param>
/// <param name="Enabled">Whether this endpoint should be considered at all.</param>
public record class PromptEnhanceEndpoint(string ID, string Url, string Kind, string Model, string KeepAlive, int TimeoutSeconds, bool Enabled);

/// <summary>Loads and holds the ordered list of configured writer-host endpoints, and probes them for
/// reachability.
/// <para>First enabled, healthy endpoint wins. The config lives outside the repo under
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

    /// <summary>Per-endpoint-ID cached health result, with the <see cref="Environment.TickCount64"/> it was taken at.</summary>
    private static readonly Dictionary<string, (bool Healthy, long CheckedAtMs)> HealthCache = [];

    /// <summary>Guards <see cref="HealthCache"/> against concurrent probes.</summary>
    private static readonly object HealthLock = new();

    /// <summary>Loads <see cref="Endpoints"/> from <see cref="ConfigPath"/>, writing a default config file
    /// on first run. Never throws: a missing or malformed file logs an error and leaves <see cref="Endpoints"/>
    /// empty, which the API surfaces as "no endpoints configured" rather than crashing extension init.</summary>
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
                    loaded.Add(new(
                        id,
                        url,
                        kind,
                        entry.Value<string>("model") ?? "",
                        entry.Value<string>("keep_alive") ?? "30m",
                        entry.Value<int?>("timeout_seconds") ?? 120,
                        entry.Value<bool?>("enabled") ?? true));
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
            ["_comment"] = "Ordered list. A single enabled endpoint is used directly; health is probed only after a failure, or when several endpoints are enabled. kind is 'ollama' or 'openai'.",
            ["endpoints"] = new JArray()
            {
                new JObject()
                {
                    ["id"] = "writer",
                    ["url"] = "http://127.0.0.1:11434",
                    ["kind"] = "ollama",
                    ["model"] = "huihui_ai/qwen3-vl-abliterated:8b-instruct",
                    ["keep_alive"] = "30m",
                    ["timeout_seconds"] = 120,
                    ["enabled"] = true
                }
            }
        };
    }

    /// <summary>The endpoint a request can use without a health probe.
    /// <para>An override that names one enabled endpoint is that endpoint. With no override, exactly one
    /// enabled endpoint is that endpoint. Several enabled endpoints, or an override that names nothing
    /// enabled, return null so the caller probes (or reports that nothing is configured).</para></summary>
    public static PromptEnhanceEndpoint EndpointForDirectUse(string overrideId)
    {
        List<PromptEnhanceEndpoint> enabled = [];
        foreach (PromptEnhanceEndpoint endpoint in Endpoints)
        {
            if (endpoint.Enabled)
            {
                enabled.Add(endpoint);
            }
        }
        if (!string.IsNullOrWhiteSpace(overrideId))
        {
            foreach (PromptEnhanceEndpoint endpoint in enabled)
            {
                if (endpoint.ID == overrideId)
                {
                    return endpoint;
                }
            }
            return null;
        }
        if (enabled.Count == 1)
        {
            return enabled[0];
        }
        return null;
    }

    /// <summary>The first enabled endpoint, or null when none are enabled.</summary>
    public static PromptEnhanceEndpoint FirstEnabled()
    {
        foreach (PromptEnhanceEndpoint endpoint in Endpoints)
        {
            if (endpoint.Enabled)
            {
                return endpoint;
            }
        }
        return null;
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
            HealthCache[endpoint.ID] = (healthy, Environment.TickCount64);
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
            if (HealthCache.TryGetValue(endpoint.ID, out (bool Healthy, long CheckedAtMs) cached) && (now - cached.CheckedAtMs) < HealthCacheMs)
            {
                return cached.Healthy;
            }
        }
        return null;
    }

    /// <summary>Host:port (or host) from an endpoint URL, for an error the user can act on.</summary>
    public static string HostLabel(PromptEnhanceEndpoint endpoint)
    {
        string host = endpoint?.Url ?? "";
        if (host.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
        {
            host = host["http://".Length..];
        }
        else if (host.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            host = host["https://".Length..];
        }
        return host;
    }

    /// <summary>Error text when a writer host refuses the connection. Ollama is named as local Ollama.</summary>
    public static string UnreachableMessage(PromptEnhanceEndpoint endpoint)
    {
        string who = endpoint is not null && endpoint.Kind == "ollama" ? "local Ollama" : "writer";
        return $"Prompt enhance: {who} at {HostLabel(endpoint)} not reachable";
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
    /// <c>GET /v1/models</c> for <c>openai</c>) within 5 seconds. Cached per endpoint ID for 5 seconds so a
    /// resolve-then-dispatch pair of calls does not double the probe cost.</summary>
    public static async Task<bool> IsHealthy(PromptEnhanceEndpoint endpoint)
    {
        if (endpoint is null)
        {
            return false;
        }
        bool? cached = CachedHealth(endpoint);
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
            using HttpResponseMessage response = await Utilities.UtilWebClient.GetAsync($"{endpoint.Url}{path}", HttpCompletionOption.ResponseHeadersRead, cancel.Token);
            return response.IsSuccessStatusCode;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>Picks the endpoint to actually use for one request. When <paramref name="overrideId"/> names
    /// a known enabled endpoint, only that one is probed. Otherwise walks <see cref="Endpoints"/> in order
    /// and returns the first enabled endpoint that answers its health probe. Null if none qualify.</summary>
    public static async Task<PromptEnhanceEndpoint> FirstHealthy(string overrideId)
    {
        List<PromptEnhanceEndpoint> endpoints = Endpoints;
        if (!string.IsNullOrWhiteSpace(overrideId))
        {
            PromptEnhanceEndpoint match = endpoints.FirstOrDefault(endpoint => endpoint.ID == overrideId && endpoint.Enabled);
            if (match is null)
            {
                return null;
            }
            return await IsHealthy(match) ? match : null;
        }
        foreach (PromptEnhanceEndpoint endpoint in endpoints)
        {
            if (!endpoint.Enabled)
            {
                continue;
            }
            if (await IsHealthy(endpoint))
            {
                return endpoint;
            }
        }
        return null;
    }

    /// <summary>The first enabled endpoint other than <paramref name="failed"/> that answers a health probe.
    /// Disabled entries are skipped without a probe. Null when nothing else is enabled and healthy, which
    /// is the single-endpoint case: the failed call already was the probe.</summary>
    public static async Task<PromptEnhanceEndpoint> FirstOtherHealthy(PromptEnhanceEndpoint failed)
    {
        foreach (PromptEnhanceEndpoint endpoint in Endpoints)
        {
            if (!endpoint.Enabled || (failed is not null && endpoint.ID == failed.ID))
            {
                continue;
            }
            if (await IsHealthy(endpoint))
            {
                return endpoint;
            }
        }
        return null;
    }

    /// <summary>Health for the status API. A fresh cache entry is reused. When at most one endpoint is
    /// enabled, an uncached entry is reported as unknown (null) instead of blocking the status call on a
    /// probe — EnhancePrompt uses that endpoint directly and records health from the writer call.
    /// Several enabled endpoints are still probed, through the same short cache.</summary>
    public static async Task<List<(PromptEnhanceEndpoint Endpoint, bool? Healthy)>> HealthAll()
    {
        int enabledCount = 0;
        foreach (PromptEnhanceEndpoint endpoint in Endpoints)
        {
            if (endpoint.Enabled)
            {
                enabledCount++;
            }
        }
        List<(PromptEnhanceEndpoint Endpoint, bool? Healthy)> results = [];
        foreach (PromptEnhanceEndpoint endpoint in Endpoints)
        {
            bool? cached = CachedHealth(endpoint);
            if (cached.HasValue)
            {
                results.Add((endpoint, cached.Value));
                continue;
            }
            if (enabledCount <= 1)
            {
                results.Add((endpoint, null));
                continue;
            }
            results.Add((endpoint, await IsHealthy(endpoint)));
        }
        return results;
    }
}
