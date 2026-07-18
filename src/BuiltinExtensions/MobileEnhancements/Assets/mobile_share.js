/**
 * MobileEnhancements share-target handler (fork extension).
 * Paired with the PWA manifest `share_target` and the server `/ShareTarget` route: when the user shares a
 * Civitai model link into the installed app, the server redirects to `/Text2Image#downloadmodel=<encoded url>`
 * and this reads that hash flag, opens the Utilities > Model Downloader tab, and prefills + triggers the URL
 * field so Civitai metadata loads automatically. See docs/MobilePWA-Optimization-Plan.md.
 */
class ShareTargetHandler {

    /** Hash-flag key the `/ShareTarget` server redirect uses to carry a shared model URL. */
    static FLAG = 'downloadmodel';

    /** Register a one-time session-ready hook so the flag is consumed only once the app (and downloader) is loaded. */
    constructor() {
        this.handled = false;
        sessionReadyCallbacks.push(() => this.consumeShareFlag());
    }

    /**
     * Read the shared URL out of `location.hash` (`#downloadmodel=<encoded>`).
     * Returns the (possibly empty) decoded value when the flag is present, or null when it is absent.
     */
    readSharedUrl() {
        let prefix = `#${ShareTargetHandler.FLAG}=`;
        if (!location.hash || !location.hash.startsWith(prefix)) {
            return null;
        }
        let raw = location.hash.substring(prefix.length);
        try {
            return decodeURIComponent(raw);
        }
        catch (e) {
            return '';
        }
    }

    /** True when the URL points at a Civitai domain the Model Downloader can load metadata for. */
    isCivitaiUrl(url) {
        let lower = url.toLowerCase();
        return lower.startsWith('https://civitai.com/') || lower.startsWith('https://civitai.red/') || lower.startsWith('https://civitai.green/');
    }

    /** If the share flag is present, clear it (so refresh/reconnect doesn't re-fire) and open the downloader. */
    consumeShareFlag() {
        if (this.handled) {
            return;
        }
        let shared = this.readSharedUrl();
        if (shared == null) {
            return;
        }
        this.handled = true;
        // Strip the fragment so a manual refresh or a session reconnect won't re-open the downloader.
        history.replaceState(null, '', location.pathname + location.search);
        this.openDownloader(shared);
    }

    /**
     * Switch to the Utilities > Model Downloader tab and, for a valid Civitai link, prefill the URL field and fire
     * the same input event the downloader listens on. Fail safe: a missing/non-Civitai link lands on it empty.
     */
    openDownloader(url) {
        let topTab = document.getElementById('utilitiestabbutton');
        let subTab = document.getElementById('modeldownloadertabbutton');
        if (!topTab || !subTab) {
            return;
        }
        topTab.click();
        subTab.click();
        if (!url || !this.isCivitaiUrl(url)) {
            return;
        }
        let field = document.getElementById('model_downloader_url');
        if (!field || typeof modelDownloader == 'undefined') {
            return;
        }
        field.value = url;
        triggerChangeFor(field);
    }
}

let shareTargetHandler = new ShareTargetHandler();
