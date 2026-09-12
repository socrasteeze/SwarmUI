using Newtonsoft.Json.Linq;
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
/// <param name="KeepAlive">Ollama <c>keep_alive</c> value, eg <c>30m</c> or <c>0</c>. Ignored for the openai transport.</param>
/// <param name="TimeoutSeconds">Overall request timeout, enforced independently of the shared client's connect timeout.</param>
/// <param name="SystemPrompt">The selected non-interactive profile text, verbatim.</param>
/// <param name="UserPrompt">The user's raw idea (already shielded by the caller).</param>
public record class PromptEnhanceRequest(string Url, string Kind, string Model, string KeepAlive, int TimeoutSeconds, string SystemPrompt, string UserPrompt);

/// <summary>Transport client for talking to a writer endpoint (Ollama or an OpenAI-compatible server), plus the
/// pure text-shaping helpers (Swarm-syntax shielding and hard-stop detection) the caller needs around it.</summary>
public static class PromptEnhanceClient
{
    /// <summary>Maximum number of characters allowed to accumulate in a writer reply before it is treated
    /// as a runaway stream and the request is aborted, so the API can fail open instead of buffering an
    /// unbounded reply.</summary>
    public const int MaxReplyLength = 32000;

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

    /// <summary>Builds the Ollama <c>/api/chat</c> request body.</summary>
    private static JObject BuildOllamaBody(PromptEnhanceRequest request)
    {
        return new JObject()
        {
            ["model"] = request.Model,
            ["stream"] = true,
            ["think"] = false,
            ["keep_alive"] = request.KeepAlive,
            ["messages"] = new JArray()
            {
                new JObject() { ["role"] = "system", ["content"] = request.SystemPrompt },
                new JObject() { ["role"] = "user", ["content"] = request.UserPrompt }
            },
            ["options"] = new JObject()
            {
                ["temperature"] = 0.7,
                ["seed"] = 7,
                ["num_predict"] = 2048
            }
        };
    }

    /// <summary>Builds the OpenAI-compatible <c>/v1/chat/completions</c> request body.</summary>
    private static JObject BuildOpenAIBody(PromptEnhanceRequest request)
    {
        return new JObject()
        {
            ["model"] = request.Model,
            ["stream"] = true,
            ["messages"] = new JArray()
            {
                new JObject() { ["role"] = "system", ["content"] = request.SystemPrompt },
                new JObject() { ["role"] = "user", ["content"] = request.UserPrompt }
            },
            ["temperature"] = 0.7,
            ["seed"] = 7,
            ["max_tokens"] = 2048
        };
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
