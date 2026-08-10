/**
 * MobileEnhancements core (fork extension).
 * Runs on the generate page after core scripts. Owns the cross-cutting mobile/PWA setup:
 * viewport correction, service-worker registration, and standalone-mode detection.
 * Loaded via the extension's ScriptFiles; see docs/MobilePWA-Optimization-Plan.md.
 */
class MobileEnhancements {

    /** Construct and immediately wire up the mobile/PWA baseline. */
    constructor() {
        this.isStandalone = this.detectStandalone();
        this.fixViewport();
        this.markStandalone();
        this.registerServiceWorker();
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
