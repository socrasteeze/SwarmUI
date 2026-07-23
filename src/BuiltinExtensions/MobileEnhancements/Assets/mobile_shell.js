/**
 * MobileEnhancements native app shell (fork extension).
 * Wraps the existing Generate-tab DOM in a native-feeling mobile shell: a persistent bottom tab bar
 * (Create / History / Models / More) and a slide-up parameters drawer. It drives the real core UI via the
 * same clicks/state the desktop UI uses (never a parallel state that could drift) - top-tab buttons, the
 * bottom-bar sub-tabs, and genTabLayout's bottom-bar open/close. Scoped entirely to body.small-window; desktop
 * is untouched. Opt-out via the "Classic layout" toggle in the More sheet (localStorage). See
 * docs/MobilePWA-Optimization-Plan.md.
 */
class MobileShell {

    /** localStorage key: when 'true', the shell stays dormant and the stock mobile layout is used. */
    static OPT_OUT_KEY = 'mobileEnh_shellClassic';

    /** Build the shell once the session (and the Generate DOM) is ready. */
    constructor() {
        this.built = false;
        this.drawerOpen = false;
        this.activeDest = 'create';
        sessionReadyCallbacks.push(() => this.init());
    }

    /** True unless the user opted back to the classic layout. Presentation itself is gated by CSS on small-window. */
    isEnabled() {
        return localStorage.getItem(MobileShell.OPT_OUT_KEY) != 'true';
    }

    /** Build the shell DOM and wire it up (idempotent). */
    init() {
        if (this.built) {
            return;
        }
        this.built = true;
        this.buildBottomNav();
        this.buildMoreSheet();
        this.buildDrawer();
        if (this.isEnabled()) {
            document.body.classList.add('mobile-shell-active');
        }
        // Land on a clean Create surface on first mobile load.
        if (document.body.classList.contains('small-window')) {
            this.showCreate();
        }
    }

    /** Look up the core layout singleton if present (defensive - never throw if core moved things). */
    layout() {
        return typeof genTabLayout != 'undefined' ? genTabLayout : null;
    }

    /** Click a core element by id if it exists (defensive wrapper around the tab-switch mechanism). */
    clickById(id) {
        let el = document.getElementById(id);
        if (el) {
            el.click();
        }
    }

    /** Small inline-SVG icon set for the nav (kept tiny and theme-inheriting via currentColor). */
    icon(name) {
        let paths = {
            create: '<path d="M12 3v18M3 12h18"/>',
            history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
            models: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
            more: '<path d="M4 7h16M4 12h16M4 17h16"/>'
        };
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
    }

    /** Build and append the fixed bottom navigation bar. */
    buildBottomNav() {
        let nav = document.createElement('nav');
        nav.className = 'mobile-bottom-nav';
        let items = [
            { dest: 'create', label: 'Create' },
            { dest: 'history', label: 'History' },
            { dest: 'models', label: 'Models' },
            { dest: 'more', label: 'More' }
        ];
        let html = '';
        for (let item of items) {
            html += `<button type="button" class="mobile-nav-item" data-dest="${item.dest}">${this.icon(item.dest)}<span>${item.label}</span></button>`;
        }
        nav.innerHTML = html;
        for (let btn of nav.querySelectorAll('.mobile-nav-item')) {
            btn.addEventListener('click', () => this.go(btn.dataset.dest));
        }
        document.body.appendChild(nav);
        this.nav = nav;
    }

    /** Build the "More" bottom sheet (top-level destinations that aren't in the nav + the classic-layout toggle). */
    buildMoreSheet() {
        let backdrop = document.createElement('div');
        backdrop.className = 'mobile-sheet-backdrop';
        backdrop.addEventListener('click', () => this.closeMore());
        let sheet = document.createElement('div');
        sheet.className = 'mobile-more-sheet';
        sheet.innerHTML = `
            <div class="mobile-sheet-handle"></div>
            <button type="button" class="mobile-more-item" data-target="utilitiestabbutton">Utilities</button>
            <button type="button" class="mobile-more-item" data-target="usersettingstabbutton">User Settings</button>
            <button type="button" class="mobile-more-item" data-target="servertabbutton">Server</button>
            <button type="button" class="mobile-more-item" data-target="simpletabbutton">Simple Mode</button>
            <button type="button" class="mobile-more-item mobile-more-toggle" data-action="classic">Switch to Classic Layout</button>`;
        for (let btn of sheet.querySelectorAll('.mobile-more-item')) {
            btn.addEventListener('click', () => {
                if (btn.dataset.action == 'classic') {
                    this.disableShell();
                    return;
                }
                this.closeMore();
                this.clickById(btn.dataset.target);
            });
        }
        this.wireDragDismiss(sheet, () => this.closeMore(), false);
        document.body.appendChild(backdrop);
        document.body.appendChild(sheet);
        this.moreSheet = sheet;
        this.moreBackdrop = backdrop;
    }

    /** Build the parameters drawer: a backdrop + a floating "Options" button. The drawer body reuses the core
     * #input_sidebar in-place (CSS repositions it as a bottom sheet), so all parameter logic stays core-driven. */
    buildDrawer() {
        let backdrop = document.createElement('div');
        backdrop.className = 'mobile-drawer-backdrop';
        backdrop.addEventListener('click', () => this.closeDrawer());
        document.body.appendChild(backdrop);
        this.drawerBackdrop = backdrop;
        let fab = document.createElement('button');
        fab.type = 'button';
        fab.className = 'mobile-options-fab';
        fab.textContent = 'Options';
        fab.addEventListener('click', () => this.toggleDrawer());
        document.body.appendChild(fab);
        this.optionsFab = fab;
        this.sidebar = document.getElementById('input_sidebar');
        if (this.sidebar) {
            this.wireDrawerSwipe(this.sidebar);
        }
        let grip = document.createElement('div');
        grip.className = 'mobile-drawer-grip';
        this.wireDragDismiss(grip, () => this.closeDrawer(), true);
        document.body.appendChild(grip);
        this.drawerGrip = grip;
    }

    /** Drag-down-to-dismiss for a shell surface: dismisses once the finger travels 45px downward, regardless
     * of any inner scroll state. With tapCloses, a still tap dismisses too (used for the drawer's grab strip,
     * where the whole element is a handle; not for surfaces whose children are buttons). */
    wireDragDismiss(el, dismiss, tapCloses) {
        let startY = 0;
        let moved = false;
        el.addEventListener('touchstart', (e) => {
            startY = e.touches[0].clientY;
            moved = false;
        }, { passive: true });
        el.addEventListener('touchmove', (e) => {
            let dy = e.touches[0].clientY - startY;
            if (Math.abs(dy) > 10) {
                moved = true;
            }
            if (dy > 45) {
                dismiss();
            }
        }, { passive: true });
        if (tapCloses) {
            el.addEventListener('touchend', () => {
                // A still tap on the handle closes too (drag tracking above suppresses this after a real drag).
                if (!moved) {
                    dismiss();
                }
            });
        }
    }

    /** Swipe-down-from-top dismissal for the drawer, active only when the drawer content is scrolled to the top. */
    wireDrawerSwipe(el) {
        let startY = 0;
        let dragging = false;
        el.addEventListener('touchstart', (e) => {
            dragging = this.drawerOpen && el.scrollTop <= 0;
            startY = e.touches[0].clientY;
        }, { passive: true });
        el.addEventListener('touchmove', (e) => {
            if (!dragging) {
                return;
            }
            let dy = e.touches[0].clientY - startY;
            if (dy > 70) {
                dragging = false;
                this.closeDrawer();
            }
        }, { passive: true });
    }

    /** Route a bottom-nav destination to the matching core view. */
    go(dest) {
        if (dest == 'more') {
            this.openMore();
            return;
        }
        this.closeMore();
        if (dest == 'create') {
            this.showCreate();
        }
        else if (dest == 'history') {
            this.showBottomTab('imagehistorytabclickable');
        }
        else if (dest == 'models') {
            this.showBottomTab('modelstabheader');
        }
        this.setActive(dest);
    }

    /** Highlight the active nav item. */
    setActive(dest) {
        this.activeDest = dest;
        if (!this.nav) {
            return;
        }
        for (let btn of this.nav.querySelectorAll('.mobile-nav-item')) {
            btn.classList.toggle('active', btn.dataset.dest == dest);
        }
    }

    /** Clean create surface: Generate tab active, bottom bar collapsed, drawer closed. */
    showCreate() {
        this.closeDrawer();
        this.clickById('text2imagetabbutton');
        let layout = this.layout();
        if (layout && typeof layout.setBottomShut == 'function') {
            layout.setBottomShut(true);
            layout.reapplyPositions();
        }
        this.setActive('create');
    }

    /** Open the bottom bar and select one of its sub-tabs (History/Models/etc.) by nav-link id. */
    showBottomTab(navId) {
        this.closeDrawer();
        this.clickById('text2imagetabbutton');
        let layout = this.layout();
        if (layout && typeof layout.setBottomShut == 'function') {
            layout.setBottomShut(false);
            layout.reapplyPositions();
        }
        this.clickById(navId);
    }

    /** Toggle the parameters drawer. */
    toggleDrawer() {
        if (this.drawerOpen) {
            this.closeDrawer();
        }
        else {
            this.openDrawer();
        }
    }

    /** Slide the parameters drawer up (two-step so the transform transitions from off-screen). */
    openDrawer() {
        if (this.drawerOpen) {
            return;
        }
        this.drawerOpen = true;
        document.body.classList.add('shell-drawer-open');
        // Force a reflow so the freshly-shown sidebar animates from translateY(100%) to 0.
        void document.body.offsetWidth;
        document.body.classList.add('shell-drawer-shown');
    }

    /** Slide the parameters drawer back down and hide it after the transition. */
    closeDrawer() {
        if (!this.drawerOpen) {
            return;
        }
        this.drawerOpen = false;
        document.body.classList.remove('shell-drawer-shown');
        setTimeout(() => {
            if (!this.drawerOpen) {
                document.body.classList.remove('shell-drawer-open');
            }
        }, 300);
    }

    /** Show the More sheet. */
    openMore() {
        document.body.classList.add('shell-more-open');
    }

    /** Hide the More sheet. */
    closeMore() {
        document.body.classList.remove('shell-more-open');
    }

    /** Opt out: remove the shell for this device and restore the classic mobile layout. */
    disableShell() {
        localStorage.setItem(MobileShell.OPT_OUT_KEY, 'true');
        this.closeMore();
        this.closeDrawer();
        document.body.classList.remove('mobile-shell-active');
        let layout = this.layout();
        if (layout && typeof layout.reapplyPositions == 'function') {
            layout.reapplyPositions();
        }
    }
}

let mobileShell = new MobileShell();
