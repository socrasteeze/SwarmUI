/** Generate-tab batch toggles, stored on the user's account.
 *
 * Core keeps the six batch-gear switches in localStorage and reads them back at script time. That store is per
 * origin and dies with any "clear site data on exit" browser setting, so the switches reset when the browser
 * closes or when the same server is reached over a different address. This mirrors them to the account instead.
 *
 * localStorage is still written, deliberately. Core's script-time read is what paints the switches before this
 * file's request returns, so keeping the local copy current is what stops a visible flip on every page load, and
 * it leaves a usable fallback when the server call fails.
 */
class GenPagePrefsClass {

    constructor() {
        /** Checkbox element id to the storage key core already uses for it. Same names on both sides, so the
         * local mirror and the account blob never need a translation table. */
        this.toggles = {
            'auto_clear_batch_checkbox': 'autoClearBatch',
            'auto_load_previews_checkbox': 'autoLoadPreviews',
            'auto_load_images_checkbox': 'autoLoadImages',
            'show_load_spinners_checkbox': 'showLoadSpinners',
            'separate_batches_checkbox': 'separateBatches',
            'play_batch_videos_checkbox': 'playBatchVideos'
        };
        /** Switches that drive something live on the page rather than only being read back later, named by the
         * core function that does the driving. Applying a stored value sets `.checked` directly, which fires no
         * change event, so core's own handler never runs and anything already on screen keeps the old state. */
        this.applyHooks = {
            'play_batch_videos_checkbox': 'togglePlayBatchVideos'
        };
        /** Pending debounced save, or null. */
        this.saveTimer = null;
        /** Set once a save has failed, so a server that is down warns once instead of on every click. */
        this.warned = false;
    }

    /** Wires the change listeners and pulls the stored values. Runs from sessionReadyCallbacks, which fires after
     * core's own script-time read, so whatever the account holds wins over the local copy. */
    install() {
        for (let id in this.toggles) {
            let elem = document.getElementById(id);
            if (!elem) {
                // A page variant without this switch is not an error - just nothing to sync.
                continue;
            }
            elem.addEventListener('change', () => this.scheduleSave());
        }
        this.load();
    }

    /** Reads the account copy and applies it. A failure is silent beyond the console: the switches already hold
     * core's local values, which is the correct thing to show when the account copy cannot be read. */
    load() {
        genericRequest('GetGenPagePrefs', {}, data => {
            this.apply(data.prefs || {});
        }, 0, error => {
            console.error(`GenPagePrefs: could not load stored toggles, keeping local values: ${error}`);
        });
    }

    /** Applies a stored object to the switches, and mirrors it into localStorage so the next page load paints the
     * right state before the server answers. Keys absent from the object are left alone. */
    apply(prefs) {
        for (let id in this.toggles) {
            let key = this.toggles[id];
            let elem = document.getElementById(id);
            if (!elem || !(key in prefs)) {
                continue;
            }
            let value = prefs[key] == true;
            let changed = elem.checked != value;
            elem.checked = value;
            try {
                localStorage.setItem(key, `${value}`);
            }
            catch (e) {
                // Storage can be unavailable outright; the account copy is authoritative either way.
            }
            if (changed) {
                this.runApplyHook(id);
            }
        }
    }

    /** Runs a switch's live-effect handler, if it has one and core defines it. Only called when applying actually
     * changed the switch, so a page that already agrees with the account does no extra work. */
    runApplyHook(id) {
        let name = this.applyHooks[id];
        if (!name) {
            return;
        }
        let handler = window[name];
        if (typeof handler == 'function') {
            handler();
        }
    }

    /** Coalesces rapid clicks into one write. Flipping three switches in a row should cost one request. */
    scheduleSave() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.save();
        }, 400);
    }

    /** Writes the current switch states to the account. */
    save() {
        let prefs = {};
        for (let id in this.toggles) {
            let elem = document.getElementById(id);
            if (elem) {
                prefs[this.toggles[id]] = elem.checked == true;
            }
        }
        // Sent flat, NOT as {prefs: ...}: a JObject API parameter receives the whole payload with session_id
        // stripped, not the field that shares its name. Nesting it stores an empty object and reports success.
        genericRequest('SetGenPagePrefs', prefs, data => {
            this.warned = false;
        }, 0, error => {
            console.error(`GenPagePrefs: could not save toggles: ${error}`);
            if (!this.warned) {
                this.warned = true;
                showError('Could not save the batch view settings to your account. They will still apply in this browser.');
            }
        });
    }
}

genPagePrefs = new GenPagePrefsClass();

if (typeof sessionReadyCallbacks != 'undefined') {
    sessionReadyCallbacks.push(() => genPagePrefs.install());
}
