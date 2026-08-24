/**
 * MobileEnhancements core (fork extension).
 * Runs on the generate page after core scripts. Owns the cross-cutting mobile/PWA setup:
 * viewport correction, service-worker registration, and standalone-mode detection.
 * Loaded via the extension's ScriptFiles; see docs/MobilePWA-Optimization-Plan.md.
 */
class MobileEnhancements {

    /** Upper bound for the top safe-area inset, in CSS px. Same defensive reasoning as --safe-bottom's 34px
     * cap in mobile.css: iOS standalone has been observed reporting these insets in physical rather than CSS
     * pixels on this fork's target device. 64 clears the tallest real iPhone status bar (62pt, 16 Pro Max). */
    static MaxSafeTop = 64;

    /** Fallback status-bar heights in CSS px, keyed by portrait screen height, for the iOS case where the
     * browser reports a zero top inset while still laying the app out underneath the status bar. Values are
     * the devices' real status-bar heights; see measureSafeAreaTop() for when this is consulted at all. */
    static IosStatusBarHeights = { 956: 62, 932: 59, 926: 47, 896: 44, 874: 62, 852: 59, 844: 47, 812: 44, 780: 50 };

    /** Screen height at/above which a device is notch-or-island class, used only for screen sizes missing
     * from IosStatusBarHeights above (ie. hardware newer than this table). */
    static NotchClassScreenHeight = 780;

    /** Status-bar height assumed for an unrecognized notch-class device. Deliberately the high end of the
     * observed range - overshooting leaves a thin dead band, undershooting puts the top row back under the
     * clock, which is the bug this whole path exists to fix. */
    static UnknownNotchStatusBar = 59;

    /** Milliseconds to wait after a resize before re-measuring the top inset. */
    static SafeTopSettleMs = 200;

    /** Construct and immediately wire up the mobile/PWA baseline. */
    constructor() {
        this.isStandalone = this.detectStandalone();
        /** Last value written to --safe-top, so repeat measurements skip the style write. */
        this.lastSafeTop = -1;
        /** Pending trailing re-measure timer, so a burst of resize events measures once. */
        this.safeTopTimer = null;
        this.fixViewport();
        this.markStandalone();
        this.applySafeAreaTop();
        this.watchSafeAreaTop();
        this.registerServiceWorker();
        this.addMobileReturnLink();
    }

    /**
     * In the installed app only, puts a "Mobile UI" link on any non-/simple page so the user can get back.
     * It docks into the top tab strip where there is one, and falls back to a floating pill where there is
     * not (login, install, the error page).
     *
     * Standalone has no address bar and no browser back button, and /simple's own "Classic UI" link navigates
     * here with nothing pointing back - so a tap that was meant as a peek at the full UI stranded the user
     * until they force-quit the app. The share target has the same shape and is worse: it cold-starts at
     * /ShareTarget which redirects here, so there is no history entry to swipe back to at all.
     *
     * Deliberately standalone-only. In a normal browser tab the address bar and back gesture already solve
     * this, and injecting a floating link into every Razor page on desktop would be an unwanted change to the
     * main UI - this exists to repair a navigation dead end, not to add an affordance.
     */
    addMobileReturnLink() {
        if (!this.isStandalone) {
            return;
        }
        if (location.pathname.toLowerCase().startsWith('/simple')) {
            return;
        }
        let add = () => {
            if (!document.body || document.querySelector('.swarm-mobile-return')) {
                return;
            }
            let tabs = document.getElementById('toptablist');
            if (tabs) {
                // Docked into the tab strip rather than floated over it. As a fixed top-right pill it sat on
                // top of whichever tab happened to be underneath, and once Genpage became installable in its
                // own right (the Classic manifest variant) that overlap was on screen for a whole session
                // instead of only for a peek from /simple. The strip already scrolls horizontally under
                // body.small-window and its items are `flex: 0 0 auto`, so one more item at the end costs no
                // layout and cannot collide with anything.
                let item = document.createElement('li');
                item.className = 'nav-item swarm-mobile-return';
                item.setAttribute('role', 'presentation');
                let tab = document.createElement('a');
                tab.className = 'nav-link';
                tab.href = '/simple';
                tab.textContent = 'Mobile UI';
                item.appendChild(tab);
                tabs.appendChild(item);
                return;
            }
            // No tab strip on this page, so fall back to the floating pill.
            let link = document.createElement('a');
            link.className = 'swarm-mobile-return';
            link.href = '/simple';
            link.textContent = 'Mobile UI';
            // Inline-styled rather than in mobile.css: this element only ever exists in the installed app, and
            // keeping its styling next to the one place that creates it avoids a rule in a shared stylesheet
            // that appears to apply to every page but never matches on any of them.
            link.style.cssText = 'position:fixed;z-index:1002;right:0.6rem;font-size:13px;padding:0.5rem 0.8rem;'
                + 'min-height:44px;display:inline-flex;align-items:center;border-radius:0.5rem;'
                + 'background:var(--background-panel,#222);color:var(--text,#eee);border:1px solid var(--border-color,#444);'
                + 'text-decoration:none;opacity:0.92;'
                + 'top:calc(var(--safe-top, env(safe-area-inset-top)) + 0.4rem);';
            document.body.appendChild(link);
        };
        if (document.body) {
            add();
        }
        else {
            document.addEventListener('DOMContentLoaded', add);
        }
    }

    /** True on iOS/iPadOS. Used only to gate the top safe-area fallback, which works around a quirk of
     * WebKit's standalone web apps - every other platform reports the inset correctly and must not be
     * second-guessed. iPadOS reports itself as a Mac, hence the touch-point check. */
    isIos() {
        if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
            return true;
        }
        return navigator.platform == 'MacIntel' && navigator.maxTouchPoints > 1;
    }

    /** True when the current pointer is touch-like (phones/tablets), used to gate touch-only behaviors. */
    isCoarsePointer() {
        return window.matchMedia('(pointer: coarse)').matches;
    }

    /** Detect whether the app is running as an installed/standalone PWA (Android/desktop and iOS variants). */
    detectStandalone() {
        if (window.matchMedia('(display-mode: standalone)').matches) {
            return true;
        }
        if (window.matchMedia('(display-mode: fullscreen)').matches) {
            return true;
        }
        // iOS Safari exposes this non-standard flag instead of display-mode.
        if (navigator.standalone == true) {
            return true;
        }
        return false;
    }

    /**
     * Replace the server-rendered viewport meta (which pins `maximum-scale=1.0` and blocks pinch zoom)
     * with a mobile-friendly one: pinch zoom restored, safe-area insets enabled, keyboard resizes content.
     */
    fixViewport() {
        let meta = document.querySelector('meta[name="viewport"]');
        if (!meta) {
            meta = document.createElement('meta');
            meta.setAttribute('name', 'viewport');
            document.head.appendChild(meta);
        }
        meta.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content');
    }

    /** Add a body class so CSS can target installed-PWA display (safe-area padding, hidden browser affordances). */
    markStandalone() {
        if (this.isStandalone) {
            document.body.classList.add('pwa-standalone');
        }
        if (this.isCoarsePointer()) {
            document.body.classList.add('coarse-pointer');
        }
    }

    /**
     * Reads the browser's own top safe-area inset, in CSS px. env() is only resolvable from CSS, so this
     * measures it off a throwaway probe element rather than reading it directly.
     */
    readEnvInsetTop() {
        let probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);';
        document.body.appendChild(probe);
        let value = parseFloat(getComputedStyle(probe).paddingTop) || 0;
        probe.remove();
        return value;
    }

    /**
     * Height of the OS status bar currently overlaying the app, in CSS px (0 when nothing overlays it).
     *
     * The browser's reported inset is used whenever it reports one. It does not always report one: iOS gives
     * home-screen web apps a top inset of 0 even under 'apple-mobile-web-app-status-bar-style:
     * black-translucent', which is precisely the mode that lays the content out *underneath* the status bar.
     * So the app renders behind the clock and Dynamic Island with nothing reserving that space, and the top
     * tab strip is unreachable. A zero here is therefore not evidence that there is nothing to avoid - note
     * the BOTTOM inset does get reported on the same device (that is what --safe-bottom consumes), which
     * rules out the app simply not being in standalone mode.
     *
     * The fallback is gated on proving the app really is running full-bleed. If iOS laid the web view out
     * below the status bar itself, the window is already shorter than the screen by that much, and padding
     * on top of that would double-count it.
     */
    measureSafeAreaTop() {
        if (!this.isStandalone) {
            return 0;
        }
        let reported = this.readEnvInsetTop();
        if (reported > 0) {
            return Math.min(reported, MobileEnhancements.MaxSafeTop);
        }
        // Every other platform reports this inset correctly, so a zero there is a real zero. Substituting a
        // fallback would put a permanent dead band across the top of, for example, an Android edge-to-edge
        // portrait PWA that has nothing to avoid.
        if (!this.isIos()) {
            return 0;
        }
        // Landscape: iOS hides the status bar outright for standalone web apps, so there is nothing to clear.
        // (The notch becomes a left/right inset there, which is reported correctly and is not this problem.)
        if (window.innerHeight <= window.innerWidth) {
            return 0;
        }
        // Pick whichever screen axis is the current portrait height - iOS has historically disagreed with
        // itself about whether screen.width/height swap on rotation.
        let screenH = Math.abs(screen.height - window.innerHeight) <= Math.abs(screen.width - window.innerHeight) ? screen.height : screen.width;
        if (screenH - window.innerHeight >= 20) {
            return 0;
        }
        let known = MobileEnhancements.IosStatusBarHeights[Math.round(screenH)];
        if (known) {
            return known;
        }
        return screenH >= MobileEnhancements.NotchClassScreenHeight ? MobileEnhancements.UnknownNotchStatusBar : 20;
    }

    /**
     * Publishes the measured top inset as --safe-top, which body.pwa-standalone consumes as its padding-top.
     * No-ops when the value is unchanged, so the resize path costs nothing in the common case.
     */
    applySafeAreaTop() {
        if (!this.isStandalone) {
            return;
        }
        let top = this.measureSafeAreaTop();
        if (top == this.lastSafeTop) {
            return;
        }
        this.lastSafeTop = top;
        document.documentElement.style.setProperty('--safe-top', `${top}px`);
        // The layout engine sizes its panels from the root div's live top offset, which this padding moves.
        // Extension ScriptFiles inject via PageFooterExtra, at the body end AFTER layout.js's own script tag
        // (Text2Image.cshtml), so genTabLayout normally already exists by the time this runs. Guarded anyway
        // for the case this method is ever called from a context where that ordering doesn't hold (a future
        // caller, a different page) - a missed reapply here is silently corrected by layout.js's own init
        // pass moments later, so failing closed here is the safe direction.
        if (typeof genTabLayout != 'undefined' && genTabLayout && genTabLayout.scheduleReapply) {
            genTabLayout.scheduleReapply();
        }
    }

    /**
     * Re-measures the top inset after rotation or any other resize. Trailing-debounced: iOS fires a stream
     * of resize events while the on-screen keyboard animates, and each measurement costs a probe insertion
     * plus a forced style read.
     */
    watchSafeAreaTop() {
        if (!this.isStandalone) {
            return;
        }
        let settle = () => {
            if (this.safeTopTimer) {
                clearTimeout(this.safeTopTimer);
            }
            this.safeTopTimer = setTimeout(() => {
                this.safeTopTimer = null;
                this.applySafeAreaTop();
            }, MobileEnhancements.SafeTopSettleMs);
        };
        window.addEventListener('resize', settle);
        window.addEventListener('orientationchange', settle);
    }

    /** Register the root-scoped service worker (served from /sw.js) for installability + offline fallback. */
    registerServiceWorker() {
        if (!('serviceWorker' in navigator)) {
            return;
        }
        // Only meaningful over https or localhost; browsers reject SW registration otherwise, so guard to avoid noise.
        let isSecure = window.isSecureContext || location.hostname == 'localhost' || location.hostname == '127.0.0.1';
        if (!isSecure) {
            return;
        }
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(err => {
                console.log(`SwarmUI PWA service worker registration failed: ${err}`);
            });
        });
    }
}

let mobileEnhancements = new MobileEnhancements();
