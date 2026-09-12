using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.Net.WebSockets;

namespace SwarmUI.Builtin_PromptEnhanceExtension;

/// <summary>API routes for rewriting a user's typed idea into a prompt shaped for the currently loaded image
/// model, via a local writer LLM.</summary>
[API.APIClass("Routes for Prompt Enhance - rewriting a typed idea into a prompt shaped for the loaded image model, using a local writer LLM.")]
public static class PromptEnhanceAPI
{
    /// <summary>Maximum accepted length, in characters, of the user's raw typed idea. Rejected outright
    /// before any processing (resolution, shielding, caching, or dispatch).</summary>
    public const int MaxPromptLength = 20000;

    /// <summary>Registers every route in this class.</summary>
    public static void Register()
    {
        API.RegisterAPICall(ListPromptEnhanceStatus, false, PromptEnhanceExtension.PermUsePromptEnhance);
        API.RegisterAPICall(EnhancePrompt, true, PromptEnhanceExtension.PermUsePromptEnhance);
    }

    [API.APIDescription("Lists Prompt Enhance status for the given model: known writer profiles, configured endpoints and their live health, and which profile (if any) resolves for this model (automatically, or forced via profile_override).",
        """
        "pack_version": "1.1.0+7ff564b9",
        "profiles": [{"id": "anima", "display": "Anima", "target_model": "Anima"}],
        "endpoints": [{"id": "writer", "kind": "ollama", "model": "some-writer-model", "enabled": true, "healthy": true}],
        "resolved": {"profile": "anima", "reason": null}
        """)]
    public static async Task<JObject> ListPromptEnhanceStatus(Session session,
        [API.APIParameter("Name of the currently loaded model, used to resolve a writer profile.")] string model,
        [API.APIParameter("Optional profile ID to force, overriding automatic resolution - same semantics as EnhancePrompt's own profile_override.")] string profile_override = "")
    {
        T2IModel t2iModel = string.IsNullOrWhiteSpace(model) ? null : Program.MainSDModels.GetModel(model);
        PromptEnhanceProfile profile = PromptEnhanceProfiles.Resolve(t2iModel, profile_override, out string reason);
        JArray profiles = [];
        foreach (PromptEnhanceProfile entry in PromptEnhanceProfiles.Profiles.Values)
        {
            profiles.Add(new JObject()
            {
                ["id"] = entry.ID,
                ["display"] = entry.Display,
                ["target_model"] = entry.TargetModel
            });
        }
        JArray endpoints = [];
        foreach ((PromptEnhanceEndpoint endpoint, bool healthy) in await PromptEnhanceEndpoints.HealthAll())
        {
            endpoints.Add(new JObject()
            {
                ["id"] = endpoint.ID,
                ["kind"] = endpoint.Kind,
                ["model"] = endpoint.Model,
                ["enabled"] = endpoint.Enabled,
                ["healthy"] = healthy
            });
        }
        return new JObject()
        {
            ["pack_version"] = PromptEnhanceProfiles.PackVersion,
            ["profiles"] = profiles,
            ["endpoints"] = endpoints,
            ["resolved"] = new JObject() { ["profile"] = profile?.ID, ["reason"] = reason }
        };
    }

    [API.APIDescription("Rewrites a typed idea into a prompt shaped for the currently loaded model, via a local writer LLM. Streams status and chunk updates, then a single terminal result/conflict/needs_input/passthrough/error object.",
        """
        "result": "...", "notes": "", "original": "...", "profile": "anima", "pack_version": "1.1.0+7ff564b9", "writer_model": "...", "endpoint": "writer", "cached": false
        """)]
    public static async Task<JObject> EnhancePrompt(WebSocket socket, Session session,
        [API.APIParameter("The user's raw typed idea to rewrite.")] string prompt,
        [API.APIParameter("Name of the currently loaded model, used to resolve a writer profile.")] string model,
        [API.APIParameter("Optional profile ID to force, overriding automatic resolution.")] string profile_override = "",
        [API.APIParameter("Optional endpoint ID to force, overriding automatic selection.")] string endpoint_override = "")
    {
        if (string.IsNullOrWhiteSpace(prompt))
        {
            await socket.SendAndReportError($"EnhancePrompt request from {session.User.UserID}", "No prompt was supplied.", API.WebsocketTimeout);
            return null;
        }
        if (prompt.Length > MaxPromptLength)
        {
            await socket.SendAndReportError($"EnhancePrompt request from {session.User.UserID}", $"The prompt is too long (over {MaxPromptLength} characters).", API.WebsocketTimeout);
            return null;
        }
        await API.RunWebsocketHandlerCallWS(EnhancePrompt_Internal, session, (prompt, model, profile_override, endpoint_override), socket);
        return null;
    }

    /// <summary>Internal handler: resolves a profile and endpoint, dispatches (or reuses a cached reply from)
    /// the writer LLM, and reports status/chunks/the terminal frame back over the websocket.</summary>
    public static async Task EnhancePrompt_Internal(Session session, (string Prompt, string Model, string ProfileOverride, string EndpointOverride) input, Action<JObject> output, bool isWS)
    {
        (string prompt, string model, string profileOverride, string endpointOverride) = input;
        try
        {
            T2IModel t2iModel = string.IsNullOrWhiteSpace(model) ? null : Program.MainSDModels.GetModel(model);
            PromptEnhanceProfile profile = PromptEnhanceProfiles.Resolve(t2iModel, profileOverride, out string reason);
            if (profile is null)
            {
                output(new JObject() { ["passthrough"] = true, ["reason"] = reason });
                return;
            }
            // The endpoint whose *config* (in particular its writer model name) drives the cache key is chosen
            // regardless of health: FirstHealthy(override) when one answers its probe, else simply the first
            // enabled endpoint in the config, which is known either way. This is what lets a repeat prompt
            // still hit the cache while the writer host is asleep.
            PromptEnhanceEndpoint healthyEndpoint = await PromptEnhanceEndpoints.FirstHealthy(endpointOverride);
            PromptEnhanceEndpoint endpoint = healthyEndpoint ?? PromptEnhanceEndpoints.Endpoints.FirstOrDefault(candidate => candidate.Enabled);
            if (endpoint is null)
            {
                output(new JObject() { ["passthrough"] = true, ["reason"] = "No Prompt Enhance writer endpoint is configured" });
                return;
            }
            bool healthy = healthyEndpoint is not null;
            string shielded = PromptEnhanceClient.Shield(prompt, out List<string> extracted);
            string key = PromptEnhanceCache.Key(shielded, profile.ID, PromptEnhanceProfiles.PackVersion, endpoint.Model);
            // Cache lookup happens before health gating, so a cache hit still answers even with nothing healthy.
            if (PromptEnhanceCache.TryGet(key, out string cachedPromptPart))
            {
                // Notes are not cached (only the prompt part is), so a cache hit never carries notes.
                output(BuildResult(PromptEnhanceClient.Unshield(cachedPromptPart, extracted), "", prompt, profile, endpoint, true));
                return;
            }
            if (!healthy)
            {
                output(new JObject() { ["passthrough"] = true, ["reason"] = "No writer endpoint is reachable" });
                return;
            }
            output(new JObject() { ["status"] = "running", ["profile"] = profile.ID, ["writer_model"] = endpoint.Model, ["endpoint"] = endpoint.ID });
            PromptEnhanceRequest request = new(endpoint.Url, endpoint.Kind, endpoint.Model, endpoint.KeepAlive, endpoint.TimeoutSeconds, profile.Text, shielded);
            string reply;
            try
            {
                // Linked so either a global shutdown or the user interrupting their own session stops the writer request.
                using CancellationTokenSource requestCancel = CancellationTokenSource.CreateLinkedTokenSource(Program.GlobalProgramCancel, session.SessInterrupt.Token);
                reply = await PromptEnhanceClient.ChatStream(request, chunk => output(new JObject() { ["chunk"] = chunk }), requestCancel.Token);
            }
            catch (SwarmReadableErrorException ex)
            {
                // Fail open: an unreachable/timed-out writer must never block generation on an un-enhanced prompt
                // that looks enhanced, so this is a passthrough, never an {error}.
                output(new JObject() { ["passthrough"] = true, ["reason"] = ex.Message });
                return;
            }
            if (PromptEnhanceClient.IsHardStop(reply, out string kind, out string line))
            {
                if (kind == "needs_input")
                {
                    Logs.Warning($"Prompt Enhance profile miss ({profile.ID}, {endpoint.Model}): {line}");
                    output(new JObject() { ["needs_input"] = line });
                }
                else
                {
                    output(new JObject() { ["conflict"] = line });
                }
                return;
            }
            // Split any NOTES: lines out of the reply per the profile pack's caller contract, and unshield only
            // the remaining prompt part - notes are never part of the applied prompt.
            (string promptPart, string notes) = PromptEnhanceClient.ExtractNotes(reply);
            if (string.IsNullOrWhiteSpace(promptPart))
            {
                // An empty (or notes-only) reply is not a success: never cache it, fail open instead.
                output(new JObject() { ["passthrough"] = true, ["reason"] = "The writer returned an empty reply" });
                return;
            }
            // Cache the raw (still-shielded) prompt part only, not the unshielded one - Unshield is applied
            // uniformly on every retrieval (cache hit or miss) using whatever tokens this call's own prompt
            // extracted. Notes are not cached: a NOTES: line is advisory text about this one writer run, not
            // meaningful to replay from a stale cache hit.
            PromptEnhanceCache.Put(key, promptPart);
            output(BuildResult(PromptEnhanceClient.Unshield(promptPart, extracted), notes, prompt, profile, endpoint, false));
        }
        catch (Exception ex)
        {
            // Anything unexpected (not the transport's own fail-open exception, already handled above) is a
            // genuine bug, not a "writer host asleep" case - report it as an error rather than passing an
            // un-enhanced prompt through silently.
            Logs.Error($"[PromptEnhance] EnhancePrompt failed for {session.User.UserID}: {ex.ReadableString()}");
            output(new JObject() { ["error"] = ex.Message });
        }
    }

    /// <summary>Builds the terminal result frame shared by the cache-hit and fresh-completion paths.</summary>
    private static JObject BuildResult(string result, string notes, string original, PromptEnhanceProfile profile, PromptEnhanceEndpoint endpoint, bool cached)
    {
        return new JObject()
        {
            ["result"] = result,
            ["notes"] = notes ?? "",
            ["original"] = original,
            ["profile"] = profile.ID,
            ["pack_version"] = PromptEnhanceProfiles.PackVersion,
            ["writer_model"] = endpoint.Model,
            ["endpoint"] = endpoint.ID,
            ["cached"] = cached
        };
    }
}
