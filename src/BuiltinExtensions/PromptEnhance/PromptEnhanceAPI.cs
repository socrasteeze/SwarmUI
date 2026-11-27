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

    /// <summary>Every allowed strength value, in display order. What <c>resolved.strengths</c> reports when
    /// no profile resolves (rule 7: "all three when no profile resolves").</summary>
    private static readonly JArray AllStrengths = ["faithful", "expand", "full"];

    /// <summary>Allowed strength values for an edit profile - <c>full</c> excluded, per the edit-profile cap.</summary>
    private static readonly JArray EditProfileStrengths = ["faithful", "expand"];

    [API.APIDescription("Lists Prompt Enhance status for the given model and generation backend: known writer profiles, scoped endpoints and their health, and which profile (if any) resolves for this model (automatically, or forced via profile_override).",
        """
        "pack_version": "1.1.0+7ff564b9",
        "profiles": [{"id": "anima", "display": "Anima", "target_model": "Anima"}],
        "endpoints": [{"id": "writer", "kind": "ollama", "model": "some-writer-model", "label": "", "enabled": true, "healthy": true}],
        "unavailable_reason": null,
        "resolved": {"profile": "anima", "reason": null, "strengths": ["faithful", "expand", "full"], "mode": "auto", "resolved_mode": "t2i", "is_video": false}
        """)]
    public static async Task<JObject> ListPromptEnhanceStatus(Session session,
        [API.APIParameter("Name of the currently loaded model, used to resolve a writer profile.")] string model,
        [API.APIParameter("Optional profile ID to force, overriding automatic resolution - same semantics as EnhancePrompt's own profile_override.")] string profile_override = "",
        [API.APIParameter("Writer mode: 'auto', 't2i', or 'edit'. Auto resolves from resolved_mode on this call, because status does not carry image bytes. Known video profiles always use t2i.")] string mode = "auto",
        [API.APIParameter("Client-resolved writer mode, 't2i' or 'edit', used when mode is auto.")] string resolved_mode = "",
        [API.APIParameter("Exact Backend ID for generation. Empty uses the desktop writer scope (0).")] string exactbackendid = "")
    {
        T2IModel t2iModel = string.IsNullOrWhiteSpace(model) ? null : Program.MainSDModels.GetModel(model);
        PromptEnhanceProfile profile = PromptEnhanceProfiles.Resolve(t2iModel, profile_override, out string reason);
        string resolvedMode = PromptEnhanceProfiles.ResolveWriteModeForProfile(profile, mode, resolved_mode, false);
        if (profile is not null)
        {
            profile = PromptEnhanceProfiles.ApplyWriteMode(profile, resolvedMode);
        }
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
        int? backendId = PromptEnhanceEndpoints.BackendId(exactbackendid);
        bool unavailable = true;
        foreach ((PromptEnhanceEndpoint endpoint, bool? healthy) in await PromptEnhanceEndpoints.HealthAll(PromptEnhanceEndpoints.ForBackend(backendId)))
        {
            unavailable &= healthy == false;
            JObject row = new()
            {
                ["id"] = endpoint.ID,
                ["kind"] = endpoint.Kind,
                ["model"] = endpoint.Model,
                ["label"] = endpoint.Label ?? "",
                ["enabled"] = endpoint.Enabled,
                ["healthy"] = healthy.HasValue ? new JValue(healthy.Value) : JValue.CreateNull()
            };
            endpoints.Add(row);
        }
        // No resolved profile means the strength select cannot yet know which profile it will land on, so it
        // offers every strength rather than guessing - the server still enforces the edit-profile cap once a
        // profile actually resolves and an EnhancePrompt request is dispatched.
        JArray strengths = profile is null ? AllStrengths : (profile.IsEdit ? EditProfileStrengths : AllStrengths);
        return new JObject()
        {
            ["pack_version"] = PromptEnhanceProfiles.PackVersion,
            ["profiles"] = profiles,
            ["endpoints"] = endpoints,
            ["unavailable_reason"] = unavailable ? PromptEnhanceEndpoints.UnreachableMessage(backendId) : null,
            ["resolved"] = new JObject()
            {
                ["profile"] = profile?.ID,
                ["reason"] = reason,
                ["strengths"] = new JArray(strengths),
                ["mode"] = PromptEnhanceProfiles.NormalizeWriteMode(mode),
                ["resolved_mode"] = resolvedMode,
                ["is_video"] = profile is not null && PromptEnhanceProfiles.KnownVideoProfileIDs.Contains(profile.ID)
            }
        };
    }

    [API.APIDescription("Rewrites a typed idea into a prompt shaped for the currently loaded model, via a local writer LLM. Streams status and chunk updates, then a single terminal result/conflict/needs_input/passthrough/error object.",
        """
        "result": "...", "notes": "", "original": "...", "profile": "anima", "pack_version": "1.1.0+7ff564b9", "writer_model": "...", "endpoint": "writer", "cached": false, "strength": "full"
        """)]
    public static async Task<JObject> EnhancePrompt(WebSocket socket, Session session,
        [API.APIParameter("The user's raw typed idea to rewrite.")] string prompt,
        [API.APIParameter("Name of the currently loaded model, used to resolve a writer profile.")] string model,
        [API.APIParameter("Optional profile ID to force, overriding automatic resolution.")] string profile_override = "",
        [API.APIParameter("Preferred endpoint ID within the generation backend's writer scope.")] string endpoint_override = "",
        [API.APIParameter("Enhance Strength: 'faithful' (send unchanged), 'expand' (permit restrained additions), or 'full' (build a complete scene) - default 'full'. Blank/unrecognized falls back to 'full'; capped to 'expand' on an edit profile.")] string strength = "full",
        [API.APIParameter("Optional video task for video profiles: 'T2VA', 'I2VA', 'FL2VA' or 'L2VA'. Ignored for image profiles.")] string video_task = "",
        [API.APIParameter("Optional clip length in seconds for video profiles. Ignored for image profiles, or when 0.")] double video_duration = 0,
        [API.APIParameter("Writer mode: 'auto', 't2i', or 'edit'. Auto is edit when reference images are present, otherwise t2i. The server resolves auto again from the images on this request. Known video profiles always use t2i.")] string mode = "auto",
        [API.APIParameter("Client-resolved writer mode, 't2i' or 'edit'. Used when mode is auto and this request carries no image bytes.")] string resolved_mode = "",
        [API.APIParameter("Reference images, init image first, then video end image, then prompt images. Sent for edit mode, and for MiniMax H3 even though that profile stays in t2i. Data URIs, raw base64, or output-relative paths. At most 4 are used, each downscaled to a 768px JPEG before the writer call.")] string[] images = null,
        [API.APIParameter("True when prompt image, audio, or video reference slots are populated; init and end frames do not count. For a MiniMax H3 profile, selects the Ref2VA workflow regardless of checkpoint name. Ignored for other profiles.")] bool video_has_references = false,
        [API.APIParameter("Optional comma-separated roles for images on a MiniMax H3 request, in the same order as images: init, end, or picture. Empty infers roles from video_task. Ignored for other profiles.")] string video_image_roles = "",
        [API.APIParameter("Writer seed. 0 uses the fixed default and the result cache. Any other value is a reroll: it skips the cache read, and its result replaces the cached one.")] int seed = 0,
        [API.APIParameter("Exact Backend ID for generation. Empty uses the desktop writer scope (0).")] string exactbackendid = "")
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
        await API.RunWebsocketHandlerCallWS(EnhancePrompt_Internal, session, (prompt, model, profile_override, endpoint_override, strength, video_task, video_duration, mode, resolved_mode, images, video_has_references, video_image_roles, seed, exactbackendid), socket);
        return null;
    }

    /// <summary>Internal handler: resolves a profile and endpoint, dispatches (or reuses a cached reply from)
    /// the writer LLM, and reports status/chunks/the terminal frame back over the websocket.</summary>
    public static async Task EnhancePrompt_Internal(Session session, (string Prompt, string Model, string ProfileOverride, string EndpointOverride, string Strength, string VideoTask, double VideoDuration, string Mode, string ResolvedMode, string[] Images, bool VideoHasReferences, string VideoImageRoles, int Seed, string ExactBackendId) input, Action<JObject> output, bool isWS)
    {
        (string prompt, string model, string profileOverride, string endpointOverride, string strength, string videoTask, double videoDuration, string mode, string resolvedModeHint, string[] images, bool videoHasReferences, string videoImageRoles, int seed, string exactBackendId) = input;
        try
        {
            T2IModel t2iModel = string.IsNullOrWhiteSpace(model) ? null : Program.MainSDModels.GetModel(model);
            PromptEnhanceProfile profile = PromptEnhanceProfiles.Resolve(t2iModel, profileOverride, out string reason);
            bool hasImages = HasAnyImage(images);
            string resolvedMode = PromptEnhanceProfiles.ResolveWriteModeForProfile(profile, mode, resolvedModeHint, hasImages);
            if (profile is not null)
            {
                profile = PromptEnhanceProfiles.ApplyWriteMode(profile, resolvedMode);
            }
            if (profile is null)
            {
                output(new JObject() { ["passthrough"] = true, ["reason"] = reason });
                return;
            }
            int? backendId = PromptEnhanceEndpoints.BackendId(exactBackendId);
            List<PromptEnhanceEndpoint> scoped = PromptEnhanceEndpoints.ForBackend(backendId);
            PromptEnhanceEndpoint endpoint = await PromptEnhanceEndpoints.FirstHealthy(scoped.OrderByDescending(candidate => candidate.ID == endpointOverride));
            if (endpoint is null)
            {
                output(Unavailable(backendId));
                return;
            }
            bool h3 = string.Equals(profile.ID, "minimax-h3", StringComparison.OrdinalIgnoreCase);
            string originalPrompt = prompt;
            if (h3)
            {
                prompt = PromptEnhanceClient.NormalizeH3ImageTags(prompt);
            }
            string shielded = PromptEnhanceClient.Shield(prompt, out List<string> extracted);
            if (PromptEnhanceProfiles.KnownVideoProfileIDs.Contains(profile.ID))
            {
                string workflow = PromptEnhanceClient.WorkflowForVideoProfile(profile.ID, model, videoHasReferences);
                shielded = $"{PromptEnhanceClient.BuildVideoHeader(videoTask, videoDuration, workflow)}{shielded}";
            }
            // Strength is applied after Shield, on the already-shielded prompt, so the directive text can never
            // interact with shielding - Unshield below re-appends the extracted tokens exactly as it always did.
            string directed = PromptEnhanceClient.ApplyStrength(prompt, shielded, strength, profile.IsEdit, out string effectiveStrength, out string strengthNote, profile.ID);
            List<string> preparedImages = [];
            string imageDigest = "";
            if (resolvedMode == "edit" || (h3 && hasImages))
            {
                preparedImages = PromptEnhanceClient.PrepareReferenceImages(session, images, out imageDigest);
                if (preparedImages.Count > 0)
                {
                    if (h3)
                    {
                        string imageNote = PromptEnhanceClient.BuildH3ImageOrderNote(videoTask, videoImageRoles, videoHasReferences, preparedImages.Count);
                        if (imageNote.Length > 0)
                        {
                            directed = $"{imageNote}\n\n{directed}";
                        }
                    }
                    else
                    {
                        directed = $"{directed}\n\nReference images are attached in order as image 1 through image {preparedImages.Count}.";
                    }
                }
            }
            // Keyed on 'directed' (the exact text the writer receives), not on 'shielded' - the strength name alone
            // does not change when a directive's wording is revised, so a name-only key kept serving replies
            // written against the old wording. The resolved mode and the image digest keep an edit of the same
            // words, or the same words over different reference pixels, from colliding with a text-to-image rewrite.
            string key = PromptEnhanceCache.Key(directed, profile.ID, PromptEnhanceProfiles.PackVersion, endpoint.Model, effectiveStrength, resolvedMode, imageDigest, endpoint.Url);
            if (seed == 0 && PromptEnhanceCache.TryGet(key, out string cachedPromptPart))
            {
                // Notes are not cached (only the prompt part is), so a cache hit never carries notes.
                // Unwrap JSON positive_prompt here too: older cache entries may still hold a raw writer object.
                string cachedUnwrapped = PromptEnhanceClient.UnwrapJsonPrompt(cachedPromptPart);
                output(BuildResult(FinishPrompt(PromptEnhanceClient.Unshield(cachedUnwrapped, extracted), h3), "", originalPrompt, profile, endpoint, true, effectiveStrength, strengthNote, resolvedMode));
                return;
            }
            bool emittedChunk = false;
            async Task<string> RunChat(PromptEnhanceEndpoint target)
            {
                output(new JObject() { ["status"] = "running", ["profile"] = profile.ID, ["writer_model"] = target.Model, ["endpoint"] = target.ID, ["strength"] = effectiveStrength });
                PromptEnhanceRequest request = new(target.Url, target.Kind, target.Model, PromptEnhanceClient.EnhanceKeepAlive, target.TimeoutSeconds, profile.Text, directed, preparedImages, target.NumCtx, seed == 0 ? PromptEnhanceClient.DefaultSeed : seed);
                using CancellationTokenSource requestCancel = CancellationTokenSource.CreateLinkedTokenSource(Program.GlobalProgramCancel, session.SessInterrupt.Token);
                try
                {
                    string result = await PromptEnhanceClient.ChatStream(request, chunk =>
                    {
                        emittedChunk = true;
                        output(new JObject() { ["chunk"] = chunk });
                    }, requestCancel.Token);
                    PromptEnhanceUnload.RememberWriter(session, target);
                    PromptEnhanceEndpoints.RememberHealth(target, true);
                    return result;
                }
                catch (SwarmReadableErrorException ex) when (!PromptEnhanceEndpoints.IsUnreachable(ex))
                {
                    output(new JObject() { ["passthrough"] = true, ["reason"] = ex.Message });
                    return null;
                }
            }
            string reply = null;
            try
            {
                reply = await RunChat(endpoint);
            }
            catch (SwarmReadableErrorException ex) when (PromptEnhanceEndpoints.IsUnreachable(ex))
            {
                PromptEnhanceEndpoints.RememberHealth(endpoint, false);
                PromptEnhanceEndpoint alternate = emittedChunk ? null
                    : await PromptEnhanceEndpoints.FirstHealthy(scoped.Where(candidate => candidate.Url != endpoint.Url));
                if (alternate is null)
                {
                    output(Unavailable(backendId));
                    return;
                }
                endpoint = alternate;
                try
                {
                    reply = await RunChat(endpoint);
                }
                catch (SwarmReadableErrorException retryEx) when (PromptEnhanceEndpoints.IsUnreachable(retryEx))
                {
                    PromptEnhanceEndpoints.RememberHealth(endpoint, false);
                    output(Unavailable(backendId));
                    return;
                }
            }
            if (reply is null)
            {
                return;
            }
            // A retry may have moved to a different writer. Cache under the endpoint that actually answered.
            key = PromptEnhanceCache.Key(directed, profile.ID, PromptEnhanceProfiles.PackVersion, endpoint.Model, effectiveStrength, resolvedMode, imageDigest, endpoint.Url);
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
            // Split any NOTES: lines out of the reply per the profile pack's caller contract, unwrap a JSON
            // positive_prompt object when the writer returned one (Krea-2 / Output:json shape), and unshield
            // only the remaining prompt part - notes are never part of the applied prompt.
            (string promptPart, string notes) = PromptEnhanceClient.ExtractNotes(reply);
            promptPart = PromptEnhanceClient.UnwrapJsonPrompt(promptPart);
            if (string.IsNullOrWhiteSpace(promptPart))
            {
                // An empty (or notes-only) reply is not a success: never cache it, fail open instead.
                output(new JObject() { ["passthrough"] = true, ["reason"] = "The writer returned an empty reply" });
                return;
            }
            // Cache the raw (still-shielded) prompt part only, not the unshielded one - Unshield is applied
            // uniformly on every retrieval (cache hit or miss) using whatever tokens this call's own prompt
            // extracted. Notes are not cached: a NOTES: line is advisory text about this one writer run, not
            // meaningful to replay from a stale cache hit. Store the unwrapped prompt so later hits never
            // re-surface a JSON object into the prompt box.
            PromptEnhanceCache.Put(key, promptPart);
            output(BuildResult(FinishPrompt(PromptEnhanceClient.Unshield(promptPart, extracted), h3), notes, originalPrompt, profile, endpoint, false, effectiveStrength, strengthNote, resolvedMode));
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

    /// <summary>A terminal error for an unavailable writer on the selected machine.</summary>
    private static JObject Unavailable(int? backendId)
    {
        return new JObject() { ["error"] = PromptEnhanceEndpoints.UnreachableMessage(backendId), ["error_id"] = "prompt_enhance_unavailable" };
    }

    /// <summary>Builds the terminal result frame shared by the cache-hit and fresh-completion paths. Adds
    /// <c>strength_note</c> only when <paramref name="strengthNote"/> is non-null (eg the edit-profile cap),
    /// rather than always carrying an empty string like <c>notes</c> does.</summary>
    private static JObject BuildResult(string result, string notes, string original, PromptEnhanceProfile profile, PromptEnhanceEndpoint endpoint, bool cached, string effectiveStrength, string strengthNote, string resolvedMode)
    {
        JObject frame = new()
        {
            ["result"] = result,
            ["notes"] = notes ?? "",
            ["original"] = original,
            ["profile"] = profile.ID,
            ["pack_version"] = PromptEnhanceProfiles.PackVersion,
            ["writer_model"] = endpoint.Model,
            ["endpoint"] = endpoint.ID,
            ["cached"] = cached,
            ["strength"] = effectiveStrength,
            ["resolved_mode"] = resolvedMode
        };
        if (strengthNote is not null)
        {
            frame["strength_note"] = strengthNote;
        }
        return frame;
    }

    /// <summary>Cleans a prompt that will be shown or applied. Em dashes and en dashes are stripped for every
    /// profile, then the MiniMax H3 image-tag normalizer runs when <paramref name="h3"/> is true. Call this
    /// after notes are split off, so a <c>NOTES:</c> line is left alone.</summary>
    private static string FinishPrompt(string text, bool h3)
    {
        string cleaned = PromptEnhanceClient.SanitizeDashes(text);
        if (!h3)
        {
            return cleaned;
        }
        return PromptEnhanceClient.NormalizeH3ImageTags(cleaned);
    }

    /// <summary>True when <paramref name="images"/> contains at least one non-blank value.</summary>
    private static bool HasAnyImage(string[] images)
    {
        if (images is null)
        {
            return false;
        }
        for (int i = 0; i < images.Length; i++)
        {
            if (!string.IsNullOrWhiteSpace(images[i]))
            {
                return true;
            }
        }
        return false;
    }
}
