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
        this.setupKeyboardHandling();
        this.tagOptionalTopTabs();
    }

    /** Mark the Simple and Comfy Workflow top tabs so mobile.css can hide them on small windows - they have
     * no shared class to target directly (class-selectors-only convention), and both are reachable another
     * way on mobile (the app shell's More sheet has a "Simple Mode" shortcut; Comfy Workflow is a power-user
     * desktop feature). Runs once at load; these tabs are server-rendered and never rebuilt afterward. */
    tagOptionalTopTabs() {
        let simpleTab = document.getElementById('simpletabbutton');
        if (simpleTab) {
            simpleTab.classList.add('mobile-optional-tab');
        }
        let comfyTab = document.getElementById('maintab_comfyworkflow');
        if (comfyTab) {
            comfyTab.classList.add('mobile-optional-tab');
        }
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
     * Track the on-screen keyboard via the visual viewport and expose its height as the `--kb-inset` CSS
     * variable plus a `kb-open` body class. mobile.css uses these to lift the floating prompt above the
     * keyboard. On Android (viewport `interactive-widget=resizes-content`) the layout already resizes, so the
     * inset stays ~0; this mainly helps iOS Safari, which overlays the keyboard without resizing.
     */
    setupKeyboardHandling() {
        if (!window.visualViewport) {
            return;
        }
        let vv = window.visualViewport;
        let update = () => {
            let inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
            document.body.style.setProperty('--kb-inset', `${inset}px`);
            document.body.classList.toggle('kb-open', inset > 120);
            // iOS standalone-PWA keyboard bug: opening the keyboard scrolls the whole layout viewport up to
            // keep the focused input visible, and dismissal often leaves that scroll behind - the page stays
            // shifted up with a dead black band at the bottom (fixed elements like the shell nav ride up with
            // it). The page never legitimately scrolls (body is position:fixed + overflow:hidden), so whenever
            // the keyboard is closed and any leftover shift exists, snap the viewport back.
            if (inset <= 1 && (window.scrollY != 0 || vv.pageTop > 0 || vv.offsetTop > 0)) {
                window.scrollTo(0, 0);
            }
        };
        vv.addEventListener('resize', update);
        vv.addEventListener('scroll', update);
        // The stranded-shift bug (see above) can also be triggered by touch gestures dragging the layout
        // viewport (observed with the swipe-up-for-bottom-bar gesture), not just the keyboard - catch plain
        // window scrolls too so every shift path hits the snap-back.
        window.addEventListener('scroll', update, { passive: true });
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
