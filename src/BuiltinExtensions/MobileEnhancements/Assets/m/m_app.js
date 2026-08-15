/** MobileEnhancements standalone client - boot.
 * getSession → compact ListT2IParams + GetMyUserData → register tabs → router. Autocomplete data loads
 * lazily on first prompt focus. Any boot failure unhides the static
 * failure banner with the classic-UI escape link instead of dying silently. */
class MApp {

    /** Boots the client. */
    init() {
        try {
            mState.load();
            getSession(() => {
                genericRequest('ListT2IParams', { 'compact': true }, data => {
                    mState.loadParamMeta(data);
                    mState.changed();
                });
                genericRequest('GetMyUserData', { 'includeAutocompletions': false }, data => {
                    mState.presets = data.presets || [];
                    mState.changed();
                });
                mAutoComplete.loadSettings();
                mGen.pollStatus();
            });
            mUI.registerTab('create', p => mCreate.build(p), null);
            mUI.registerTab('images', p => mImages.build(p), () => mImages.onShow());
            mUI.registerTab('models', p => mModels.build(p), () => mModels.onShow());
            mUI.registerTab('more', p => this.buildMore(p), null);
            mUI.initRouter();
            mUI.initKeyboardWatch();
            this.wireHeader();
            this.watchForUpdate();
        }
        catch (e) {
            console.error('mobile client boot failed', e);
            let fail = document.querySelector('.m-boot-fail');
            if (fail) {
                fail.style.display = '';
            }
            let app = document.querySelector('.m-app');
            if (app) {
                app.style.display = 'none';
            }
        }
    }

    /** Queue chip in the header, driven by status frames. */
    wireHeader() {
        let chip = document.querySelector('.m-queue-chip');
        mGen.onFrame((kind, data) => {
            if (kind == 'status' && chip) {
                chip.textContent = `${mGen.queueTotal}`;
                chip.style.display = mGen.queueTotal > 0 ? '' : 'none';
            }
        });
    }

    /** More tab: links + small toggles. */
    buildMore(panel) {
        let list = mUI.el('div', 'm-more-list');
        let classic = mUI.el('a', 'm-more-item', 'Open Classic UI');
        classic.href = '/Text2Image';
        list.appendChild(classic);
        let haptics = mUI.el('button', 'm-more-item');
        let renderHaptics = () => {
            haptics.textContent = `Haptics: ${localStorage.getItem('m_client_haptics') == 'off' ? 'Off' : 'On'}`;
        };
        renderHaptics();
        haptics.addEventListener('click', () => {
            localStorage.setItem('m_client_haptics', localStorage.getItem('m_client_haptics') == 'off' ? 'on' : 'off');
            renderHaptics();
        });
        list.appendChild(haptics);
        // Off by default, and that default is load-bearing rather than timid - see enterWouldAccept. With it
        // on, Enter takes the top suggestion for any word; with it off, only inside a `<tag:`.
        let enterAccept = mUI.el('button', 'm-more-item');
        let renderEnterAccept = () => {
            enterAccept.textContent = `Enter accepts suggestion: ${mAutoComplete.enterAccepts ? 'Any word' : 'Only in <tags>'}`;
        };
        renderEnterAccept();
        enterAccept.addEventListener('click', () => {
            mAutoComplete.setEnterAccepts(!mAutoComplete.enterAccepts);
            renderEnterAccept();
        });
        list.appendChild(enterAccept);
        // Backend pin. Visibility is re-evaluated on every state change rather than decided here: this panel
        // builds lazily on first activation, and a deep link to #more can build it before ListT2IParams has
        // landed - at which point paramMeta is empty and the row would be hidden forever. The same
        // subscription keeps the label honest when the pin is cleared from the Create tab's chip.
        let backend = mUI.el('button', 'm-more-item');
        backend.addEventListener('click', () => mCreate.openBackendSheet());
        let renderBackend = () => {
            // Absent from paramMeta means the session lacks permission to set it - ListT2IParams only reports
            // parameters the session may actually use.
            backend.style.display = mState.paramMeta['exactbackendid'] ? '' : 'none';
            let current = mState.params['exactbackendid'];
            backend.textContent = `Backend: ${current == null ? 'Automatic' : MCreate.paramValueLabel('exactbackendid', current)}`;
        };
        renderBackend();
        mState.onChange(renderBackend);
        list.appendChild(backend);
        let clear = mUI.el('button', 'm-more-item', 'Reset mobile client state');
        clear.addEventListener('click', () => {
            mUI.confirm('Clear saved prompt, presets selection, and params?', () => {
                localStorage.removeItem('m_client_state');
                location.reload();
            });
        });
        list.appendChild(clear);
        let hardRefresh = mUI.el('button', 'm-more-item', 'Force update (clear app cache)');
        hardRefresh.addEventListener('click', () => {
            mUI.confirm('Delete the cached app files and reload? Your prompt and settings are kept.', () => {
                this.hardRefresh();
            });
        });
        list.appendChild(hardRefresh);
        for (let i = 0; i < mUI.moreItems.length; i++) {
            let entry = mUI.moreItems[i];
            let item = mUI.el('button', 'm-more-item', entry.label);
            item.addEventListener('click', () => entry.onClick());
            list.appendChild(item);
        }
        panel.appendChild(list);
    }

    /** Tells the user when a newer version of the app has been fetched and is waiting to take over.
     *
     * The service worker calls skipWaiting()/clients.claim(), so a new worker activates as soon as it installs -
     * but the PAGE keeps running the old scripts until it is reloaded, and in an installed PWA there is no
     * address bar to reload from and no reason for the user to suspect anything changed. 'controllerchange' is
     * the moment that swap happens; surfacing it turns a silent stale-until-you-force-quit state into a
     * one-tap update.
     *
     * Guarded on hasController: on the very FIRST visit the worker also takes control (going from no controller
     * to one), and telling a first-time user "an update is ready" for the version they just loaded would be
     * nonsense. Only a swap from one controller to another is a real update. */
    watchForUpdate() {
        if (!('serviceWorker' in navigator)) {
            return;
        }
        let hadController = !!navigator.serviceWorker.controller;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!hadController) {
                hadController = true;
                return;
            }
            mUI.note('Update ready - reopen the app, or use More > Force update.');
        });
    }

    /** Deletes every Cache Storage entry, unregisters the service worker, then reloads.
     *
     * This exists because a plain reload is NOT an escape hatch on iOS. The installed (Home Screen) app runs in
     * its own storage container, separate from Safari - so "clear Safari data" does nothing for it, and there is
     * no address bar, no devtools and no reload button to hold. If a bad or stale asset ever gets into Cache
     * Storage there, a user has no way out except deleting and reinstalling the app. This is that way out.
     *
     * Order matters: caches are deleted BEFORE the worker is unregistered. Unregister first and a still-running
     * worker can service one more fetch and repopulate what was just deleted. Reload goes through
     * location.reload() only after both settle, so the fresh page load has no controller and no cache to hit.
     * Everything is best-effort - a browser with no SW support or a rejected delete still ends in a reload,
     * which is strictly no worse than the button not existing. */
    async hardRefresh() {
        try {
            if (window.caches) {
                let names = await caches.keys();
                await Promise.all(names.map(name => caches.delete(name)));
            }
        }
        catch (e) {
            console.error('cache clear failed during hard refresh', e);
        }
        try {
            if ('serviceWorker' in navigator) {
                let regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(reg => reg.unregister()));
            }
        }
        catch (e) {
            console.error('service worker unregister failed during hard refresh', e);
        }
        location.reload();
    }
}

mApp = new MApp();
mApp.init();
