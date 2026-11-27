using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using System.Net.Http;
using System.Runtime.CompilerServices;
using System.Text;

namespace SwarmUI.Builtin_PromptEnhanceExtension;

/// <summary>Drops the active Ollama writer model when a Swarm generation starts, so the GPU is free for the
/// image. The check runs off the generation path. A failure here never fails or delays the generation.</summary>
public static class PromptEnhanceUnload
{
    /// <summary>Minimum gap between unload attempts. A batch fires one pre-generate event per image, and one
    /// attempt covers that burst.</summary>
    public const int DebounceMs = 5000;

    /// <summary>Timeout for the <c>/api/ps</c> check and for the unload post, each.</summary>
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(2);

    /// <summary>Last writer that answered each session on each backend scope.</summary>
    private static readonly ConditionalWeakTable<Session, Dictionary<int, PromptEnhanceEndpoint>> LastWriters = new();

    /// <summary>Per-writer timestamp before which another unload attempt is skipped.</summary>
    private static readonly ConcurrentDictionary<PromptEnhanceEndpoint, long> NextAllowedAt = new();

    /// <summary>Records the writer for this session and every backend alias served by the writer.</summary>
    public static void RememberWriter(Session session, PromptEnhanceEndpoint endpoint)
    {
        Dictionary<int, PromptEnhanceEndpoint> writers = LastWriters.GetOrCreateValue(session);
        lock (writers)
        {
            foreach (int backendId in endpoint.Backends ?? [0])
            {
                writers[backendId] = endpoint;
            }
        }
    }

    /// <summary>Gets the writer that answered on the selected backend for this session.</summary>
    private static PromptEnhanceEndpoint FindWriter(Session session, int? backendId)
    {
        if (session is null || backendId is not int id || !LastWriters.TryGetValue(session, out Dictionary<int, PromptEnhanceEndpoint> writers))
        {
            return null;
        }
        lock (writers)
        {
            return writers.GetValueOrDefault(id);
        }
    }

    /// <summary>Handler for <see cref="T2IEngine.PreGenerateEvent"/>. Starts an unload attempt and returns.
    /// Never throws.</summary>
    public static void OnPreGenerate(T2IEngine.PreGenerationEventParams args)
    {
        try
        {
            int? backendId = PromptEnhanceEndpoints.BackendId(args.UserInput.Get(T2IParamTypes.ExactBackendID, ""));
            PromptEnhanceEndpoint endpoint = FindWriter(args.UserInput.SourceSession, backendId);
            if (endpoint is null || endpoint.Kind != "ollama" || !TryClaim(endpoint))
            {
                return;
            }
            _ = Task.Run(() => UnloadAsync(endpoint));
        }
        catch (Exception ex)
        {
            Logs.Debug($"[PromptEnhance] Writer unload was not started: {ex.ReadableString()}");
        }
    }

    /// <summary>True when this caller won the debounce window. Concurrent callers from one batch lose.</summary>
    private static bool TryClaim(PromptEnhanceEndpoint endpoint)
    {
        long now = Environment.TickCount64;
        while (true)
        {
            long allowed = NextAllowedAt.GetOrAdd(endpoint, long.MinValue);
            if (now < allowed)
            {
                return false;
            }
            if (NextAllowedAt.TryUpdate(endpoint, now + DebounceMs, allowed))
            {
                return true;
            }
        }
    }

    /// <summary>GET <c>/api/ps</c> on the active endpoint. When that endpoint is Ollama and its model is
    /// loaded, POST <c>/api/generate</c> with <c>keep_alive</c> 0. Every failure is logged at debug and
    /// swallowed.</summary>
    private static async Task UnloadAsync(PromptEnhanceEndpoint endpoint)
    {
        try
        {
            using CancellationTokenSource listTimeout = new(RequestTimeout);
            using HttpResponseMessage listed = await PromptEnhanceClient.Client.GetAsync($"{endpoint.Url}/api/ps", listTimeout.Token);
            if (!listed.IsSuccessStatusCode)
            {
                return;
            }
            string body = await listed.Content.ReadAsStringAsync(listTimeout.Token);
            if (!ModelIsListed(body, endpoint.Model))
            {
                return;
            }
            JObject payload = new()
            {
                ["model"] = endpoint.Model,
                ["keep_alive"] = 0
            };
            using HttpRequestMessage post = new(HttpMethod.Post, $"{endpoint.Url}/api/generate")
            {
                Content = new StringContent(payload.ToString(Newtonsoft.Json.Formatting.None), Encoding.UTF8, "application/json")
            };
            using CancellationTokenSource unloadTimeout = new(RequestTimeout);
            using HttpResponseMessage unloaded = await PromptEnhanceClient.Client.SendAsync(post, HttpCompletionOption.ResponseHeadersRead, unloadTimeout.Token);
        }
        catch (Exception ex)
        {
            Logs.Debug($"[PromptEnhance] Writer unload failed: {ex.ReadableString()}");
        }
    }

    /// <summary>True when <paramref name="body"/> is an Ollama <c>/api/ps</c> payload whose <c>models</c>
    /// list names <paramref name="model"/> in <c>name</c> or <c>model</c>. A bad payload is false.</summary>
    public static bool ModelIsListed(string body, string model)
    {
        if (string.IsNullOrWhiteSpace(body) || string.IsNullOrWhiteSpace(model))
        {
            return false;
        }
        try
        {
            JObject parsed = JObject.Parse(body);
            if (parsed["models"] is not JArray models)
            {
                return false;
            }
            foreach (JToken token in models)
            {
                string name = token.Value<string>("name") ?? "";
                string modelField = token.Value<string>("model") ?? "";
                if (name.Equals(model, StringComparison.OrdinalIgnoreCase) || modelField.Equals(model, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
        }
        catch (Exception)
        {
            return false;
        }
        return false;
    }
}
