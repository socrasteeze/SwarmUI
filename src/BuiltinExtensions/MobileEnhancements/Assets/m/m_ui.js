/** MobileEnhancements standalone client - UI plumbing: hash router, bottom sheets, small DOM helpers. */
class MUI {

    constructor() {
        /** Registered tab initializers: name -> {build, onShow}. */
        this.tabs = {};
        /** Whether each tab has been built yet (lazy build on first show). */
        this.built = {};
        /** Extra More-tab rows contributed by other extensions: [{label, onClick}]. */
        this.moreItems = [];
        /** Header error-strip elements, resolved and wired on first use by errorBar(). undefined = not looked
         * up yet, null = the markup isn't there (errors fall back to the toast). */
        this.errorEls = undefined;
        /** Substrings from the user's ui.HideErrorMessages setting; see setErrorFilters. Empty until the
         * settings request lands, so an early error is shown rather than silently dropped. */
        this.errorFilters = [];
        /** How many bottom sheets are currently on screen. .m-sheet is the only consumer of --m-kb-inset, so
         * initKeyboardWatch skips publishing that value entirely while this is 0. */
        this.openSheets = 0;
        /** Set by initKeyboardWatch to its own apply(); openSheet() calls it so a sheet opening under an
         * already-open keyboard is positioned on the frame it appears. No-op before init. */
        this.applyKeyboardInset = () => {};
    }

    /** Creates an element with a class and optional text. */
    el(tag, className, text) {
        let elem = document.createElement(tag);
        if (className) {
            elem.className = className;
        }
        if (text != null) {
            elem.textContent = text;
        }
        return elem;
    }

    /** File-name stem of a model: folders and extension stripped. Used as the checkpoint heading, and as
     * the LoRA subtitle when a metadata title is taking the heading. */
    modelName(name) {
        let short = `${name || ''}`.split('/').pop();
        return short.replace(/\.(safetensors|ckpt|sft|gguf|engine|pt|bin)$/i, '');
    }

    /** Heading + dim second line for a model card.
     *
     * Checkpoints stay file-name first: titles repeat across a series (a folder of "Anima" checkpoints all
     * report the title "Anima"), so a title-first checkpoint list is a column of identical rows. LoRAs are
     * the opposite - preferTitle - because their file names are often hashes or Civitai version stems, and
     * the metadata title is the name the user actually knows. A non-empty title is always the LoRA heading,
     * even when it equals the file stem: hiding it in that case is how "epoch_1" showed up as untitled.
     * The file stem is only the heading when title is absent. A distinct stem stays as the dim subtitle so
     * two LoRAs that share a title still tell apart. */
    modelLines(model, preferTitle) {
        let file = this.modelName(model.name);
        let title = `${model.title || ''}`.trim();
        let name = `${model.name || ''}`;
        let folder = name.includes('/') ? name.substring(0, name.lastIndexOf('/')) : '';
        if (preferTitle && title) {
            let subtitle = file && file.toLowerCase() != title.toLowerCase() ? file : folder;
            return { 'primary': title, 'subtitle': subtitle };
        }
        if (title && title.toLowerCase() != file.toLowerCase()) {
            return { 'primary': file, 'subtitle': title };
        }
        return { 'primary': file, 'subtitle': folder };
    }

    /** The star marking a favourite model, or null when it isn't one. Rows are sorted starred-first
     * (mState.starredFirst), and a list whose order changes with nothing on screen explaining why reads as a
     * list in a random order - this is what says "these are your stars". */
    starBadge(subtype, name) {
        return mState.isStarred(subtype, name) ? this.el('span', 'm-model-star', '\u2605') : null;
    }

    /** Thumbnail for a model, or null when it has no preview image. */
    modelThumb(model, className) {
        if (!model.preview_image) {
            return null;
        }
        let img = document.createElement('img');
        img.className = className;
        img.src = model.preview_image;
        img.loading = 'lazy';
        // Off the main thread, for the same reason the history grid sets it: iOS defers lazy image work while a
        // finger is on the glass, so a scrolled list decodes its whole newly-visible batch the moment the scroll
        // settles. Synchronous, that batch is a multi-second freeze right after the list comes to rest.
        img.decoding = 'async';
        return img;
    }

    /** The text block of a model row: name, subtitle, and the trigger phrase when the model declares one.
     * Trigger phrases are the reason a LoRA row needs more than a name - onTrigger, when given, makes the
     * phrase a tappable chip. The chip shows the literal phrase (so you know what you are getting) but the
     * callback is what decides what gets inserted; mCreate inserts the `<trigger>` tag rather than the text.
     * preferTitle is the LoRA heading rule from modelLines - checkpoints omit it. */
    modelText(model, onTrigger, preferTitle) {
        let text = this.el('div', 'm-model-text');
        let lines = this.modelLines(model, preferTitle);
        text.appendChild(this.el('div', 'm-model-name', lines.primary));
        if (lines.subtitle) {
            text.appendChild(this.el('div', 'm-model-sub', lines.subtitle));
        }
        let trigger = `${model.trigger_phrase || ''}`.trim();
        if (trigger) {
            let row = this.el('div', 'm-model-trigger');
            let shown = MUI.triggerPreview(trigger);
            if (onTrigger) {
                let button = this.el('button', 'm-trigger-chip', `+ ${shown}`);
                button.addEventListener('click', (e) => {
                    e.stopPropagation();
                    onTrigger(trigger);
                });
                row.appendChild(button);
            }
            else {
                row.appendChild(this.el('span', 'm-trigger-text', shown));
            }
            text.appendChild(row);
        }
        return text;
    }

    /** Most phrases a model row shows from a trigger phrase. */
    static TriggerPreviewPhrases = 6;

    /** Most characters a model row shows from a trigger phrase. */
    static TriggerPreviewChars = 120;

    /** A short, display-only form of a trigger phrase.
     *
     * Some LoRAs carry their whole training caption vocabulary as the trigger phrase. On this install
     * danmomo_ANIMA_V1 has 31,294 characters of comma-separated booru tags there, and 862 LoRAs exceed 300.
     * Printed whole, one row filled the LoRA picker with a wall of tags. The row keeps the leading phrases
     * (where trainers put the real trigger) and counts the rest. The full phrase is unchanged in metadata
     * and still reaches onTrigger. */
    static triggerPreview(trigger) {
        if (trigger.length <= MUI.TriggerPreviewChars) {
            return trigger;
        }
        let phrases = trigger.split(/[,;\n]/).map(p => p.trim()).filter(p => p.length > 0);
        let kept = [];
        let length = 0;
        for (let phrase of phrases) {
            if (kept.length >= MUI.TriggerPreviewPhrases || (kept.length > 0 && length + phrase.length > MUI.TriggerPreviewChars)) {
                break;
            }
            kept.push(phrase);
            length += phrase.length + 2;
        }
        let shown = kept.join(', ');
        if (shown.length > MUI.TriggerPreviewChars) {
            shown = `${shown.substring(0, MUI.TriggerPreviewChars - 1)}\u2026`;
        }
        let hidden = phrases.length - kept.length;
        return hidden > 0 ? `${shown} +${hidden} more` : shown;
    }

    /** Registers a tab: build(panel) runs once lazily, onShow(panel) runs every activation. */
    registerTab(name, build, onShow) {
        this.tabs[name] = { 'build': build, 'onShow': onShow };
    }

    /** Registers one extra More-tab row, so another extension can add an entry without editing m_app.js.
     * Rows are sorted alphabetically with the built-ins when the More tab builds. Call at script load: the
     * More tab builds lazily on first activation, and every script that could register runs before m_app.js,
     * which is loaded last. */
    registerMoreItem(label, onClick) {
        this.moreItems.push({ 'label': label, 'onClick': onClick });
    }

    /** Registers a tab AND creates its panel + bottom-nav button, so another extension can add a whole tab
     * without editing index.html. Call at script load, same contract as registerMoreItem: every script that
     * could register runs before m_app.js calls initRouter, which is what wires the created button. Scripts
     * are deferred, so .m-panels/.m-bottom-nav exist by the time any of them runs. The icon is a text glyph,
     * not an emoji - the shipped nav deliberately uses geometric characters (see the Create triangle). */
    registerNavTab(name, label, icon, build, onShow) {
        let panels = document.querySelector('.m-panels');
        let nav = document.querySelector('.m-bottom-nav');
        if (!panels || !nav || this.tabs[name]) {
            return;
        }
        let panel = document.createElement('section');
        panel.className = 'm-panel';
        panel.dataset.mtab = name;
        panels.appendChild(panel);
        let btn = this.el('button', 'm-nav-item');
        btn.dataset.mdest = name;
        let iconSpan = this.el('span', 'm-nav-icon', icon);
        btn.appendChild(iconSpan);
        btn.appendChild(document.createTextNode(label));
        nav.appendChild(btn);
        this.registerTab(name, build, onShow);
    }

    /** Wires the router and bottom nav. Call once after all tabs are registered. */
    initRouter() {
        let skipNavigation = document.querySelector('.skip-navigation');
        if (skipNavigation) {
            skipNavigation.addEventListener('click', (e) => {
                e.preventDefault();
                document.getElementById('m-main-content').focus({ preventScroll: true });
            });
        }
        for (let btn of document.querySelectorAll('.m-nav-item')) {
            btn.addEventListener('click', () => {
                location.hash = btn.dataset.mdest;
            });
        }
        window.addEventListener('hashchange', () => this.applyHash());
        this.applyHash();
    }

    /** Shows the tab named in the hash (default create). No '/' may ever appear in the hash - it corrupts
     * getWSAddress's last-slash strip. */
    applyHash() {
        let name = (location.hash || '#create').substring(1);
        if (!this.tabs[name]) {
            name = 'create';
        }
        for (let panel of document.querySelectorAll('.m-panel')) {
            panel.classList.toggle('m-tab-active', panel.dataset.mtab == name);
        }
        for (let btn of document.querySelectorAll('.m-nav-item')) {
            btn.classList.toggle('m-nav-active', btn.dataset.mdest == name);
        }
        let tab = this.tabs[name];
        let panel = document.querySelector(`.m-panel[data-mtab="${name}"]`);
        if (!this.built[name]) {
            this.built[name] = true;
            tab.build(panel);
        }
        if (tab.onShow) {
            tab.onShow(panel);
        }
    }

    /** Opens a bottom sheet with the given content element. Returns a close function. Drag-down on the grip
     * or backdrop tap dismisses. The optional onClose callback runs as soon as dismissal starts. */
    openSheet(contentElem, onClose = null) {
        let previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        this.sheetStack = this.sheetStack || [];
        let parentEntry = this.sheetStack.length > 0 ? this.sheetStack[this.sheetStack.length - 1] : null;
        this.sheetFocusVersion = (this.sheetFocusVersion || 0) + 1;
        this.openSheets++;
        this.applyKeyboardInset();
        let backdrop = this.el('div', 'm-sheet-backdrop');
        let sheet = this.el('div', 'm-sheet');
        let grip = this.el('div', 'm-sheet-grip');
        sheet.tabIndex = -1;
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        let title = contentElem.querySelector('.m-sheet-title');
        if (title) {
            if (!title.id) {
                this.sheetTitleCounter = (this.sheetTitleCounter || 0) + 1;
                title.id = `m-sheet-title-${this.sheetTitleCounter}`;
            }
            sheet.setAttribute('aria-labelledby', title.id);
        }
        else {
            sheet.setAttribute('aria-label', contentElem.getAttribute('aria-label') || 'Dialog');
        }
        let app = document.querySelector('.m-app');
        if (app && !this.sheetAppState) {
            this.sheetAppState = { 'element': app, 'hadAriaHidden': app.hasAttribute('aria-hidden'),
                'ariaHidden': app.getAttribute('aria-hidden'), 'inert': !!app.inert };
        }
        sheet.appendChild(grip);
        sheet.appendChild(contentElem);
        document.body.appendChild(backdrop);
        document.body.appendChild(sheet);
        let entry = { 'sheet': sheet, 'backdrop': backdrop, 'previousFocus': previousFocus,
            'hadAriaHidden': sheet.hasAttribute('aria-hidden'), 'ariaHidden': sheet.getAttribute('aria-hidden'),
            'inert': !!sheet.inert, 'parent': parentEntry, 'closed': false };
        this.sheetStack.push(entry);
        this.syncSheetAccessibility();
        requestAnimationFrame(() => {
            if (entry.closed || this.sheetStack[this.sheetStack.length - 1] != entry) {
                return;
            }
            backdrop.classList.add('m-open');
            sheet.classList.add('m-open');
            sheet.focus({ preventScroll: true });
        });
        let close = () => {
            // Guarded: backdrop tap, grip drag and the caller's own returned close() can all fire for one sheet,
            // and the open-sheet count below must not go negative or the keyboard watch stops publishing.
            if (entry.closed) {
                return;
            }
            entry.closed = true;
            let closeFocusVersion = ++this.sheetFocusVersion;
            /** Retries focus lost during dismissal without overriding a newer user-selected control. */
            let shouldRetryFocus = target => {
                let active = document.activeElement;
                return this.sheetFocusVersion == closeFocusVersion && this.sheetStack.length == 0 && target.isConnected
                    && (active == document.body || active == document.documentElement || sheet.contains(active));
            };
            if (onClose) {
                onClose();
            }
            this.openSheets--;
            let entryIndex = this.sheetStack.indexOf(entry);
            if (entryIndex >= 0) {
                this.sheetStack.splice(entryIndex, 1);
            }
            sheet.setAttribute('aria-hidden', 'true');
            sheet.inert = true;
            sheet.tabIndex = -1;
            this.syncSheetAccessibility();
            backdrop.classList.remove('m-open');
            sheet.classList.remove('m-open');
            let activeEntry = this.sheetStack.length > 0 ? this.sheetStack[this.sheetStack.length - 1] : null;
            if (entryIndex == this.sheetStack.length) {
                if (activeEntry) {
                    let target = previousFocus && activeEntry.sheet.contains(previousFocus) ? previousFocus : activeEntry.sheet;
                    target.focus({ preventScroll: true });
                }
                else {
                    let restoreEntry = entry;
                    let target = restoreEntry.previousFocus;
                    while (restoreEntry.parent && (!target || !target.isConnected || restoreEntry.sheet.contains(target)
                        || (restoreEntry.parent.closed && restoreEntry.parent.sheet.contains(target)))) {
                        restoreEntry = restoreEntry.parent;
                        target = restoreEntry.previousFocus;
                    }
                    if (target && target.isConnected) {
                        entry.restoreTarget = target;
                        target.focus({ preventScroll: true });
                        // WebKit can reject a focus move made inside the same Escape keydown that made the
                        // active dialog inert. Retry after event dispatch, but only if no newer sheet opened.
                        if (document.activeElement != target) {
                            setTimeout(() => {
                                if (shouldRetryFocus(target)) {
                                    target.focus({ preventScroll: true });
                                }
                            }, 0);
                        }
                        // WebKit can briefly report the new focus during keydown and then put focus back on
                        // the closing dialog. The next frame check catches that second phase as well.
                        requestAnimationFrame(() => {
                            if (document.activeElement != target && shouldRetryFocus(target)) {
                                target.focus({ preventScroll: true });
                            }
                        });
                    }
                }
            }
            setTimeout(() => {
                backdrop.remove();
                sheet.remove();
                if (this.sheetFocusVersion == closeFocusVersion && this.sheetStack.length == 0
                    && entry.restoreTarget && entry.restoreTarget.isConnected) {
                    setTimeout(() => {
                        if (document.activeElement != entry.restoreTarget && shouldRetryFocus(entry.restoreTarget)) {
                            entry.restoreTarget.focus({ preventScroll: true });
                        }
                    }, 50);
                }
            }, 250);
        };
        backdrop.addEventListener('click', close);
        sheet.addEventListener('keydown', e => {
            if (e.key == 'Escape') {
                e.preventDefault();
                close();
                return;
            }
            if (e.key != 'Tab') {
                return;
            }
            let focusable = [...sheet.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
                .filter(elem => elem.offsetParent !== null);
            if (focusable.length == 0) {
                e.preventDefault();
                sheet.focus({ preventScroll: true });
                return;
            }
            let first = focusable[0];
            let last = focusable[focusable.length - 1];
            if (e.shiftKey && (document.activeElement == sheet || document.activeElement == first || !sheet.contains(document.activeElement))) {
                e.preventDefault();
                last.focus();
            }
            else if (!e.shiftKey && (document.activeElement == sheet || document.activeElement == last || !sheet.contains(document.activeElement))) {
                e.preventDefault();
                first.focus();
            }
        });
        let startY = -1;
        // Set when a touch gesture has been fully handled by touchend below, so the synthetic click that iOS
        // fires afterwards does not ALSO run the click handler. Without this the drag threshold was decorative:
        // touchend correctly declined to close on a 20px drag, and then the synthetic click closed the sheet
        // anyway. Cleared on a timer because the synthetic click arrives a moment after touchend, and the
        // handler must stay live for real mouse clicks (desktop taps the grip to close).
        let touchHandled = false;
        grip.addEventListener('touchstart', (e) => {
            startY = e.touches.item(0).clientY;
        }, { passive: true });
        grip.addEventListener('touchmove', (e) => {
            if (startY != -1) {
                let delta = e.touches.item(0).clientY - startY;
                if (delta > 0) {
                    sheet.style.transform = `translateY(${delta}px)`;
                }
            }
        }, { passive: true });
        grip.addEventListener('touchend', (e) => {
            // A touch that ended on the grip without having started there leaves startY at -1, which made
            // `clientY - startY` a large positive number and dismissed the sheet on a gesture the grip never
            // saw the beginning of.
            if (startY == -1) {
                return;
            }
            let delta = e.changedTouches.item(0).clientY - startY;
            sheet.style.transform = '';
            startY = -1;
            touchHandled = true;
            setTimeout(() => {
                touchHandled = false;
            }, 500);
            if (delta > 60) {
                close();
            }
        });
        // A touch the system takes away mid-drag never fires touchend, so reset the visual offset here or the
        // sheet stays parked partway down for the rest of its life.
        grip.addEventListener('touchcancel', () => {
            sheet.style.transform = '';
            startY = -1;
        });
        grip.addEventListener('click', () => {
            if (touchHandled) {
                return;
            }
            close();
        });
        return close;
    }

    /** Makes the top sheet the only exposed modal, while preserving the page's prior accessibility state. */
    syncSheetAccessibility() {
        let activeEntry = this.sheetStack.length > 0 ? this.sheetStack[this.sheetStack.length - 1] : null;
        for (let entry of this.sheetStack) {
            let active = entry == activeEntry;
            if (active) {
                if (entry.hadAriaHidden) {
                    entry.sheet.setAttribute('aria-hidden', entry.ariaHidden);
                }
                else {
                    entry.sheet.removeAttribute('aria-hidden');
                }
                entry.sheet.inert = entry.inert;
            }
            else {
                entry.sheet.setAttribute('aria-hidden', 'true');
                entry.sheet.inert = true;
            }
        }
        if (this.sheetAppState) {
            let app = this.sheetAppState.element;
            if (activeEntry) {
                app.setAttribute('aria-hidden', 'true');
                app.inert = true;
            }
            else {
                if (this.sheetAppState.hadAriaHidden) {
                    app.setAttribute('aria-hidden', this.sheetAppState.ariaHidden);
                }
                else {
                    app.removeAttribute('aria-hidden');
                }
                app.inert = this.sheetAppState.inert;
                // Force WebKit to apply the restored inert state before close() returns focus to an app child.
                app.getBoundingClientRect();
                this.sheetAppState = null;
            }
        }
    }

    /** Small confirm helper (native confirm is fine on mobile and needs no DOM). */
    confirm(message, onYes) {
        if (window.confirm(message)) {
            onYes();
        }
    }

    /** Shows a transient message in the client's own toast.
     * Deliberately NOT site.js's showError: that renders into the shared toast box whose header is the
     * literal word "Error" (built server-side by WebUtil.Toast), so routing confirmations through it made
     * "Model set: Anima" read as a failure. Failures go to error() below, which owns the header strip. */
    toast(message, kind) {
        if (!this.toastBox) {
            this.toastBox = this.el('div', 'm-toast');
            this.toastBox.addEventListener('click', () => this.toastBox.classList.remove('m-toast-open'));
            document.body.appendChild(this.toastBox);
        }
        this.toastBox.textContent = message;
        this.toastBox.classList.toggle('m-toast-warn', kind == 'warn');
        this.toastBox.classList.add('m-toast-open');
        if (this.toastTimer) {
            clearTimeout(this.toastTimer);
        }
        this.toastTimer = setTimeout(() => {
            this.toastBox.classList.remove('m-toast-open');
            this.toastTimer = null;
        }, kind == 'warn' ? 4000 : 2200);
    }

    /** Neutral confirmation ("Model set: ...", "Added <trigger>"). */
    note(message) {
        this.toast(message, 'info');
    }

    /** Something the user needs to fix or know went wrong, short of a transport failure. */
    warn(message) {
        this.toast(message, 'warn');
    }

    /** Shows a failure in the header's error strip. Every showError call on this client ends up here - see the
     * override at the bottom of this file.
     *
     * Why not site.js's center_toast: it is a fixed box at `top: 3rem`, which on a phone lands over the header,
     * the prompt box and the top of the model strip, flashes red, and never dismisses itself - so a failed
     * generation hid the controls you needed to retry it, behind the notice that it failed. The strip takes the
     * header title's place instead: the header keeps its height (nothing below it moves) and it covers no
     * content, because the header is chrome. The m.css block documents the two rules that keep it that way.
     *
     * Unlike the toast this is sticky, deliberately - a failure is not a confirmation, and the reason a
     * generation died should still be readable after you look away from the phone. It clears on its own X, and
     * on the next generate (mCreate.doGenerate), which is the point the old message stops describing anything.
     *
     * The [TOAST] markup in index.html stays regardless: this replaces site.js's showError, it does not delete
     * it, and the elements have to exist if anything ever reaches the original. */
    error(message) {
        let text = `${message}`;
        let els = this.errorBar();
        if (!els) {
            // The header markup is static so this shouldn't happen, but a toast beats swallowing a failure.
            this.warn(text);
            return;
        }
        els.line.textContent = text;
        els.detail.textContent = text;
        // A new failure collapses the old one's detail panel - it is the previous error's text.
        els.detail.style.display = 'none';
        els.line.setAttribute('aria-expanded', 'false');
        els.bar.style.display = '';
        els.header.classList.add('m-header-erred');
    }

    /** Hides the header error strip, restoring the title. Safe to call when nothing is showing. */
    clearError() {
        let els = this.errorBar();
        if (!els) {
            return;
        }
        els.bar.style.display = 'none';
        els.detail.style.display = 'none';
        els.line.setAttribute('aria-expanded', 'false');
        els.header.classList.remove('m-header-erred');
    }

    /** Opens/closes the full-text panel under the header. The one-line strip is clipped, and upstream error
     * strings are routinely a backend traceback rather than a sentence, so the untruncated text has to be
     * reachable - as an overlay, so reading it doesn't move the panels either. */
    toggleErrorDetail() {
        let els = this.errorBar();
        if (!els) {
            return;
        }
        let open = els.detail.style.display == 'none';
        els.detail.style.display = open ? '' : 'none';
        els.line.setAttribute('aria-expanded', `${open}`);
    }

    /** Records the user's `ui.HideErrorMessages` value (pipe-separated substrings) for the showError override
     *  at the bottom of this file. Fed from the one GetUserSettings call m_autocomplete already makes, rather
     *  than a second request of our own. Until that lands the list is empty, which fails open: an error shows
     *  rather than being wrongly swallowed. */
    setErrorFilters(raw) {
        this.errorFilters = `${raw || ''}`.split('|').map(x => x.trim()).filter(x => x);
    }

    /** Resolves and wires the header error strip on first use; null when the markup isn't present. */
    errorBar() {
        if (this.errorEls !== undefined) {
            return this.errorEls;
        }
        let header = document.querySelector('.m-header');
        let bar = document.querySelector('.m-header-error');
        let line = document.querySelector('.m-header-error-text');
        let detail = document.querySelector('.m-header-error-detail');
        let close = document.querySelector('.m-header-error-x');
        this.errorEls = header && bar && line && detail && close ? { header, bar, line, detail, close } : null;
        if (this.errorEls) {
            line.addEventListener('click', () => this.toggleErrorDetail());
            close.addEventListener('click', () => this.clearError());
        }
        return this.errorEls;
    }

    /** Hides the bottom nav while the on-screen keyboard is open. The layout is normal-flow so iOS handles
     * scroll-into-view natively; this only prevents the nav floating mid-screen. */
    initKeyboardWatch() {
        if (!window.visualViewport) {
            return;
        }
        // Both writes are guarded against no-op updates. This handler runs on EVERY visualViewport scroll
        // frame, and iOS fires that during ordinary page scrolling and rubber-band overscroll, not only while a
        // keyboard is up. An unguarded setProperty on documentElement dirties a custom property on :root, which
        // invalidates style for every element that could inherit it - the whole document, including a history
        // grid holding hundreds of tiles - once per scroll frame. That is the scroll stutter; the value itself
        // is 0 and unchanged for the entire scroll, so the recalc buys nothing.
        let lastInset = null, lastOpen = null;
        let apply = () => {
            let open = this.keyboardOpen();
            if (open !== lastOpen) {
                lastOpen = open;
                document.body.classList.toggle('m-kb-open', open);
            }
            // --m-kb-inset has exactly one consumer, .m-sheet, so with no sheet on screen the value is measured
            // and published for nobody - and publishing it still costs a full-document style recalc. Held at 0
            // instead, which is what a closed sheet would read anyway; openSheet() re-runs apply() so a sheet
            // that opens under a live keyboard gets the real inset immediately rather than one frame late.
            // iOS bounce scrolling can produce a negative viewport offset without a keyboard covering anything.
            let inset = this.openSheets > 0 && open ? this.keyboardInset() : 0;
            if (inset !== lastInset) {
                lastInset = inset;
                document.documentElement.style.setProperty('--m-kb-inset', `${inset}px`);
            }
        };
        this.applyKeyboardInset = apply;
        // 'scroll' as well as 'resize': iOS scrolls the LAYOUT viewport under an open keyboard, which changes
        // offsetTop without changing height, so a resize-only listener would leave the inset stale mid-scroll.
        window.visualViewport.addEventListener('resize', apply);
        window.visualViewport.addEventListener('scroll', apply);
        apply();
    }

    /** How many CSS px at the bottom of the LAYOUT viewport are covered by the on-screen keyboard.
     *
     * This is a different question from keyboardOpen() below, and conflating the two is the documented genpage
     * bug - hence two measures. `position: fixed; bottom: 0` anchors to the layout viewport, which iOS does not
     * shrink for the keyboard, so a bottom sheet sits behind it. The visible band in those same coordinates is
     * [offsetTop, offsetTop + height], so whatever lies below its bottom edge is the covered strip.
     *
     * offsetTop IS included here (unlike keyboardOpen) precisely because this answer must shrink as iOS scrolls
     * the layout viewport up - the covered strip genuinely gets smaller. Clamped at 0 so desktop, and the
     * elastic overscroll that briefly makes this negative on iOS, both read as "nothing covered". */
    keyboardInset() {
        if (!window.visualViewport) {
            return 0;
        }
        let covered = window.innerHeight - (window.visualViewport.height + window.visualViewport.offsetTop);
        return Math.max(0, Math.round(covered));
    }

    /** Whether an on-screen keyboard is up.
     * offsetTop is deliberately NOT subtracted. iOS scrolls the layout viewport under an open keyboard, and
     * subtracting offsetTop makes this answer shrink toward 0 mid-scroll - which would report the keyboard
     * as closed while it is still very much up. That conflation is the documented genpage keyboard bug.
     * False on any browser without visualViewport, which is the right answer for a desktop browser. */
    keyboardOpen() {
        return !!window.visualViewport && window.innerHeight - window.visualViewport.height > 120;
    }
}

mUI = new MUI();

/* Routes every error on this client into the header strip instead of the shared center_toast. site.js declares
 * showError as a plain global function, so reassigning it here is what the unqualified `showError(...)` calls
 * in site.js itself (genericRequest's default handler, makeWSRequest's fail path, the server-has-updated
 * notice) and in m_gen.js's failed() actually reach from this point on.
 *
 * Installed at file scope rather than from MApp.init(): init() is allowed to throw - it has its own
 * boot-failure banner for that - and a boot that went wrong is exactly when errors need somewhere to land.
 * m_ui.js is deferred and ordered after site.js, so the original is guaranteed to exist by now; the typeof
 * guard is only so a future load-order change degrades to "no override" instead of a boot-killing throw.
 *
 * The ui.HideErrorMessages filter is re-implemented rather than delegated, because delegating would mean
 * calling the original showError - which is the toast this exists to replace. Keep the two in step.
 *
 * The filter list comes from mUI.errorFilters, fed by m_autocomplete's GetUserSettings call. It used to come
 * only from getUserSetting, which is defined in the genpage's settings_editor.js - a file /simple never loads
 * - so the `typeof getUserSetting == 'function'` test was always false here and the filter silently matched
 * nothing at all. getUserSetting is still consulted when it does exist, so this keeps working unchanged if
 * these scripts are ever loaded alongside the genpage's. */
if (typeof showError == 'function') {
    window.showError = (message) => {
        let excluded = [...(mUI.errorFilters || [])];
        if (typeof getUserSetting == 'function') {
            excluded.push(...`${getUserSetting('ui.HideErrorMessages', '')}`.split('|').map(x => x.trim()));
        }
        for (let entry of excluded) {
            if (entry && `${message}`.includes(entry)) {
                console.log(`Error message ${message} contains excluded message ${entry}, not showing.`);
                return;
            }
        }
        mUI.error(message);
    };
}
