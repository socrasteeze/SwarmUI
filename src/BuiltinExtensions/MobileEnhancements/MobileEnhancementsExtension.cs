using FreneticUtilities.FreneticExtensions;
using FreneticUtilities.FreneticToolkit;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.IO;
using System.Text.RegularExpressions;

namespace SwarmUI.Builtin_MobileEnhancementsExtension;

/// <summary>Fork-owned extension that adds mobile-friendly UX and Progressive Web App (PWA) support to SwarmUI.
/// Most behavior stays in this extension; documented core API couplings support the standalone client.</summary>
public class MobileEnhancementsExtension : Extension
{
    /// <summary>Browser theme / PWA status-bar color, matched to the modern_dark background (<c>--background: #161616</c>).</summary>
    public static string ThemeColor = "#161616";

    /// <summary>Per-user guard against repeatedly materializing a full autocomplete response.</summary>
    public static SimpleRateLimiter<string> SimpleAutocompleteRateLimiter = new(12, TimeSpan.FromMinutes(1));

    /// <inheritdoc/>
    public override void OnInit()
    {
        ScriptFiles.Add("Assets/busy_indicator.js");
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
        // Theme stylesheets go in OtherAssets, NOT StyleSheetFiles - StyleSheetFiles would inject this on every
        // page regardless of which theme the user picked. Registered here in OnInit because WebServer.PreInit()
        // (which calls RegisteredThemes.Clear()) runs after OnPreInit but before OnInit.
        OtherAssets.Add("Assets/theme_mobile.css");
        // Layers the fork's touch/QoL overrides on top of the stock Modern Dark stack. modern.css supplies
        // structure plus derived variables but not the palette - modern_dark.css must stay in the list or
        // --background / --emphasis / --button-background resolve to nothing. That's why this uses the raw
        // ThemeData overload rather than the single-path extension convenience overload, which can only emit
        // one stylesheet. The theme file loads last of the three, so it wins the cascade against site.css,
        // genpage.css and modern.css at equal specificity without needing !important.
        Program.Web.RegisterTheme(new("mobile_dark", "Mobile Dark (Fork)",
            ["/css/themes/modern.css", "/css/themes/modern_dark.css", $"/ExtensionFile/{ExtensionName}/Assets/theme_mobile.css"], true));
        // Standalone mobile client ("/simple") assets. index.html is deliberately NOT registered - it is only
        // ever served by ServeMobileClient, which performs the auth check and template substitutions.
        OtherAssets.Add("Assets/m/m.css");
        OtherAssets.Add("Assets/m/m_state.js");
        OtherAssets.Add("Assets/m/m_gen.js");
        OtherAssets.Add("Assets/m/m_ui.js");
        OtherAssets.Add("Assets/m/m_autocomplete.js");
        OtherAssets.Add("Assets/m/m_create.js");
        OtherAssets.Add("Assets/m/m_images.js");
        OtherAssets.Add("Assets/m/m_models.js");
        OtherAssets.Add("Assets/m/m_app.js");
        API.RegisterAPICall(GetSimpleAutocompletions, false, Permissions.FundamentalGenerateTabAccess);
    }

    /// <summary>Returns the current user's autocomplete word list for the standalone client. This endpoint is
    /// called lazily on first prompt focus so a large tag CSV does not block the initial mobile render. When the
    /// configured source is <c>character_tags</c> and a sibling <c>all_tags</c> source exists, the general list is
    /// used instead: TagDex already owns character lookup and the <c>&lt;character:</c> prefix, so this gives the
    /// user both systems without manually swapping the setting.</summary>
    public async Task<JObject> GetSimpleAutocompletions(HttpContext context, Session session)
    {
        if (!SimpleAutocompleteRateLimiter.TryUseOne(session.User.UserID))
        {
            return new JObject() { ["error"] = "Autocomplete request rate limit reached.", ["error_id"] = "ratelimit" };
        }
        Settings.User.AutoCompleteData settings = session.User.Settings.AutoComplete;
        CancellationToken cancellationToken = context.RequestAborted;
        (string Source, string[] Entries) result;
        try
        {
            result = string.IsNullOrWhiteSpace(settings.Source)
                ? (settings.Source, null)
                : await AutoCompleteListHelper.GetDataWithSiblingFallbackAsync(settings.Source, "character_tags", "all_tags",
                    settings.EscapeParens, settings.Suffix, settings.SpacingMode, cancellationToken);
        }
        catch (InvalidDataException)
        {
            return new JObject()
            {
                ["autocompletions"] = null,
                ["configured_source"] = settings.Source,
                ["source"] = null,
                ["warning"] = "The configured autocomplete list is too large for the mobile client. Choose a smaller all-tags list."
            };
        }
        JArray completions = null;
        if (result.Entries is not null)
        {
            completions = [];
            for (int i = 0; i < result.Entries.Length; i++)
            {
                if ((i & 1023) == 0)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                }
                completions.Add(result.Entries[i]);
            }
        }
        return new JObject()
        {
            ["autocompletions"] = completions,
            ["configured_source"] = settings.Source,
            ["source"] = result.Source
        };
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
        // The standalone mobile client. Route is "/simple", not "/m" - a bare single-letter path segment
        // triggered command/context-menu autocomplete on the fork owner's phone keyboard when typing the URL.
        // ASP.NET Core normalizes trailing slashes in route TEMPLATES, so "/simple" and "/simple/" are the same
        // pattern - mapping both throws AmbiguousMatchException on every request. One mapping handles both URLs;
        // ServeMobileClient redirects the trailing-slash form itself, because a page served at "/simple/" breaks
        // the relative "API/..." URL from util.js sendJsonToServer and the WebSocket address from getWSAddress
        // (both strip after the last '/').
        WebServer.WebApp.MapGet("/simple", ServeMobileClient);
        // Legacy route. The client shipped at "/m" before the rename above, and that rename left nothing
        // behind, so every pre-rename entry point started landing on the 404 page. The installed PWA is the
        // one that matters: a home-screen app captures its start_url at INSTALL time and iOS never re-reads
        // manifest.json for an app that is already installed, so changing start_url does not migrate anyone
        // who installed before the rename - their app icon still opens "/m" forever. Bookmarks, home-screen
        // links and shared URLs have the same problem. Redirecting costs nothing and rescues all of them;
        // the rename was only ever about not having to TYPE a single-letter path, and a redirect nobody
        // types does not bring that back.
        WebServer.WebApp.MapGet("/m", ServeLegacyClientRedirect);
        WebServer.PageHeaderExtra = new(WebServer.PageHeaderExtra.Value + BuildHeadTags());
    }

    /// <summary>Redirects the pre-rename <c>/m</c> route to the current <c>/simple</c> client. Temporary
    /// (302) rather than permanent on purpose - a 301 is cached by the browser indefinitely and would make
    /// the path impossible to reuse later. Any query string is carried across; the fragment never reaches
    /// the server and is preserved by the browser across the redirect on its own.</summary>
    public async Task ServeLegacyClientRedirect(HttpContext context)
    {
        context.Response.Redirect($"/simple{context.Request.QueryString}");
        await context.Response.CompleteAsync();
    }

    /// <summary>Serves the standalone mobile client page at <c>/simple</c>. Mirrors the Razor pages' auth behavior
    /// (install check, then <see cref="WebUtil.HasValidLogin"/> - which short-circuits true when authorization is
    /// disabled) but with real HTTP redirects since this is not a rendered view. The HTML template uses simple
    /// token substitution: [VARY] for cache-busting, [REMAPS] for the same parameter-remap map Razor injects on
    /// the genpage, [HEADEXTRA] for the shared PWA head tags, and [TOAST] for the error-toast markup that
    /// site.js's showError() hard-requires (built by the same WebUtil.Toast helper as _Layout.cshtml so the
    /// markup cannot drift from upstream).</summary>
    public async Task ServeMobileClient(HttpContext context)
    {
        if (context.Request.Path.HasValue && context.Request.Path.Value.EndsWith('/'))
        {
            context.Response.Redirect("/simple");
            await context.Response.CompleteAsync();
            return;
        }
        if (!Program.ServerSettings.IsInstalled)
        {
            context.Response.Redirect("/Install");
            await context.Response.CompleteAsync();
            return;
        }
        if (!WebUtil.HasValidLogin(context))
        {
            context.Response.Redirect("/Login");
            await context.Response.CompleteAsync();
            return;
        }
        string html = File.ReadAllText($"{FilePath}Assets/m/index.html");
        string remaps = Newtonsoft.Json.JsonConvert.SerializeObject(SwarmUI.Text2Image.T2IParamTypes.ParameterRemaps);
        string toast = $"<div class=\"center-toast toast-error-box\" id=\"center_toast\">{WebUtil.Toast("error_toast_box", "Error", "", "error_toast_content", "", false)}</div>";
        html = html.Replace("[VARY]", Utilities.VaryID).Replace("[REMAPS]", remaps).Replace("[HEADEXTRA]", BuildHeadTags()).Replace("[TOAST]", toast);
        context.Response.ContentType = "text/html";
        context.Response.StatusCode = 200;
        await context.Response.WriteAsync(html);
        await context.Response.CompleteAsync();
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
