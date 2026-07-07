using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using SwarmUI.Core;
using SwarmUI.Utils;
using System.IO;

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
        WebServer.PageHeaderExtra = new(WebServer.PageHeaderExtra.Value + BuildHeadTags());
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
        context.Response.Headers.CacheControl = "no-cache";
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
