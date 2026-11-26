using FreneticUtilities.FreneticExtensions;
using ImageMagick;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Media;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace SwarmUI.Builtin_PromptEnhanceExtension;

/// <summary>One dispatch-ready chat request to a writer endpoint.</summary>
/// <param name="Url">Base URL of the writer endpoint, eg <c>http://127.0.0.1:11434</c>. No trailing slash.</param>
/// <param name="Kind">Transport kind: <c>ollama</c> or <c>openai</c>.</param>
/// <param name="Model">Writer model name to request.</param>
/// <param name="KeepAlive">Ollama <c>keep_alive</c> value. Enhance requests use <see cref="PromptEnhanceClient.EnhanceKeepAlive"/>
/// (<c>5m</c>). Ignored for the openai transport.</param>
/// <param name="TimeoutSeconds">Overall request timeout, enforced independently of the shared client's connect timeout.</param>
/// <param name="SystemPrompt">The selected non-interactive profile text, verbatim.</param>
/// <param name="UserPrompt">The user's raw idea (already shielded by the caller).</param>
/// <param name="Images">Base64 JPEG reference images, longest side at most
/// <see cref="PromptEnhanceClient.MaxReferenceSide"/>. Used for an edit request, and for MiniMax H3
/// even though that profile stays in text-to-image writer mode. Null or empty when none were sent.</param>
/// <param name="NumCtx">Optional Ollama <c>num_ctx</c>. Null omits the option. The OpenAI transport ignores it.</param>
/// <param name="Seed">Writer sampling seed. A reroll sends a different one to get a different rewrite.</param>
public record class PromptEnhanceRequest(string Url, string Kind, string Model, string KeepAlive, int TimeoutSeconds, string SystemPrompt, string UserPrompt, IReadOnlyList<string> Images = null, int? NumCtx = null, int Seed = PromptEnhanceClient.DefaultSeed);

/// <summary>Transport client for talking to a writer endpoint (Ollama or an OpenAI-compatible server), plus the
/// pure text-shaping helpers (Swarm-syntax shielding and hard-stop detection) the caller needs around it.</summary>
public static class PromptEnhanceClient
{
    /// <summary>Maximum number of characters allowed to accumulate in a writer reply before it is treated
    /// as a runaway stream and the request is aborted, so the API can fail open instead of buffering an
    /// unbounded reply.</summary>
    public const int MaxReplyLength = 32000;

    /// <summary>Ollama <c>keep_alive</c> sent on a normal enhance request. Short enough that an unused writer
    /// drops on its own. Generation unload sends <c>0</c> separately and does not change this value.</summary>
    public const string EnhanceKeepAlive = "5m";

    /// <summary>Most reference images attached to one writer request. Init image, then video end image, then prompt images.</summary>
    public const int MaxReferenceImages = 4;

    /// <summary>Longest side, in pixels, of a reference image sent to the writer.</summary>
    public const int MaxReferenceSide = 768;

    /// <summary>Directive prepended to the shielded user prompt for strength <c>faithful</c>. The system
    /// prompt alone was polishing into glossy prose, so this keeps the user's words and order, allows only
    /// grammar fixes plus a few already-implied concrete details, and bans quality or style boilerplate.
    /// Shared by every profile that is not Krea 2. See <see cref="FaithfulDirectiveFor"/>.</summary>
    public const string FaithfulDirective = "Mode: rewrite\n\nKeep my words and their order nearly verbatim. Only fix grammar, and add at most a few concrete details that are already implied. Do not add quality or style boilerplate I did not write, including cinematic, photorealistic, high contrast, masterpiece, ultra detailed, 8k, dramatic lighting, bokeh, highly detailed, ultra HD, 4k, or close cousins. Prefer plain snapshot language over glossy descriptors. Do not mention these instructions in the prompt.\n\n";

    /// <summary>Directive prepended to the shielded user prompt for strength <c>expand</c>. Starts with the
    /// profile pack's <c>Mode: expand</c> switch, then caps additions at modest concrete scene details and
    /// about 1.5 times the user's length, with the same boilerplate ban as <see cref="FaithfulDirective"/>.</summary>
    public const string ExpandDirective = "Mode: expand\n\nAdd only modest concrete scene details: what is in the picture, where, and what is happening. Keep the result about 1.5 times my length. If my request is already detailed, only fix grammar and lightly polish it. Do not add quality or style boilerplate I did not write, including cinematic, photorealistic, high contrast, masterpiece, ultra detailed, 8k, dramatic lighting, bokeh, highly detailed, ultra HD, 4k, or close cousins. Prefer plain snapshot language over glossy descriptors. Do not mention these instructions in the prompt.\n\n";

    /// <summary>Directive prepended to the shielded user prompt for strength <c>full</c>. Still uses
    /// <c>Mode: expand</c> so the profile's expand rules apply, then allows a complete scene of ordinary
    /// setting, lighting, and framing. Bans quality or style boilerplate, does not name an unrequested art
    /// style, and tells the writer not to echo these instructions. Not allowed on an edit profile - see <see cref="ApplyStrength"/>.</summary>
    public const string FullDirective = "Mode: expand\n\nBuild this into a complete scene in this profile's output format. When I left them out, add ordinary setting, lighting, and framing as visible facts a snapshot would show. Keep every detail I gave. Do not add quality or style boilerplate I did not write, including cinematic, photorealistic, high contrast, masterpiece, ultra detailed, 8k, dramatic lighting, bokeh, highly detailed, ultra HD, 4k, or close cousins. Prefer plain snapshot language over glossy descriptors. Do not name an art style or a fancy medium I did not ask for. A plain \"photograph of\" or \"illustration of\" is acceptable only when a medium is needed and I named none. Do not mention these instructions in the prompt.\n\n";

    /// <summary>Faithful directive for Krea 2, including <c>krea-2.reference</c>. Tighter than
    /// <see cref="FaithfulDirective"/>: grammar fixes only, plus a missing medium, light, or shot size.
    /// An already-specific prompt is left alone. Ends in <c>Request:</c>.</summary>
    public const string KreaFaithfulDirective = "Mode: rewrite\n\nKeep my words and their order. Only fix grammar. You may only add a missing medium, light, or shot size. If my request is already specific, leave it alone apart from grammar. Write plain sentences, not a tag list. Do not add quality or style boilerplate I did not write, including cinematic, photorealistic, hyperrealistic, high contrast, masterpiece, ultra detailed, 8k, dramatic lighting, bokeh, highly detailed, ultra HD, 4k, or close cousins. Prefer plain snapshot language over glossy descriptors. Keep my exact quoted text. Do not mention these instructions in the prompt.\n\nRequest: ";

    /// <summary>Full-scene directive for Krea 2. Keeps <c>Mode: expand</c> and the <c>Request:</c> suffix.
    /// One natural-language paragraph of about 40 to 120 words, in clause order, capped at about 500 tokens.
    /// May fill a missing clause with an ordinary visible fact. Same quality-tag ban as <see cref="KreaExpandDirective"/>.</summary>
    public const string KreaFullDirective = "Mode: expand\n\nBuild the request below into one complete scene for Krea 2, as one natural-language paragraph of about 40 to 120 words. Put the most important facts first. When a part is present or you are adding it, use this order: medium and shot, subject, action or pose or expression, clothing and materials, setting and layout, camera angle framing and depth of field, lighting quality and direction, then style palette and grain. When I left a clause out, fill it with an ordinary visible fact in that order. Stay under about 500 tokens and never pad. If my request is already detailed, lightly polish it and keep my phrasing. Keep every detail I gave, including my subjects, actions, colors, spatial relationships, and exact quoted text. Do not add new objects, props, characters, or animals unless I clearly implied them. Do not invent highly specific clothing, colors, materials, or scene details I did not support. Honor a medium I named. A plain \"photograph of\" or \"illustration of\" is acceptable only when a medium is needed and I named none. Do not invent an art style or a fancy medium. Put text that must appear in the image in quotes. Describe what should be present. Do not write negations. Do not use weight syntax such as (word:1.2) or word:1.2. Write plain sentences, not a tag list. Do not add quality or style boilerplate I did not write, including cinematic, photorealistic, hyperrealistic, high contrast, masterpiece, ultra detailed, 8k, dramatic lighting, bokeh, highly detailed, ultra HD, 4k, or close cousins. Prefer plain snapshot language over glossy descriptors. For a realistic or photographic request, ordinary imperfections such as pores, flyaway hairs, or film grain are allowed. Do not pile those onto an illustration, and do not use them as quality-tag substitutes. Do not mention these instructions in the prompt.\n\nRequest: ";

    /// <summary>Expand directive for Krea 2. A bare <c>Mode: expand</c> drew a comma tag list from the 8B
    /// writer. This one asks for one 40 to 120 word paragraph in clause order. A short request, or one
    /// missing clauses, must still reach about 40 words by filling only those clauses with ordinary implied
    /// visible facts. Already detailed means most of those clauses are present, or the request is already
    /// around 40 words. A short complete sentence is not already detailed. Same quality-tag ban. Still
    /// begins with <c>Mode: expand</c> and ends in <c>Request:</c>.</summary>
    public const string KreaExpandDirective = "Mode: expand\n\nRewrite the request below as one natural-language paragraph of about 40 to 120 words. When the request is short, or is missing clauses such as medium and shot, camera, lighting, or setting, you must still reach about 40 words by filling only those missing clauses with ordinary implied visible facts. A short complete sentence is not already detailed. Already detailed means the request already has most of those clauses, or is already around 40 words or more. Only when it is already detailed, lightly polish it and keep my phrasing. Put the most important facts first. When a part is present or you are adding it, use this order: medium and shot, subject, action or pose or expression, clothing and materials, setting and layout, camera angle framing and depth of field, lighting quality and direction, then style palette and grain. Stay under about 500 tokens. Never pad with new objects or glossy filler. Filling a missing clause so a short or incomplete request reaches about 40 words is required, not padding. Keep my subjects, actions, colors, and spatial relationships. Do not add new objects, props, characters, or animals unless I clearly implied them. Do not invent highly specific clothing, colors, materials, or scene details I did not support. Honor a medium I named, such as \"photo of\" or \"illustration of\". Put text that must appear in the image in quotes. Describe what should be present. Do not write negations. Do not use weight syntax such as (word:1.2) or word:1.2. Write plain sentences, not a tag list. Do not add quality or style boilerplate I did not write, including cinematic, photorealistic, hyperrealistic, high contrast, masterpiece, ultra detailed, 8k, dramatic lighting, bokeh, highly detailed, ultra HD, 4k, or close cousins. Prefer plain snapshot language over glossy descriptors. For a realistic or photographic request, ordinary imperfections such as pores, flyaway hairs, or film grain are allowed. Do not pile those onto an illustration, and do not use them as quality-tag substitutes. Do not mention these instructions in the prompt.\n\nRequest: ";

    /// <summary>The faithful directive for <paramref name="profileId"/>. A Krea 2 id (equals or starts with
    /// <c>krea-2</c>, case-insensitive) uses <see cref="KreaFaithfulDirective"/>; every other profile uses
    /// <see cref="FaithfulDirective"/>.</summary>
    public static string FaithfulDirectiveFor(string profileId)
    {
        return IsKreaProfile(profileId) ? KreaFaithfulDirective : FaithfulDirective;
    }

    /// <summary>The expand directive for <paramref name="profileId"/>. A Krea 2 id uses
    /// <see cref="KreaExpandDirective"/>; every other profile uses <see cref="ExpandDirective"/>.</summary>
    public static string ExpandDirectiveFor(string profileId)
    {
        return IsKreaProfile(profileId) ? KreaExpandDirective : ExpandDirective;
    }

    /// <summary>Writer seed used when the caller does not ask for a reroll. Fixed so a repeat request is stable.</summary>
    public const int DefaultSeed = 7;

    /// <summary>The full-scene directive for <paramref name="profileId"/>. A Krea 2 id uses
    /// <see cref="KreaFullDirective"/>; every other profile uses <see cref="FullDirective"/>.</summary>
    public static string FullDirectiveFor(string profileId)
    {
        return IsKreaProfile(profileId) ? KreaFullDirective : FullDirective;
    }

    /// <summary>True when <paramref name="profileId"/> is a Krea 2 profile. The id equals or starts with
    /// <c>krea-2</c>, case-insensitive, so both <c>krea-2</c> and <c>krea-2.reference</c> match.</summary>
    private static bool IsKreaProfile(string profileId)
    {
        return (profileId ?? "").StartsWith("krea-2", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Shortcut tokens the profile pack itself recognizes at the start of a user message (see eg
    /// <c>anima.system.md</c>'s "Equivalent shortcuts") - a prompt already starting with one of these (or
    /// <c>Mode:</c>) is left completely alone by <see cref="ApplyStrength"/>, since the user is already talking
    /// to the writer directly.</summary>
    private static readonly string[] UserShortcuts = ["/rewrite", "/expand", "/positive", "/full", "/explain", "/json"];

    /// <summary>Shared HTTP client for every writer request. One instance so pooled connections are reused
    /// across calls; the connect timeout is fixed low here because the writer host is a LAN/tailnet machine,
    /// and the per-request overall timeout is enforced separately via a linked <see cref="CancellationTokenSource"/>.</summary>
    private static readonly HttpClient Client = BuildClient();

    /// <summary>Builds the shared client: a 5 second connect timeout and no overall client-level timeout, since
    /// the overall timeout is enforced per request instead (each writer endpoint configures its own).</summary>
    private static HttpClient BuildClient()
    {
        SocketsHttpHandler handler = new()
        {
            ConnectTimeout = TimeSpan.FromSeconds(5),
            PooledConnectionLifetime = TimeSpan.FromMinutes(10)
        };
        HttpClient client = new(handler)
        {
            Timeout = Timeout.InfiniteTimeSpan
        };
        client.DefaultRequestHeaders.UserAgent.ParseAdd($"SwarmUI/{Utilities.Version}");
        return client;
    }

    /// <summary>Matches the start of a Swarm angle-tag token, eg the <c>&lt;lora:</c> in <c>&lt;lora:a:0.7&gt;</c>.</summary>
    private static readonly Regex TagStartRegex = new(@"\G<[A-Za-z0-9_]+:", RegexOptions.Compiled);

    /// <summary>Matches one <c>__wildcard__</c>-style double-underscore token, non-greedy so adjacent tokens
    /// on the same line stay separate matches.</summary>
    private static readonly Regex WildcardTokenRegex = new(@"\G__[^\r\n]+?__", RegexOptions.Compiled);

    /// <summary>Matches a run of two or more commas, with only spaces/tabs (never newlines) between them - the
    /// orphaned separator left behind when a token sitting between two commas is removed.</summary>
    private static readonly Regex RepeatedCommaRegex = new(@",[ \t]*(?:,[ \t]*)+", RegexOptions.Compiled);

    /// <summary>Matches spaces/tabs directly before a comma.</summary>
    private static readonly Regex SpaceBeforeCommaRegex = new(@"[ \t]+,", RegexOptions.Compiled);

    /// <summary>Matches a comma followed by spaces/tabs (if any) and then a non-whitespace character, so the
    /// gap can be normalised to a single space without touching a comma that is followed by a newline.</summary>
    private static readonly Regex SpaceAfterCommaRegex = new(@",[ \t]*(?=\S)", RegexOptions.Compiled);

    /// <summary>Matches a run of two or more plain spaces/tabs (never newlines).</summary>
    private static readonly Regex DoubleSpaceRegex = new(@"[ \t]{2,}", RegexOptions.Compiled);

    /// <summary>Matches a comma (and any spaces/tabs immediately around it) at the very start of the text.</summary>
    private static readonly Regex LeadingCommaRegex = new(@"^[ \t]*,[ \t]*", RegexOptions.Compiled);

    /// <summary>Matches a comma (and any spaces/tabs immediately around it) at the very end of the text.</summary>
    private static readonly Regex TrailingCommaRegex = new(@"[ \t]*,[ \t]*$", RegexOptions.Compiled);

    /// <summary>Sends one chat request and streams the reply. Returns the full assembled reply; <paramref name="onChunk"/>
    /// is invoked once per non-empty content piece as it arrives. Throws <see cref="SwarmReadableErrorException"/>
    /// on any transport failure (unreachable endpoint, timeout, bad status, unknown <see cref="PromptEnhanceRequest.Kind"/>),
    /// with a one-line human message naming the endpoint URL.</summary>
    public static async Task<string> ChatStream(PromptEnhanceRequest request, Action<string> onChunk, CancellationToken cancel)
    {
        if (request.Kind != "ollama" && request.Kind != "openai")
        {
            throw new SwarmReadableErrorException($"Prompt Enhance endpoint '{request.Url}' has an unsupported transport kind '{request.Kind}'.");
        }
        using CancellationTokenSource timeoutCancel = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        timeoutCancel.CancelAfter(TimeSpan.FromSeconds(request.TimeoutSeconds));
        StringBuilder fullReply = new();
        try
        {
            string route = request.Kind == "ollama" ? "/api/chat" : "/v1/chat/completions";
            JObject body = request.Kind == "ollama" ? BuildOllamaBody(request) : BuildOpenAIBody(request);
            using HttpRequestMessage httpRequest = new(HttpMethod.Post, $"{request.Url}{route}")
            {
                Content = new StringContent(body.ToString(Newtonsoft.Json.Formatting.None), Encoding.UTF8, "application/json")
            };
            using HttpResponseMessage response = await Client.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, timeoutCancel.Token);
            response.EnsureSuccessStatusCode();
            await using Stream stream = await response.Content.ReadAsStreamAsync(timeoutCancel.Token);
            using StreamReader reader = new(stream);
            string line;
            while ((line = await reader.ReadLineAsync(timeoutCancel.Token)) != null)
            {
                (string content, bool done) = request.Kind == "ollama" ? ParseOllamaLine(line) : ParseOpenAILine(line);
                if (!string.IsNullOrEmpty(content))
                {
                    fullReply.Append(content);
                    if (fullReply.Length > MaxReplyLength)
                    {
                        throw new SwarmReadableErrorException("Writer reply exceeded 32k characters");
                    }
                    onChunk(content);
                }
                if (done)
                {
                    break;
                }
            }
        }
        catch (HttpRequestException ex)
        {
            throw new SwarmReadableErrorException($"Prompt Enhance endpoint '{request.Url}' could not be reached: {ex.Message}");
        }
        catch (OperationCanceledException)
        {
            if (cancel.IsCancellationRequested)
            {
                throw;
            }
            throw new SwarmReadableErrorException($"Prompt Enhance endpoint '{request.Url}' timed out after {request.TimeoutSeconds} seconds.");
        }
        catch (IOException ex)
        {
            throw new SwarmReadableErrorException($"Prompt Enhance endpoint '{request.Url}' connection failed: {ex.Message}");
        }
        return fullReply.ToString();
    }

    /// <summary>Builds the Ollama <c>/api/chat</c> request body. Reference images ride on the user message
    /// as the <c>images</c> array of raw base64 JPEGs. <c>options.num_ctx</c> is included only when
    /// <see cref="PromptEnhanceRequest.NumCtx"/> has a value.</summary>
    public static JObject BuildOllamaBody(PromptEnhanceRequest request)
    {
        JObject user = new()
        {
            ["role"] = "user",
            ["content"] = request.UserPrompt
        };
        if (request.Images is not null && request.Images.Count > 0)
        {
            JArray images = new();
            for (int i = 0; i < request.Images.Count; i++)
            {
                images.Add(request.Images[i]);
            }
            user["images"] = images;
        }
        JObject options = new()
        {
            ["temperature"] = 0.7,
            ["seed"] = request.Seed,
            ["num_predict"] = 2048
        };
        if (request.NumCtx.HasValue)
        {
            options["num_ctx"] = request.NumCtx.Value;
        }
        return new JObject()
        {
            ["model"] = request.Model,
            ["stream"] = true,
            ["think"] = false,
            ["keep_alive"] = request.KeepAlive,
            ["messages"] = new JArray()
            {
                new JObject() { ["role"] = "system", ["content"] = request.SystemPrompt },
                user
            },
            ["options"] = options
        };
    }

    /// <summary>Builds the OpenAI-compatible <c>/v1/chat/completions</c> request body. Reference images are
    /// <c>image_url</c> parts on the user message so a vision-capable OpenAI server sees the same pixels.</summary>
    private static JObject BuildOpenAIBody(PromptEnhanceRequest request)
    {
        JToken userContent = request.UserPrompt;
        if (request.Images is not null && request.Images.Count > 0)
        {
            JArray parts = new()
            {
                new JObject() { ["type"] = "text", ["text"] = request.UserPrompt }
            };
            for (int i = 0; i < request.Images.Count; i++)
            {
                parts.Add(new JObject()
                {
                    ["type"] = "image_url",
                    ["image_url"] = new JObject() { ["url"] = $"data:image/jpeg;base64,{request.Images[i]}" }
                });
            }
            userContent = parts;
        }
        return new JObject()
        {
            ["model"] = request.Model,
            ["stream"] = true,
            ["messages"] = new JArray()
            {
                new JObject() { ["role"] = "system", ["content"] = request.SystemPrompt },
                new JObject() { ["role"] = "user", ["content"] = userContent }
            },
            ["temperature"] = 0.7,
            ["seed"] = request.Seed,
            ["max_tokens"] = 2048
        };
    }

    /// <summary>Decodes up to <see cref="MaxReferenceImages"/> reference values into JPEG bytes whose longest
    /// side is at most <see cref="MaxReferenceSide"/>, and returns their raw base64 plus a digest of those
    /// bytes. A value may be a data URI, a JSON <c>{"data":"data:..."}</c> wrapper, raw base64, or an
    /// output-relative path. A value that cannot be decoded is skipped. Never throws.</summary>
    public static List<string> PrepareReferenceImages(Session session, string[] raw, out string digest)
    {
        List<string> encoded = [];
        List<byte[]> bytes = [];
        digest = "";
        if (raw is null)
        {
            return encoded;
        }
        for (int i = 0; i < raw.Length && encoded.Count < MaxReferenceImages; i++)
        {
            string item = raw[i];
            if (string.IsNullOrWhiteSpace(item))
            {
                continue;
            }
            try
            {
                byte[] jpeg = ToReferenceJpeg(session, item.Trim());
                if (jpeg is null || jpeg.Length == 0)
                {
                    continue;
                }
                bytes.Add(jpeg);
                encoded.Add(Convert.ToBase64String(jpeg));
            }
            catch (Exception ex)
            {
                Logs.Debug($"[PromptEnhance] Skipped a reference image: {ex.Message}");
            }
        }
        digest = PromptEnhanceCache.ImageDigest(bytes);
        return encoded;
    }

    /// <summary>Loads one reference value and returns a JPEG no larger than <paramref name="maxSide"/> on
    /// its longest side. Throws when the bytes are not an image; the caller skips that value.</summary>
    private static byte[] ToReferenceJpeg(Session session, string item)
    {
        string data = item;
        if (!data.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && !data.StartsWith("{", StringComparison.Ordinal) && session is not null && T2IParamTypes.IsOutputRelativeMediaPath(data))
        {
            data = T2IParamTypes.FilePathToDataString(session, data, "for a Prompt Enhance reference image");
        }
        ImageFile image;
        if (data.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            image = ImageFile.FromDataString(data);
        }
        else if (data.StartsWith("{", StringComparison.Ordinal))
        {
            JObject parsed = JObject.Parse(data);
            string wrapped = parsed.Value<string>("data") ?? "";
            image = ImageFile.FromDataString(wrapped);
        }
        else
        {
            image = ImageFile.FromBase64(data, MediaType.ImagePng);
        }
        return DownscaleJpeg(image, MaxReferenceSide);
    }

    /// <summary>Encodes <paramref name="image"/> as JPEG, shrinking it so the longest side is at most
    /// <paramref name="maxSide"/>. A smaller image is re-encoded without being enlarged.</summary>
    private static byte[] DownscaleJpeg(ImageFile image, int maxSide)
    {
        // ToMagick is cached on the file. Clone before a resize, and do not dispose the cached image.
        IMagickImage<ushort> source = image.ToMagick;
        uint width = source.Width;
        uint height = source.Height;
        if (width < 1 || height < 1)
        {
            return null;
        }
        uint longest = Math.Max(width, height);
        if (longest <= (uint)maxSide)
        {
            return ImageFile.MagickImageToJpgBytes(source);
        }
        double scale = maxSide / (double)longest;
        uint newWidth = (uint)Math.Max(1, (int)Math.Round(width * scale));
        uint newHeight = (uint)Math.Max(1, (int)Math.Round(height * scale));
        using IMagickImage<ushort> working = source.Clone();
        working.Resize(new MagickGeometry(newWidth, newHeight) { IgnoreAspectRatio = true });
        working.ResetPage();
        return ImageFile.MagickImageToJpgBytes(working);
    }

    /// <summary>Pulls the content delta and done-flag out of one line of an Ollama NDJSON chat stream. Pure and
    /// tolerant: blank lines and lines that fail to parse as the expected shape return <c>("", false)</c> rather than throwing.</summary>
    public static (string Content, bool Done) ParseOllamaLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return ("", false);
        }
        try
        {
            JObject parsed = JObject.Parse(line);
            JToken content = parsed["message"]?["content"];
            bool done = parsed["done"]?.Value<bool>() ?? false;
            return (content is null ? "" : $"{content}", done);
        }
        catch (Exception)
        {
            return ("", false);
        }
    }

    /// <summary>Pulls the content delta out of one SSE line of an OpenAI-compatible chat-completions stream.
    /// Pure and tolerant: blank lines, non-<c>data:</c> lines, and lines that fail to parse return <c>("", false)</c>.
    /// <c>"data: [DONE]"</c> returns <c>("", true)</c>.</summary>
    public static (string Content, bool Done) ParseOpenAILine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return ("", false);
        }
        string trimmed = line.Trim();
        if (!trimmed.StartsWith("data:"))
        {
            return ("", false);
        }
        string data = trimmed["data:".Length..].Trim();
        if (data == "[DONE]")
        {
            return ("", true);
        }
        try
        {
            JObject parsed = JObject.Parse(data);
            JToken content = parsed["choices"]?[0]?["delta"]?["content"];
            return (content is null ? "" : $"{content}", false);
        }
        catch (Exception)
        {
            return ("", false);
        }
    }

    /// <summary>Strips every Swarm prompt-syntax token out of <paramref name="prompt"/> so the writer LLM never sees
    /// or rephrases them, and returns the tokens in <paramref name="extracted"/> in their original order of appearance.
    /// Handles balanced-nesting angle-tag tokens (<c>&lt;lora:name:0.7&gt;</c>, <c>&lt;random:&lt;lora:a&gt;|&lt;lora:b&gt;&gt;</c>,
    /// <c>&lt;embed:name&gt;</c>, etc) and <c>__wildcard__</c> names. Repairs only what the removal orphans (doubled
    /// separators, stray leading/trailing commas) without otherwise rewriting the text.</summary>
    public static string Shield(string prompt, out List<string> extracted)
    {
        extracted = [];
        if (string.IsNullOrEmpty(prompt))
        {
            return prompt ?? "";
        }
        StringBuilder remaining = new();
        // Precomputed once so an unclosed '<' cannot force a full-remainder rescan at every later '<': once no
        // '>' exists at or after some index, none can exist at or after any later index either, so every '<'
        // from that point on is known in advance to never balance and is skipped without calling
        // FindBalancedTagEnd again.
        int lastCloseAngle = prompt.LastIndexOf('>');
        int i = 0;
        while (i < prompt.Length)
        {
            char c = prompt[i];
            if (c == '<' && i <= lastCloseAngle)
            {
                Match tagStart = TagStartRegex.Match(prompt, i);
                if (tagStart.Success)
                {
                    int end = FindBalancedTagEnd(prompt, i);
                    if (end > i)
                    {
                        extracted.Add(prompt[i..end]);
                        i = end;
                        continue;
                    }
                }
            }
            else if (c == '_' && i + 1 < prompt.Length && prompt[i + 1] == '_')
            {
                Match wildcard = WildcardTokenRegex.Match(prompt, i);
                if (wildcard.Success)
                {
                    extracted.Add(wildcard.Value);
                    i += wildcard.Length;
                    continue;
                }
            }
            remaining.Append(c);
            i++;
        }
        return CollapseSeparators(remaining.ToString());
    }

    /// <summary>Finds the end index (exclusive) of the balanced angle-tag token starting at <paramref name="start"/>
    /// (which must point at the opening <c>&lt;</c>), by tracking nesting depth across every <c>&lt;</c>/<c>&gt;</c>
    /// it contains. Returns -1 if the tag is never closed.</summary>
    private static int FindBalancedTagEnd(string text, int start)
    {
        int depth = 0;
        for (int i = start; i < text.Length; i++)
        {
            if (text[i] == '<')
            {
                depth++;
            }
            else if (text[i] == '>')
            {
                depth--;
                if (depth == 0)
                {
                    return i + 1;
                }
            }
        }
        return -1;
    }

    /// <summary>Repairs only what token removal can orphan, without reformatting the rest of the prompt or
    /// touching newline characters: collapses a run of repeated commas down to one, normalises the spacing
    /// immediately around a comma, collapses a run of plain double spaces, and strips a leading or trailing
    /// comma left at the very start/end of the text.</summary>
    private static string CollapseSeparators(string text)
    {
        text = RepeatedCommaRegex.Replace(text, ",");
        text = SpaceBeforeCommaRegex.Replace(text, ",");
        text = SpaceAfterCommaRegex.Replace(text, ", ");
        text = DoubleSpaceRegex.Replace(text, " ");
        text = LeadingCommaRegex.Replace(text, "");
        text = TrailingCommaRegex.Replace(text, "");
        return text;
    }

    /// <summary>Removes em dashes (U+2014) and en dashes (U+2013) from finished prompt text. A dash between
    /// digits becomes an ASCII hyphen, so a range such as <c>1-10</c> stays readable. Any other dash, including
    /// the spaces around a clause break, becomes <c>, </c>. <see cref="CollapseSeparators"/> then tidies repeated
    /// commas and spacing. ASCII hyphens already in the text are left alone. Null and empty input return
    /// <c>""</c>. Newlines are not reformatted. <c>FinishPrompt</c> calls this on every outgoing prompt after
    /// notes have been split off, so a <c>NOTES:</c> line is not rewritten.</summary>
    public static string SanitizeDashes(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return "";
        }
        bool replaced = false;
        StringBuilder remaining = new(text.Length);
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (c != '\u2014' && c != '\u2013')
            {
                remaining.Append(c);
                continue;
            }
            replaced = true;
            int end = i + 1;
            while (end < text.Length && (text[end] == '\u2014' || text[end] == '\u2013'))
            {
                end++;
            }
            int after = end;
            while (after < text.Length && (text[after] == ' ' || text[after] == '\t'))
            {
                after++;
            }
            int beforeSpaces = 0;
            while (beforeSpaces < remaining.Length && (remaining[remaining.Length - 1 - beforeSpaces] == ' ' || remaining[remaining.Length - 1 - beforeSpaces] == '\t'))
            {
                beforeSpaces++;
            }
            int leftIndex = remaining.Length - beforeSpaces - 1;
            bool leftDigit = leftIndex >= 0 && char.IsDigit(remaining[leftIndex]);
            bool rightDigit = after < text.Length && char.IsDigit(text[after]);
            bool nextPunct = after < text.Length && ",.;:!?)]}".IndexOf(text[after]) >= 0;
            remaining.Length -= beforeSpaces;
            if (leftDigit && rightDigit)
            {
                remaining.Append('-');
            }
            else if (!nextPunct)
            {
                remaining.Append(", ");
            }
            i = after - 1;
        }
        if (!replaced)
        {
            return text;
        }
        return CollapseSeparators(remaining.ToString());
    }

    /// <summary>Re-appends the tokens <see cref="Shield"/> extracted onto the writer's reply, so nothing the writer
    /// never saw is lost. No-op when <paramref name="extracted"/> is empty. Appends as <c>", tok1, tok2"</c> onto the
    /// end of the reply, or as a new line after it if the reply's prose already ends with a period.</summary>
    public static string Unshield(string reply, List<string> extracted)
    {
        if (extracted is null || extracted.Count == 0)
        {
            return reply;
        }
        string tokenList = string.Join(", ", extracted);
        string text = (reply ?? "").TrimEnd();
        if (text.EndsWith('.'))
        {
            return $"{text}\n{tokenList}";
        }
        return $"{text}, {tokenList}";
    }

    /// <summary>Video tasks a video profile's <c>Task:</c> header accepts (see <c>minimax-h3.system.md</c>).</summary>
    private static readonly HashSet<string> VideoTasks = ["T2VA", "I2VA", "FL2VA", "L2VA"];

    /// <summary>Matches a tagged informal image reference such as <c>&lt;Image 1&gt;</c>, <c>&lt;image_1&gt;</c>,
    /// or <c>&lt;Image1&gt;</c>. Official <c>&lt;Picture&gt;</c>, <c>&lt;Video&gt;</c>, <c>&lt;Audio&gt;</c>,
    /// and <c>&lt;Subject&gt;</c> tags do not match. Bare prose such as "image 1" does not match.</summary>
    private static readonly Regex H3InformalImageTagRegex = new(@"<\s*image[\s_]*(\d+)\s*>", RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>True when the model name has a case-insensitive <c>hybrid</c>, <c>ref2va</c>, or <c>erosmax</c> marker.
    /// <c>h3ErosMax</c> checkpoints are hybrids whose names carry no other marker.
    /// This is a filename helper only. <see cref="WorkflowForVideoProfile"/> does not use it.</summary>
    public static bool IsHybridCheckpoint(string modelName)
    {
        return (modelName ?? "").Contains("hybrid", StringComparison.OrdinalIgnoreCase)
            || (modelName ?? "").Contains("ref2va", StringComparison.OrdinalIgnoreCase)
            || (modelName ?? "").Contains("erosmax", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Writer workflow tag for a name with a filename reference marker, or null otherwise.
    /// <see cref="WorkflowForVideoProfile"/> does not consult this.</summary>
    public static string WorkflowForModel(string modelName)
    {
        return IsHybridCheckpoint(modelName) ? "Ref2VA" : null;
    }

    /// <summary>Returns <c>Ref2VA</c> when the profile is MiniMax H3 and the request has prompt references.
    /// The checkpoint name is ignored, so a plain FL2VA file, <c>10Eros_Max</c>, omniref, or prism name
    /// qualifies the same way a hybrid name does. Init and end frames do not count as references.
    /// Any other profile returns null, even when the filename contains a hybrid marker.</summary>
    public static string WorkflowForVideoProfile(string profileId, string modelName, bool hasReferences)
    {
        _ = modelName;
        if (hasReferences && string.Equals(profileId, "minimax-h3", StringComparison.OrdinalIgnoreCase))
        {
            return "Ref2VA";
        }
        return null;
    }

    /// <summary>Rewrites tagged informal image references to official <c>&lt;Picture N&gt;</c> tags,
    /// keeping the slot number. Already-official picture, video, audio, and subject tags are unchanged.
    /// Untagged prose is unchanged. Used only on the MiniMax H3 prompt path.</summary>
    public static string NormalizeH3ImageTags(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return text ?? "";
        }
        return H3InformalImageTagRegex.Replace(text, match => $"<Picture {match.Groups[1].Value}>");
    }

    /// <summary>One role per attached H3 image. <paramref name="roles"/> is a comma-separated
    /// <c>init</c>, <c>end</c>, or <c>picture</c> list in image order. A blank or mismatched list is
    /// inferred from <paramref name="task"/> and <paramref name="hasReferences"/>: keyframes follow the
    /// task, and only a reference request (or <c>T2VA</c>) numbers the remaining images as pictures.</summary>
    public static List<string> ResolveH3ImageRoles(string task, string roles, bool hasReferences, int imageCount)
    {
        List<string> parsed = [];
        if (imageCount <= 0)
        {
            return parsed;
        }
        if (!string.IsNullOrWhiteSpace(roles))
        {
            string[] tokens = roles.Split(',');
            if (tokens.Length == imageCount)
            {
                bool valid = true;
                for (int i = 0; i < tokens.Length; i++)
                {
                    string token = tokens[i].Trim().ToLowerFast();
                    if (token != "init" && token != "end" && token != "picture")
                    {
                        valid = false;
                        break;
                    }
                    parsed.Add(token);
                }
                if (valid)
                {
                    return parsed;
                }
                parsed.Clear();
            }
        }
        string normalized = (task ?? "").Trim().ToUpperInvariant();
        string first = null;
        string second = null;
        if (normalized == "I2VA")
        {
            first = "init";
        }
        else if (normalized == "L2VA")
        {
            first = "end";
        }
        else if (normalized == "FL2VA")
        {
            if (imageCount >= 2)
            {
                first = "init";
                second = "end";
            }
            else
            {
                first = "end";
            }
        }
        bool pictures = hasReferences || normalized == "T2VA" || normalized.Length == 0;
        for (int i = 0; i < imageCount; i++)
        {
            if (i == 0 && first is not null)
            {
                parsed.Add(first);
            }
            else if (i == 1 && second is not null)
            {
                parsed.Add(second);
            }
            else if (pictures)
            {
                parsed.Add("picture");
            }
            else
            {
                parsed.Add("frame");
            }
        }
        return parsed;
    }

    /// <summary>Legend prepended to a MiniMax H3 writer prompt when images were prepared.
    /// Keyframes are named from the task and are not <c>&lt;Picture N&gt;</c> slots.
    /// Prompt Images are <c>&lt;Picture 1&gt;</c>, <c>&lt;Picture 2&gt;</c>, and so on.</summary>
    public static string BuildH3ImageOrderNote(string task, string roles, bool hasReferences, int imageCount)
    {
        if (imageCount <= 0)
        {
            return "";
        }
        List<string> resolved = ResolveH3ImageRoles(task, roles, hasReferences, imageCount);
        string taskName = (task ?? "").Trim().ToUpperInvariant();
        if (taskName.Length == 0)
        {
            taskName = "T2VA";
        }
        StringBuilder note = new();
        note.Append("Attached images, in order. Ground appearance, clothing, setting, pose, and framing in what is visible.");
        int picture = 0;
        for (int i = 0; i < imageCount; i++)
        {
            string role = i < resolved.Count ? resolved[i] : "picture";
            note.Append('\n');
            if (role == "init")
            {
                note.Append($"Image {i + 1} is the Init Image, the first-frame keyframe for Task: {taskName}. It is not a <Picture N> slot.");
            }
            else if (role == "end")
            {
                note.Append($"Image {i + 1} is the Video End Image, the last-frame keyframe for Task: {taskName}. It is not a <Picture N> slot.");
            }
            else if (role == "picture")
            {
                picture++;
                note.Append($"Image {i + 1} is Prompt Image <Picture {picture}>.");
            }
            else
            {
                note.Append($"Image {i + 1} is an extra keyframe attachment for Task: {taskName}. It is not a <Picture N> slot.");
            }
        }
        if (picture == 0)
        {
            note.Append("\nNo Prompt Images are attached. Do not invent <Picture N> tags for these keyframes. Keep the official alignment line for this task.");
        }
        return note.ToString();
    }

    /// <summary>Builds the <c>Task:</c> / <c>Duration:</c> header prepended to a video profile's shielded prompt, from
    /// the frontend's current video settings. An unrecognized task falls back to <c>T2VA</c>; a non-positive duration
    /// is left out so the profile applies its own default. A non-empty <paramref name="workflow"/> adds
    /// <c>Workflow:</c> (a MiniMax H3 request with prompt references passes <c>Ref2VA</c>). Always ends with a blank line.</summary>
    public static string BuildVideoHeader(string task, double durationSeconds, string workflow = null)
    {
        string normalized = (task ?? "").Trim().ToUpperInvariant();
        string header = $"Task: {(VideoTasks.Contains(normalized) ? normalized : "T2VA")}\n";
        if (durationSeconds > 0 && double.IsFinite(durationSeconds))
        {
            header += $"Duration: {durationSeconds.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture)}\n";
        }
        if (!string.IsNullOrWhiteSpace(workflow))
        {
            header += $"Workflow: {workflow.Trim()}\n";
        }
        return $"{header}\n";
    }

    /// <summary>Applies the user-selected Enhance Strength to a shielded user prompt, by prepending
    /// <see cref="FaithfulDirectiveFor"/>, <see cref="ExpandDirectiveFor"/>, or <see cref="FullDirectiveFor"/>.
    /// Applied after <see cref="Shield"/> so the directive text never interacts with shielding - the caller must
    /// pass <paramref name="rawPrompt"/> (for the shortcut check, rule 2 below) and <paramref name="shieldedPrompt"/>
    /// (what the directive is actually prepended to) separately.
    /// <para>Rules, in order: (1) if <paramref name="rawPrompt"/>, trimmed of leading whitespace, already starts
    /// with one of the profile pack's own shortcuts (<c>/rewrite</c>, <c>/expand</c>, <c>/positive</c>,
    /// <c>/full</c>, <c>/explain</c>, <c>/json</c>, each matched as a whole token) or <c>Mode:</c>
    /// (case-insensitive), the user is already talking to the writer directly - no directive is added, and
    /// <paramref name="effectiveStrength"/> is <c>"user"</c>. (2) Otherwise <paramref name="strength"/> is
    /// lowercased and blank/unrecognized values fall back to <c>"full"</c> (the feature default). (3)
    /// <c>full</c> is not allowed on an edit profile (<paramref name="isEditProfile"/>) - it invents a new
    /// setting and contradicts the edit - so it is downgraded to <c>expand</c> and <paramref name="note"/> is
    /// set to explain the cap; <paramref name="note"/> is null in every other case.</para></summary>
    /// <param name="rawPrompt">The user's prompt exactly as submitted, before <see cref="Shield"/> - only used
    /// for the shortcut/<c>Mode:</c> check.</param>
    /// <param name="shieldedPrompt">The already-shielded prompt the directive (if any) is prepended to.</param>
    /// <param name="strength">The requested strength: <c>faithful</c>, <c>expand</c>, or <c>full</c>.</param>
    /// <param name="isEditProfile">Whether the resolved profile is an edit profile (<see cref="PromptEnhanceProfile.IsEdit"/>).</param>
    /// <param name="effectiveStrength">The strength actually applied: <c>faithful</c>, <c>expand</c>, <c>full</c>,
    /// or <c>user</c> when a shortcut/<c>Mode:</c> passthrough won.</param>
    /// <param name="note">A human-readable explanation when the requested strength was capped, else null.</param>
    /// <param name="profileId">Resolved profile ID. Selects the faithful, expand, and full-scene directives (<see cref="FaithfulDirectiveFor"/>, <see cref="ExpandDirectiveFor"/>, <see cref="FullDirectiveFor"/>).</param>
    public static string ApplyStrength(string rawPrompt, string shieldedPrompt, string strength, bool isEditProfile, out string effectiveStrength, out string note, string profileId = null)
    {
        note = null;
        string trimmedStart = (rawPrompt ?? "").TrimStart();
        if (trimmedStart.StartsWith("Mode:", StringComparison.OrdinalIgnoreCase) || StartsWithUserShortcut(trimmedStart))
        {
            effectiveStrength = "user";
            return shieldedPrompt;
        }
        string requested = (strength ?? "").Trim().ToLowerFast();
        if (requested != "faithful" && requested != "expand" && requested != "full")
        {
            requested = "full";
        }
        if (requested == "full" && isEditProfile)
        {
            effectiveStrength = "expand";
            note = "Full scene is not available for edit profiles; used Expand.";
        }
        else
        {
            effectiveStrength = requested;
        }
        return effectiveStrength switch
        {
            "expand" => $"{ExpandDirectiveFor(profileId)}{shieldedPrompt}",
            "full" => $"{FullDirectiveFor(profileId)}{shieldedPrompt}",
            _ => $"{FaithfulDirectiveFor(profileId)}{shieldedPrompt}"
        };
    }

    /// <summary>True if <paramref name="trimmedStart"/> starts with one of <see cref="UserShortcuts"/> as a
    /// whole token - the shortcut is not merely a prefix of a longer word (eg <c>/full</c> must not match
    /// <c>/fully</c>).</summary>
    private static bool StartsWithUserShortcut(string trimmedStart)
    {
        foreach (string shortcut in UserShortcuts)
        {
            if (trimmedStart.StartsWith(shortcut, StringComparison.Ordinal))
            {
                int nextIndex = shortcut.Length;
                if (nextIndex >= trimmedStart.Length || !char.IsLetterOrDigit(trimmedStart[nextIndex]))
                {
                    return true;
                }
            }
        }
        return false;
    }

    /// <summary>True if the writer's reply is a caller-contract hard stop: a reply that, after trimming leading
    /// whitespace, starts with <c>CONFLICT:</c> (unsatisfiable-by-one-image, <paramref name="kind"/> <c>"conflict"</c>)
    /// or <c>NEEDS INPUT:</c> (a profile miss on a non-interactive profile, <paramref name="kind"/> <c>"needs_input"</c>).
    /// <paramref name="line"/> is the reply's first line in either case.</summary>
    public static bool IsHardStop(string reply, out string kind, out string line)
    {
        kind = null;
        line = null;
        if (string.IsNullOrEmpty(reply))
        {
            return false;
        }
        string trimmedStart = reply.TrimStart();
        int newlineIndex = trimmedStart.IndexOf('\n');
        string firstLine = (newlineIndex < 0 ? trimmedStart : trimmedStart[..newlineIndex]).TrimEnd('\r');
        if (trimmedStart.StartsWith("CONFLICT:"))
        {
            kind = "conflict";
            line = firstLine;
            return true;
        }
        if (trimmedStart.StartsWith("NEEDS INPUT:"))
        {
            kind = "needs_input";
            line = firstLine;
            return true;
        }
        return false;
    }


    /// <summary>If a writer reply is a JSON object (optionally wrapped in a markdown fence) that carries
    /// <c>positive_prompt</c> (or a close synonym: <c>prompt</c>, <c>enhanced_prompt</c>, <c>rewritten_prompt</c>),
    /// returns that string so Apply/display get a bare prompt. Plain-text replies, non-object JSON, and objects
    /// without a recognized prompt key are returned unchanged. Empty <c>positive_prompt</c> becomes an empty
    /// string so the caller's empty-reply fail-open still fires.</summary>
    public static string UnwrapJsonPrompt(string reply)
    {
        if (string.IsNullOrWhiteSpace(reply))
        {
            return reply ?? "";
        }
        string trimmed = reply.Trim();
        string candidate = StripMarkdownFence(trimmed);
        if (candidate.Length == 0 || candidate[0] != '{')
        {
            return reply;
        }
        JObject obj;
        try
        {
            obj = JObject.Parse(candidate);
        }
        catch
        {
            return reply;
        }
        if (obj is null)
        {
            return reply;
        }
        string[] keys = ["positive_prompt", "prompt", "enhanced_prompt", "rewritten_prompt"];
        foreach (string key in keys)
        {
            if (obj.TryGetValue(key, StringComparison.OrdinalIgnoreCase, out JToken token) && token.Type == JTokenType.String)
            {
                return token.Value<string>() ?? "";
            }
        }
        return reply;
    }

    /// <summary>Strips a single leading/trailing markdown code fence (optional <c>json</c> language tag) from
    /// <paramref name="text"/>. Returns the inner body when a fence is present, otherwise the original text.</summary>
    public static string StripMarkdownFence(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return text ?? "";
        }
        string trimmed = text.Trim();
        if (!trimmed.StartsWith("```"))
        {
            return trimmed;
        }
        int firstNewline = trimmed.IndexOf('\n');
        if (firstNewline < 0)
        {
            return trimmed;
        }
        string body = trimmed[(firstNewline + 1)..];
        int fence = body.LastIndexOf("```", StringComparison.Ordinal);
        if (fence < 0)
        {
            return trimmed;
        }
        return body[..fence].Trim();
    }

    /// <summary>Splits any line that starts with <c>NOTES:</c> out of a writer reply, per the profile pack's
    /// caller contract (profiles-noninteractive rule 5-6): those lines are advisory text about the rewrite,
    /// not part of the prompt itself. Returns the reply with those lines removed as <c>PromptText</c>, and the
    /// extracted lines joined by newline as <c>Notes</c> (<c>""</c> if none were found).</summary>
    public static (string PromptText, string Notes) ExtractNotes(string reply)
    {
        string[] lines = (reply ?? "").Split('\n');
        List<string> keptLines = [];
        List<string> noteLines = [];
        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i].TrimEnd('\r');
            if (line.TrimStart().StartsWith("NOTES:"))
            {
                noteLines.Add(line.Trim());
            }
            else
            {
                keptLines.Add(line);
            }
        }
        return (string.Join("\n", keptLines), string.Join("\n", noteLines));
    }
}
