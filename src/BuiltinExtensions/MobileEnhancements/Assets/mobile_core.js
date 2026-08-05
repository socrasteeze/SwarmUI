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
     * Keep the floating prompt bar above the on-screen keyboard, by publishing the exact lift it needs as
     * the `--kb-inset` CSS variable plus a `kb-open` body class for mobile.css to apply.
     *
     * The lift is MEASURED, not derived from a viewport formula. The bar's real distance below the visible
     * band is the only quantity that matters, and it is the one thing that stays true no matter how iOS
     * splits a keyboard appearance between shrinking the visual viewport, offsetting it inside an unchanged
     * layout viewport, and scrolling the document. The previous open-loop version computed
     * `innerHeight - vv.height - vv.offsetTop` and only applied it when that exceeded 120px, which failed in
     * two ways at once: the value is the lift still OUTSTANDING after whatever iOS already shifted (so it
     * shrinks as offsetTop grows), and gating it on a fixed threshold therefore discarded every genuinely
     * needed lift under 120px. That left a dead zone - reproduced at offsetTop 280 of a 380px keyboard,
     * where 100px of lift was still required, the class was dropped, and the bar sat 44px under the
     * keyboard. Scrolling nudged offsetTop back across the threshold, which is exactly the reported "scroll
     * the whole page and the prompt forces itself up and gets stickied".
     *
     * On Android (viewport `interactive-widget=resizes-content`) the layout already resizes, so the measured
     * overlap is naturally 0 and this stays inert; it mainly matters on iOS, which overlays the keyboard.
     */
    setupKeyboardHandling() {
        if (!window.visualViewport) {
            return;
        }
        let vv = window.visualViewport;
        let lift = 0;
        let animTimer = null;
        let scheduled = false;
        let measure = () => {
            let region = document.getElementById('alt_prompt_region');
            // Absent on every page but the generate tab, and display:none whenever layout.js hides the bar.
            if (!region || region.offsetParent == null) {
                return 0;
            }
            // getBoundingClientRect and visualViewport offsets are both layout-viewport-relative, so the
            // visible band is [offsetTop, offsetTop + height] in the same coordinate space as the rect.
            // The lift already applied is added back to recover the bar's untransformed position - without
            // that this would be reading its own output, measure an overlap of zero, drop the lift, and
            // oscillate on every frame.
            let naturalBottom = region.getBoundingClientRect().bottom + lift;
            return Math.max(0, Math.round(naturalBottom - (vv.offsetTop + vv.height)));
        };
        // "Is the keyboard up" is a different question from "how far must the bar move", and needs a
        // different measure: how much height the keyboard is occupying, which is shift-independent. Note
        // offsetTop is deliberately NOT subtracted here - subtracting it is what made the old combined
        // value collapse toward zero as iOS shifted the viewport, so a keyboard that was plainly open read
        // as closed. Only used to gate the snap-back below.
        let keyboardOpen = () => {
            return window.innerHeight - vv.height > 120;
        };
        let update = () => {
            let needed = measure();
            if (needed != lift) {
                let wasLifted = lift > 0;
                lift = needed;
                document.body.style.setProperty('--kb-inset', `${lift}px`);
                if ((lift > 0) != wasLifted) {
                    document.body.classList.toggle('kb-open', lift > 0);
                    // Animate only across the lifted/not-lifted edge. The lift is re-measured on every scroll
                    // frame too (offsetTop changes as iOS scrolls the layout viewport under an open keyboard),
                    // and mobile.css's transition would restart its tween on each of those - making the prompt
                    // bar visibly chase the viewport instead of tracking it. kb-animating scopes the transition
                    // to the edge; the timer clears it a hair after the 0.15s tween ends.
                    document.body.classList.add('kb-animating');
                    if (animTimer) {
                        clearTimeout(animTimer);
                    }
                    animTimer = setTimeout(() => {
                        document.body.classList.remove('kb-animating');
                        animTimer = null;
                    }, 200);
                }
            }
            // iOS standalone-PWA keyboard bug: opening the keyboard scrolls the whole layout viewport up to
            // keep the focused input visible, and dismissal often leaves that scroll behind - the page stays
            // shifted up with a dead black band at the bottom (fixed elements like the shell nav ride up with
            // it). The page never legitimately scrolls (body is position:fixed + overflow:hidden), so whenever
            // the keyboard is down and a leftover shift exists, snap the viewport back. Gated on the keyboard
            // rather than on the lift: pages without a prompt bar (and moments when the bar happens to need no
            // lift) never need a lift either, and snapping there would fight iOS scrolling a focused sidebar
            // field into view while its keyboard is still up.
            if (!keyboardOpen() && (window.scrollY != 0 || vv.pageTop > 0 || vv.offsetTop > 0)) {
                window.scrollTo(0, 0);
            }
        };
        // Coalesce to one measurement per frame: measure() forces layout, and iOS emits a dense stream of
        // resize/scroll events while the keyboard animates. Same pattern as layout.js scheduleReapply.
        let schedule = () => {
            if (scheduled) {
                return;
            }
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                update();
            });
        };
        vv.addEventListener('resize', schedule);
        vv.addEventListener('scroll', schedule);
        // The stranded-shift bug (see above) can also be triggered by touch gestures dragging the layout
        // viewport (observed with the swipe-up-for-bottom-bar gesture), not just the keyboard - catch plain
        // window scrolls too so every shift path hits the snap-back.
        window.addEventListener('scroll', schedule, { passive: true });
        // The bar's own height changes independently of the viewport (typing wraps the textarea, pasted
        // images grow the strip). While lifted, that moves its bottom edge and silently invalidates the
        // measurement, so re-measure whenever the bar itself resizes.
        if (window.ResizeObserver) {
            let region = document.getElementById('alt_prompt_region');
            if (region) {
                new ResizeObserver(schedule).observe(region);
            }
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
