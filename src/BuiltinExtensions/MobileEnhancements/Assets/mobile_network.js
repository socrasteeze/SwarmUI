/**
 * MobileEnhancements — network resilience & polish (fork extension).
 *
 * Adds three decoupled, fail-safe helpers that make SwarmUI more pleasant on phones. Each relies on robust
 * browser signals rather than patching core request functions, so nothing breaks if core internals change:
 *   1. A "connection lost" banner driven by the browser online/offline events, plus a distinct "server is
 *      down" variant for the case where the network is fine but the SwarmUI process itself is not answering.
 *   2. Light haptic feedback when a generated image arrives (MutationObserver on the batch area).
 *   3. A screen wake-lock held during active generation so the phone doesn't sleep mid-run.
 * See docs/MobilePWA-Optimization-Plan.md (Phase 4).
 */
class MobileNetwork {

    /** localStorage key for the haptics preference. Shared with the /simple client (m_gen.js reads it,
     * m_app.js's More tab writes it) so one toggle governs both UIs; 'off' disables, 'on' enables, unset
     * falls back to the touch-device default. */
    static HapticsKey = 'm_client_haptics';

    /** Milliseconds between server probes while the server is known to be down. */
    static ProbeIntervalMs = 5000;

    /** Milliseconds before a single probe is abandoned and counted as a failure. */
    static ProbeTimeoutMs = 8000;

    constructor() {
        this.banner = null;
        this.hapticsEnabled = this.loadHapticsPref();
        this.lastHaptic = 0;
        this.wakeLock = null;
        this.wantWakeLock = false;
        this.wakeReleaseTimer = null;
        /** True while the network is up but the SwarmUI process is not answering. */
        this.serverDown = false;
        /** Pending re-probe timer for the serverDown state. */
        this.probeTimer = null;
        /** True while a probe is in flight, so overlapping triggers do not stack requests. */
        this.probing = false;
        this.setupConnectionMonitor();
        this.setupServerDownDetection();
        this.setupHaptics();
        this.setupWakeLock();
    }

    /** Haptics default on for touch devices; overridable via the shared `m_client_haptics` localStorage key.
     * The pre-unification `mobileEnh_haptics` key is honoured as a fallback so an explicit opt-out survives. */
    loadHapticsPref() {
        let stored = localStorage.getItem(MobileNetwork.HapticsKey);
        if (stored == 'off') {
            return false;
        }
        if (stored == 'on') {
            return true;
        }
        if (localStorage.getItem('mobileEnh_haptics') == 'false') {
            return false;
        }
        return window.matchMedia('(pointer: coarse)').matches;
    }

    // --- Connection banner ---

    /** Show a banner whenever the browser reports the network is gone, and clear it when it returns. A return
     * of the network is followed by a server probe, since "online again" says nothing about the process. */
    setupConnectionMonitor() {
        window.addEventListener('offline', () => {
            this.stopProbing();
            this.showBanner(translate('Connection lost — reconnecting…'));
        });
        window.addEventListener('online', () => {
            this.hideBanner();
            this.probeServer();
        });
        if (!navigator.onLine) {
            this.showBanner(translate('Connection lost — reconnecting…'));
        }
    }

    /** Shows the banner with the given text (or leaves existing text alone when null). */
    showBanner(text) {
        if (!this.banner) {
            this.banner = createDiv(null, 'mobile-connection-banner');
            document.body.appendChild(this.banner);
        }
        if (text) {
            this.banner.textContent = text;
        }
        this.banner.classList.add('visible');
    }

    hideBanner() {
        if (this.banner) {
            this.banner.classList.remove('visible');
        }
    }

    // --- Server-down detection ---

    /**
     * Distinguishes "the network is fine but SwarmUI is not running" from a generic offline state. The signal
     * is site.js's `genericServerError`, the default transport-failure handler every genericRequest and
     * makeWSRequest without its own errorHandle falls into - it is looked up by name at call time, so wrapping
     * the global here catches every such failure with no core edit, and the original still runs so the
     * user-facing toast is unchanged. The genpage's own status loop (reviseStatusBar) makes such a request
     * periodically, which is what turns a crashed process into a failure here within seconds.
     */
    setupServerDownDetection() {
        if (typeof genericServerError != 'function') {
            return;
        }
        let original = genericServerError;
        genericServerError = (...args) => {
            this.onTransportFailure();
            return original(...args);
        };
        // A phone that was backgrounded through a restart sees nothing until it is foregrounded; probe then.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState == 'visible' && this.serverDown) {
                this.probeServer();
            }
        });
    }

    /** A request to the app failed at the transport level. Offline is the browser's call and already shown;
     * anything else means the process is unreachable, so say so and start watching for it to come back. */
    onTransportFailure() {
        if (!navigator.onLine) {
            return;
        }
        if (!this.serverDown) {
            this.serverDown = true;
            this.showBanner(translate('SwarmUI isn\'t running — retrying…'));
        }
        this.scheduleProbe();
    }

    /** Arms the next probe, replacing any pending one. */
    scheduleProbe() {
        this.stopProbing();
        this.probeTimer = setTimeout(() => this.probeServer(), MobileNetwork.ProbeIntervalMs);
    }

    stopProbing() {
        if (this.probeTimer) {
            clearTimeout(this.probeTimer);
            this.probeTimer = null;
        }
    }

    /**
     * Asks the server whether it is answering at all. A POST, because the service worker passes non-GET
     * requests straight through (sw.js), so this can never be satisfied from cache. Any HTTP response counts
     * as up, including an error body: the question is whether the web server is there, not whether this
     * particular call succeeded. On success the banner clears and normal core polling takes over again; on
     * failure (network-level throw or timeout) the banner shows and another probe is scheduled.
     */
    async probeServer() {
        if (this.probing) {
            return;
        }
        this.stopProbing();
        this.probing = true;
        let controller = window.AbortController ? new AbortController() : null;
        let timeout = controller ? setTimeout(() => controller.abort(), MobileNetwork.ProbeTimeoutMs) : null;
        let up = false;
        try {
            await fetch('API/GetCurrentStatus', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
                cache: 'no-store',
                signal: controller ? controller.signal : undefined
            });
            up = true;
        }
        catch (err) {
            up = false;
        }
        if (timeout) {
            clearTimeout(timeout);
        }
        this.probing = false;
        if (up) {
            if (this.serverDown) {
                this.serverDown = false;
                this.hideBanner();
            }
            return;
        }
        if (navigator.onLine) {
            this.onTransportFailure();
        }
    }

    // --- Haptics on image arrival ---

    /** Watch the batch area; a newly added image block means a generation result landed. */
    setupHaptics() {
        let batch = document.getElementById('current_image_batch');
        if (!batch || !window.MutationObserver) {
            return;
        }
        let observer = new MutationObserver(mutations => {
            for (let mutation of mutations) {
                for (let node of mutation.addedNodes) {
                    if (node.nodeType == 1 && this.looksLikeImage(node)) {
                        this.onImageArrived();
                        return;
                    }
                }
            }
        });
        observer.observe(batch, { childList: true, subtree: true });
    }

    /** True if an added node is (or contains) a rendered batch image. */
    looksLikeImage(node) {
        if (node.classList && node.classList.contains('image-block-img-inner')) {
            return true;
        }
        return node.querySelector && node.querySelector('.image-block-img-inner') != null;
    }

    /** Fire feedback for an arrived image: keep the wake-lock alive and buzz (debounced, if enabled). */
    onImageArrived() {
        this.pokeWakeLockActivity();
        let now = Date.now();
        if (this.hapticsEnabled && navigator.vibrate && now - this.lastHaptic > 900) {
            this.lastHaptic = now;
            navigator.vibrate(12);
        }
    }

    // --- Wake lock during generation ---

    /** Hold a screen wake-lock while a generation is running so the phone won't sleep and drop the view. */
    setupWakeLock() {
        if (!('wakeLock' in navigator)) {
            return;
        }
        for (let id of ['alt_generate_button', 'simple_generate_button']) {
            let button = document.getElementById(id);
            if (button) {
                button.addEventListener('click', () => this.acquireWakeLock());
            }
        }
        // Wake locks auto-release when the tab is hidden; re-acquire on return if a run is still going.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState == 'visible' && this.wantWakeLock) {
                this.acquireWakeLock();
            }
        });
    }

    async acquireWakeLock() {
        if (!('wakeLock' in navigator)) {
            return;
        }
        this.wantWakeLock = true;
        this.pokeWakeLockActivity();
        if (this.wakeLock) {
            return;
        }
        try {
            this.wakeLock = await navigator.wakeLock.request('screen');
            this.wakeLock.addEventListener('release', () => {
                this.wakeLock = null;
            });
        }
        catch (err) {
            // Denied or unsupported (e.g. low battery) - harmless, just skip.
            this.wakeLock = null;
        }
    }

    /** Re-arm the idle auto-release: hold while images keep arriving, drop the lock a bit after the last one. */
    pokeWakeLockActivity() {
        if (this.wakeReleaseTimer) {
            clearTimeout(this.wakeReleaseTimer);
        }
        this.wakeReleaseTimer = setTimeout(() => this.releaseWakeLock(), 12000);
    }

    releaseWakeLock() {
        this.wantWakeLock = false;
        if (this.wakeLock) {
            this.wakeLock.release().catch(() => {});
            this.wakeLock = null;
        }
    }
}

let mobileNetwork = new MobileNetwork();
