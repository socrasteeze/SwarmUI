/**
 * Discrete top-of-page loading bar (fork extension). Not mobile-specific - loads and applies on every
 * viewport, same as mobile_network.js's connection banner.
 *
 * Exists because some of this fork's own work makes a real freeze worse: the lazy multiselect (see
 * params.js / site.js) moved the LoRA list's ~10s render cost off page load and onto the first tap of the
 * dropdown, with nothing on screen to say a tap was even registered. A synchronous JS task can't update
 * its own progress mid-flight - the browser doesn't get to paint until the task returns control - so the
 * only lever available is showing SOMETHING before the freeze starts. runDeferred() is that lever: it
 * shows the bar, yields two animation frames (long enough for a real paint - see its own comment), then
 * runs the heavy work. The bar can't animate while that work blocks the main thread, but its presence is
 * itself the signal: something is happening, this is a load, not a hang.
 */
class BusyIndicatorHelper {

    constructor() {
        /** Reference count. Show/hide can nest (unrelated slow operations overlapping); the bar stays
         * visible until every caller that showed it has also hidden it. */
        this.count = 0;
        /** Lazily-created bar element, appended to document.body on first use. */
        this.elem = null;
    }

    /** Creates the bar element on first call, and returns it on every call after. */
    ensureElem() {
        if (this.elem) {
            return this.elem;
        }
        this.elem = document.createElement('div');
        this.elem.className = 'swarm-busybar';
        let fill = document.createElement('div');
        fill.className = 'swarm-busybar-fill';
        this.elem.appendChild(fill);
        document.body.appendChild(this.elem);
        return this.elem;
    }

    /** Shows the bar. Safe to call while it is already showing - just bumps the reference count. */
    show() {
        this.count++;
        this.ensureElem().classList.add('swarm-busybar-visible');
    }

    /** Hides the bar once every show() has a matching hide(). Extra hide() calls are harmless no-ops. */
    hide() {
        this.count = Math.max(0, this.count - 1);
        if (this.count == 0 && this.elem) {
            this.elem.classList.remove('swarm-busybar-visible');
        }
    }

    /**
     * Shows the bar, waits for a real paint, runs a long synchronous function, then hides the bar.
     *
     * Two nested requestAnimationFrame calls, not one: a single rAF fires before ITS OWN frame is painted,
     * so code scheduled from inside it can still land in the same paint cycle as the work that follows.
     * Booking a second rAF only fires on the NEXT frame, which the browser can only reach after actually
     * rendering the first - so by the time the callback below runs, the visible-bar state is guaranteed to
     * have been on screen for at least one real frame. This is the standard "wait for a paint" pattern.
     *
     * fn's return value is not surfaced - every current call site is fire-and-forget. sync errors inside fn
     * still reach hide() via finally, so a thrown error cannot leave the bar stuck visible forever.
     */
    async runDeferred(fn) {
        this.show();
        await new Promise(resolve => requestAnimationFrame(resolve));
        await new Promise(resolve => requestAnimationFrame(resolve));
        try {
            fn();
        }
        finally {
            this.hide();
        }
    }
}

let busyIndicator = new BusyIndicatorHelper();
