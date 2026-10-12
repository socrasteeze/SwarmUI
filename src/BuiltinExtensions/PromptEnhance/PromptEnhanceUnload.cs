using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using System.Net.Http;
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

    /// <summary><see cref="Environment.TickCount64"/> before which another unload attempt is skipped.</summary>
    private static long NextAllowedAt = 0;

    /// <summary>HTTP client for the unload calls. The timeout is the whole bound: the generation path does
    /// not wait on this client at all.</summary>
    private static readonly HttpClient Client = new()
    {
        Timeout = RequestTimeout
    };

    /// <summary>Handler for <see cref="T2IEngine.PreGenerateEvent"/>. Starts an unload attempt and returns.
    /// Never throws.</summary>
    public static void OnPreGenerate(T2IEngine.PreGenerationEventParams args)
    {
        try
        {
            RequestUnload();
        }
        catch (Exception ex)
        {
            Logs.Debug($"[PromptEnhance] Writer unload was not started: {ex.ReadableString()}");
        }
    }

    /// <summary>Schedules at most one unload attempt per <see cref="DebounceMs"/>. The scheduled work is not
    /// awaited. Never throws.</summary>
    public static void RequestUnload()
    {
        try
        {
            if (!TryClaim())
            {
                return;
            }
            _ = Task.Run(UnloadAsync);
        }
        catch (Exception ex)
        {
            Logs.Debug($"[PromptEnhance] Writer unload was not started: {ex.ReadableString()}");
        }
    }

    /// <summary>True when this caller won the debounce window. Concurrent callers from one batch lose.</summary>
    private static bool TryClaim()
    {
        long now = Environment.TickCount64;
        while (true)
        {
            long allowed = Volatile.Read(ref NextAllowedAt);
            if (now < allowed)
            {
                return false;
            }
            if (Interlocked.CompareExchange(ref NextAllowedAt, now + DebounceMs, allowed) == allowed)
            {
                return true;
            }
        }
    }

    /// <summary>GET <c>/api/ps</c> on the active endpoint. When that endpoint is Ollama and its model is
    /// loaded, POST <c>/api/generate</c> with <c>keep_alive</c> 0. Every failure is logged at debug and
    /// swallowed.</summary>
    private static async Task UnloadAsync()
    {
        try
        {
            PromptEnhanceEndpoint endpoint = PromptEnhanceEndpoints.EndpointForDirectUse(null);
            if (endpoint is null)
            {
                endpoint = PromptEnhanceEndpoints.FirstEnabled();
            }
            if (endpoint is null || endpoint.Kind != "ollama" || string.IsNullOrWhiteSpace(endpoint.Model) || string.IsNullOrWhiteSpace(endpoint.Url))
            {
                return;
            }
            using HttpResponseMessage listed = await Client.GetAsync($"{endpoint.Url}/api/ps");
            if (!listed.IsSuccessStatusCode)
            {
                return;
            }
            string body = await listed.Content.ReadAsStringAsync();
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
            using HttpResponseMessage unloaded = await Client.SendAsync(post, HttpCompletionOption.ResponseHeadersRead);
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
