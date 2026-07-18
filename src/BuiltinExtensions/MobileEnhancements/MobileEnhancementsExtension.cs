using FreneticUtilities.FreneticExtensions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using SwarmUI.Core;
using SwarmUI.Utils;
using System.IO;
using System.Text.RegularExpressions;

namespace SwarmUI.Builtin_MobileEnhancementsExtension;

/// <summary>Fork-owned extension that adds mobile-friendly UX and Progressive Web App (PWA) support to SwarmUI.
/// Everything ships as new files under this extension folder so upstream merges stay clean - see docs/MobilePWA-Optimization-Plan.md.</summary>
public class MobileEnhancementsExtension : Extension
{
    /// <summary>Browser theme / PWA status-bar color, matched to the modern_dark background (<c>--background: #161616</c>).</summary>
    public static string ThemeColor = "#161616";

    /// <inheritdoc/>
    public override void OnInit()
    {
        ScriptFiles.Add("Assets/mobile_core.js");
        ScriptFiles.Add("Assets/mobile_fullview_touch.js");
        ScriptFiles.Add("Assets/mobile_network.js");
        ScriptFiles.Add("Assets/mobile_share.js");
        StyleSheetFiles.Add("Assets/mobile.css");
        OtherAssets.Add("Assets/offline.html");
        OtherAssets.Add("Assets/icons/icon-192.png");
        OtherAssets.Add("Assets/icons/icon-512.png");
        OtherAssets.Add("Assets/icons/icon-maskable-512.png");
        OtherAssets.Add("Assets/icons/apple-touch-icon-180.png");
    }

    /// <inheritdoc/>
    public override void OnPreLaunch()
    {
        // Serve the web manifest and service worker at root scope. A root-scoped service worker can control the whole
        // app (a worker served from /ExtensionFile/... would be scope-limited to that path), and needs no core edit
        // because OnPreLaunch runs after WebServer.Prep() has built WebApp but before it launches.
        WebServer.WebApp.MapGet("/manifest.json", ServeManifest);
        WebServer.WebApp.MapGet("/sw.js", ServeServiceWorker);
        WebServer.WebApp.MapGet("/ShareTarget", ServeShareTarget);
        WebServer.PageHeaderExtra = new(WebServer.PageHeaderExtra.Value + BuildHeadTags());
    }

    /// <summary>Matches the first http(s) URL embedded inside arbitrary shared text (Android share sheets often drop
    /// the link into the free-text <c>text</c> field rather than the dedicated <c>url</c> field).</summary>
    public static readonly Regex UrlInTextMatcher = new("https?://[^\\s\"'<>]+", RegexOptions.Compiled);

    /// <summary>Handles the PWA Web Share Target (<c>/ShareTarget</c>, GET). Extracts a Civitai model URL from the
    /// shared <c>url</c>/<c>text</c>/<c>title</c> query params and redirects to the main page carrying that URL in a
    /// <c>#downloadmodel=</c> hash flag, which the client reads to open + prefill the Model Downloader. Shares that
    /// contain no Civitai link still redirect (with an empty flag) so the user lands on the downloader, empty.</summary>
    public async Task ServeShareTarget(HttpContext context)
    {
        string shared = ExtractCivitaiUrl(context.Request.Query["url"], context.Request.Query["text"], context.Request.Query["title"]);
        string flag = shared is null ? "" : Uri.EscapeDataString(shared);
        // The fragment is preserved by the browser when it follows the redirect, and never reaches the server again.
        context.Response.Redirect($"/Text2Image#downloadmodel={flag}");
        await context.Response.CompleteAsync();
    }

    /// <summary>Finds the first Civitai model URL among the shared fields, or <c>null</c> if none is present. The
    /// <c>url</c> field is checked directly first, then every field is scanned for an embedded URL.</summary>
    public static string ExtractCivitaiUrl(string url, string text, string title)
    {
        if (IsCivitaiUrl(url))
        {
            return url.Trim();
        }
        foreach (string field in new[] { url, text, title })
        {
            if (string.IsNullOrWhiteSpace(field))
            {
                continue;
            }
            foreach (Match match in UrlInTextMatcher.Matches(field))
            {
                if (IsCivitaiUrl(match.Value))
                {
                    return match.Value;
                }
            }
        }
        return null;
    }

    /// <summary>Returns true when the given string is an absolute http(s) URL whose host is a Civitai domain
    /// (<c>civitai.com</c>, <c>.red</c>, or <c>.green</c>, plus subdomains) - the domains the Model Downloader supports.</summary>
    public static bool IsCivitaiUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return false;
        }
        if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out Uri parsed))
        {
            return false;
        }
        if (parsed.Scheme != "http" && parsed.Scheme != "https")
        {
            return false;
        }
        string host = parsed.Host.ToLowerFast();
        return host == "civitai.com" || host.EndsWith(".civitai.com")
            || host == "civitai.red" || host.EndsWith(".civitai.red")
            || host == "civitai.green" || host.EndsWith(".civitai.green");
    }

    /// <summary>Serves the PWA web manifest at <c>/manifest.json</c>.</summary>
    public async Task ServeManifest(HttpContext context)
    {
        context.Response.ContentType = "application/manifest+json";
        context.Response.StatusCode = 200;
        await context.Response.WriteAsync(File.ReadAllText($"{FilePath}Assets/manifest.json"));
        await context.Response.CompleteAsync();
    }

    /// <summary>Serves the service worker at root scope. The current <see cref="Utilities.VaryID"/> is injected so the
    /// worker's cache names roll on every server version, and <c>no-cache</c> lets browsers pick up worker updates promptly.</summary>
    public async Task ServeServiceWorker(HttpContext context)
    {
        context.Response.ContentType = "text/javascript";
        context.Response.Headers["Cache-Control"] = "no-cache";
        context.Response.StatusCode = 200;
        string body = File.ReadAllText($"{FilePath}Assets/sw.js");
        await context.Response.WriteAsync($"const SWARM_VARY = \"{Utilities.EscapeJsonString(Utilities.VaryID)}\";\n{body}");
        await context.Response.CompleteAsync();
    }

    /// <summary>Builds the extra <c>&lt;head&gt;</c> tags (manifest link, theme color, apple/mobile PWA meta, touch icon) injected on every page.</summary>
    public string BuildHeadTags()
    {
        string icons = "/ExtensionFile/MobileEnhancementsExtension/Assets/icons";
        return "\n<link rel=\"manifest\" href=\"/manifest.json\" />"
            + $"\n<meta name=\"theme-color\" content=\"{ThemeColor}\" />"
            + "\n<meta name=\"mobile-web-app-capable\" content=\"yes\" />"
            + "\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\" />"
            + "\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"black-translucent\" />"
            + "\n<meta name=\"apple-mobile-web-app-title\" content=\"SwarmUI\" />"
            + $"\n<link rel=\"apple-touch-icon\" href=\"{icons}/apple-touch-icon-180.png\" />";
    }
}
