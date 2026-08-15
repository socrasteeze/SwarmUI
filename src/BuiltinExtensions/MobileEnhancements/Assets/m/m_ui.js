/** MobileEnhancements standalone client - UI plumbing: hash router, bottom sheets, small DOM helpers. */
class MUI {

    constructor() {
        /** Registered tab initializers: name -> {build, onShow}. */
        this.tabs = {};
        /** Whether each tab has been built yet (lazy build on first show). */
        this.built = {};
        /** Extra More-tab rows contributed by other extensions: [{label, onClick}]. */
        this.moreItems = [];
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

    /** Primary display name for a model: file name, no folders, no extension. Deliberately NOT the metadata
     * title - titles routinely repeat across every file in a series (a folder of "Anima" checkpoints all
     * report the title "Anima"), so a title-first list is a list of identical rows. The file name is the
     * thing that actually differs, and it is what the model is called everywhere else. */
    modelName(name) {
        let short = `${name || ''}`.split('/').pop();
        return short.replace(/\.(safetensors|ckpt|sft|gguf|engine|pt|bin)$/i, '');
    }

    /** Secondary line for a model: the metadata title when it says something the file name doesn't, else
     * the containing folder. Empty when neither adds anything. */
    modelSubtitle(model) {
        let primary = this.modelName(model.name);
        let title = `${model.title || ''}`.trim();
        if (title && title.toLowerCase() != primary.toLowerCase()) {
            return title;
        }
        let name = `${model.name || ''}`;
        return name.includes('/') ? name.substring(0, name.lastIndexOf('/')) : '';
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
        return img;
    }

    /** The text block of a model row: name, subtitle, and the trigger phrase when the model declares one.
     * Trigger phrases are the reason a LoRA row needs more than a name - onTrigger, when given, makes the
     * phrase a tappable chip. The chip shows the literal phrase (so you know what you are getting) but the
     * callback is what decides what gets inserted; mCreate inserts the `<trigger>` tag rather than the text. */
    modelText(model, onTrigger) {
        let text = this.el('div', 'm-model-text');
        text.appendChild(this.el('div', 'm-model-name', this.modelName(model.name)));
        let subtitle = this.modelSubtitle(model);
        if (subtitle) {
            text.appendChild(this.el('div', 'm-model-sub', subtitle));
        }
        let trigger = `${model.trigger_phrase || ''}`.trim();
        if (trigger) {
            let row = this.el('div', 'm-model-trigger');
            if (onTrigger) {
                let button = this.el('button', 'm-trigger-chip', `+ ${trigger}`);
                button.addEventListener('click', (e) => {
                    e.stopPropagation();
                    onTrigger(trigger);
                });
                row.appendChild(button);
            }
            else {
                row.appendChild(this.el('span', 'm-trigger-text', trigger));
            }
            text.appendChild(row);
        }
        return text;
    }

    /** Registers a tab: build(panel) runs once lazily, onShow(panel) runs every activation. */
    registerTab(name, build, onShow) {
        this.tabs[name] = { 'build': build, 'onShow': onShow };
    }

    /** Registers one extra row at the bottom of the More tab, so another extension can add an entry without
     * editing m_app.js. Call at script load: the More tab builds lazily on first activation, and every script
     * that could register runs before m_app.js, which is loaded last. */
    registerMoreItem(label, onClick) {
        this.moreItems.push({ 'label': label, 'onClick': onClick });
    }

    /** Wires the router and bottom nav. Call once after all tabs are registered. */
    initRouter() {
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
     * or backdrop tap dismisses (interaction contract carried over from the proven shell). */
    openSheet(contentElem) {
        let backdrop = this.el('div', 'm-sheet-backdrop');
        let sheet = this.el('div', 'm-sheet');
        let grip = this.el('div', 'm-sheet-grip');
        sheet.appendChild(grip);
        sheet.appendChild(contentElem);
        document.body.appendChild(backdrop);
        document.body.appendChild(sheet);
        requestAnimationFrame(() => {
            backdrop.classList.add('m-open');
            sheet.classList.add('m-open');
        });
        let close = () => {
            backdrop.classList.remove('m-open');
            sheet.classList.remove('m-open');
            setTimeout(() => {
                backdrop.remove();
                sheet.remove();
            }, 250);
        };
        backdrop.addEventListener('click', close);
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

    /** Small confirm helper (native confirm is fine on mobile and needs no DOM). */
    confirm(message, onYes) {
        if (window.confirm(message)) {
            onYes();
        }
    }

    /** Shows a transient message in the client's own toast.
     * Deliberately NOT site.js's showError: that renders into the shared toast box whose header is the
     * literal word "Error" (built server-side by WebUtil.Toast), so routing confirmations through it made
     * "Model set: Anima" read as a failure. showError is now reserved for things that actually failed. */
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

    /** Hides the bottom nav while the on-screen keyboard is open. The layout is normal-flow so iOS handles
     * scroll-into-view natively; this only prevents the nav floating mid-screen. */
    initKeyboardWatch() {
        if (!window.visualViewport) {
            return;
        }
        let apply = () => {
            document.body.classList.toggle('m-kb-open', this.keyboardOpen());
            document.documentElement.style.setProperty('--m-kb-inset', `${this.keyboardInset()}px`);
        };
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
