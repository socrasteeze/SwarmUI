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

    /// <summary>How long a health probe result is trusted before it is re-checked, in milliseconds.</summary>
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
            ["_comment"] = "Ordered list; the first enabled endpoint that answers its health probe is used. kind is 'ollama' or 'openai'.",
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

    /// <summary>Whether an endpoint answers its health probe (<c>GET /api/tags</c> for <c>ollama</c>,
    /// <c>GET /v1/models</c> for <c>openai</c>) within 5 seconds. Cached per endpoint ID for 5 seconds so a
    /// resolve-then-dispatch pair of calls does not double the probe cost.</summary>
    public static async Task<bool> IsHealthy(PromptEnhanceEndpoint endpoint)
    {
        if (endpoint is null)
        {
            return false;
        }
        long now = Environment.TickCount64;
        lock (HealthLock)
        {
            if (HealthCache.TryGetValue(endpoint.ID, out (bool Healthy, long CheckedAtMs) cached) && (now - cached.CheckedAtMs) < HealthCacheMs)
            {
                return cached.Healthy;
            }
        }
        bool healthy = await ProbeHealth(endpoint);
        lock (HealthLock)
        {
            HealthCache[endpoint.ID] = (healthy, Environment.TickCount64);
        }
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

    /// <summary>Probes every configured endpoint and reports each one's health, for the status API to
    /// show the whole list rather than just the one that would be picked.</summary>
    public static async Task<List<(PromptEnhanceEndpoint Endpoint, bool Healthy)>> HealthAll()
    {
        List<(PromptEnhanceEndpoint Endpoint, bool Healthy)> results = [];
        foreach (PromptEnhanceEndpoint endpoint in Endpoints)
        {
            results.Add((endpoint, await IsHealthy(endpoint)));
        }
        return results;
    }
}
