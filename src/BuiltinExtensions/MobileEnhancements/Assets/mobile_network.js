/**
 * MobileEnhancements — network resilience & polish (fork extension).
 *
 * Adds three decoupled, fail-safe helpers that make SwarmUI more pleasant on phones. Each relies on robust
 * browser signals rather than patching core request functions, so nothing breaks if core internals change:
 *   1. A "connection lost" banner driven by the browser online/offline events.
 *   2. Light haptic feedback when a generated image arrives (MutationObserver on the batch area).
 *   3. A screen wake-lock held during active generation so the phone doesn't sleep mid-run.
 * See docs/MobilePWA-Optimization-Plan.md (Phase 4).
 */
class MobileNetwork {

    constructor() {
        this.banner = null;
        this.hapticsEnabled = this.loadHapticsPref();
        this.lastHaptic = 0;
        this.wakeLock = null;
        this.wantWakeLock = false;
        this.wakeReleaseTimer = null;
        this.setupConnectionMonitor();
        this.setupHaptics();
        this.setupWakeLock();
    }

    /** Haptics default on for touch devices; overridable via the `mobileEnh_haptics` localStorage key. */
    loadHapticsPref() {
        let stored = localStorage.getItem('mobileEnh_haptics');
        if (stored == null) {
            return window.matchMedia('(pointer: coarse)').matches;
        }
        return stored == 'true';
    }

    /** Enable/disable haptic feedback and persist the choice. */
    setHaptics(on) {
        this.hapticsEnabled = on;
        localStorage.setItem('mobileEnh_haptics', on ? 'true' : 'false');
    }

    // --- Connection banner ---

    /** Show a banner whenever the browser reports the network is gone, and clear it when it returns. */
    setupConnectionMonitor() {
        window.addEventListener('offline', () => this.showBanner());
        window.addEventListener('online', () => this.hideBanner());
        if (!navigator.onLine) {
            this.showBanner();
        }
    }

    showBanner() {
        if (!this.banner) {
            this.banner = createDiv(null, 'mobile-connection-banner');
            this.banner.textContent = translate('Connection lost — reconnecting…');
            document.body.appendChild(this.banner);
        }
        this.banner.classList.add('visible');
    }

    hideBanner() {
        if (this.banner) {
            this.banner.classList.remove('visible');
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
