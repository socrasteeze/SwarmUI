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
                    // Same response already carries the user's starred models, so the pickers get favourites
                    // ordering for free - no second request, and no new server route.
                    mState.starredModels = data.starred_models || {};
                    mState.changed();
                });
                mAutoComplete.loadSettings();
                mGen.pollStatus();
            });
            mUI.registerTab('create', p => mCreate.build(p), () => mCreate.onShow());
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
        // One preference for both UIs: `m_client_haptics` is read by m_gen.js here and by mobile_network.js
        // on the genpage, so this is the single place the user sets it - the genpage has no equivalent control.
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
        // Restart the SERVER - deliberately distinct from "Force update" above, which only ever touches this
        // browser (caches + service worker). The two are not interchangeable: a Release-build server reads
        // every /simple, MobileEnhancements and TagDex asset from disk ONCE and serves that copy for its whole
        // life (WebServer.ViewExtensionScript's GetLazy branch), so an edited or newly added asset is invisible
        // until the process restarts, no matter how thoroughly the client clears its own caches. Before this
        // row, the only way to do that from a phone was the desktop-oriented Server tab on the genpage.
        // Permission is checked at click rather than at build, matching the TagDex sheet: hasPermission()
        // fails OPEN before the session lands, and this panel can be built by a #more deep link before then.
        let restart = mUI.el('button', 'm-more-item', 'Restart Server');
        restart.addEventListener('click', () => {
            if (typeof permissions != 'undefined' && !permissions.hasPermission('restart')) {
                mUI.warn('You do not have permission to restart the server.');
                return;
            }
            // Says "interrupts" rather than "may interrupt" when there is actually queued work, because the
            // cost of this is entirely about what is in flight right now.
            let queued = mGen.queueTotal > 0 ? `This interrupts ${mGen.queueTotal} queued/running generation(s). ` : '';
            mUI.confirm(`Restart the SwarmUI server? ${queued}The app reloads when the server returns.`, () => {
                this.restartServer(restart);
            });
        });
        list.appendChild(restart);
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

    /** Fires the server restart and hands off to the watcher.
     *
     * `RestartServer` exits with code 42 without applying updates or forcing a rebuild. That exit code
     * tells the launch script to relaunch, so **this only comes back if the server was started
     * through a launch script**; a bare `dotnet run` just exits, which is why the watcher below eventually
     * gives up with an honest message instead of spinning forever.
     *
     * The error path is split on the type rather than reported blindly, because "the connection died" is the
     * expected outcome here, not a failure: site.js hands a transport failure to errorHandle as the raw
     * ProgressEvent, while an actual server-side rejection (no permission, bad request) arrives as a string.
     * A string means the restart never started and the row goes back; anything else means the server is
     * already going down, which is exactly what was asked for. */
    restartServer(row) {
        row.disabled = true;
        row.textContent = 'Restarting server...';
        genericRequest('RestartServer', {}, data => this.awaitServerReturn(row), 0, err => {
            if (typeof err == 'string') {
                row.disabled = false;
                row.textContent = 'Restart Server';
                mUI.warn(`Could not restart: ${err}`);
                return;
            }
            this.awaitServerReturn(row);
        });
    }

    /** Waits for the server to go away and come back, then reloads into the fresh one.
     *
     * Two phases, and the first one is the whole reason this isn't a plain "poll until it answers" loop: the
     * server is still perfectly responsive for a moment after it accepts the request (the shutdown is a
     * detached task on a delay), so a single-phase watcher would get an immediate success, reload straight
     * back into the OLD process, and look like the button did nothing. So: wait for a probe to FAIL, and only
     * then wait for one to succeed.
     *
     * The probe is a POST because the service worker explicitly passes non-GET requests straight through
     * (`sw.js`: `if (request.method != 'GET') return`), so it can never be answered from cache - a cached 200
     * for a GET while the process is down would break both phases at once. Any HTTP response at all counts as
     * "up", including a rejection: the question is whether the web server is answering, not whether this
     * particular call succeeded.
     *
     * Finishes through hardRefresh() rather than location.reload() on purpose. The point of restarting from
     * here is almost always to pick up changed assets, and a plain reload can still be served the old ones out
     * of the browser/service-worker cache - `?vary=` only busts on a committed change, so an uncommitted asset
     * edit keeps the exact same URL across the restart. Clearing the client caches too makes this button do
     * the whole job rather than most of it. */
    async awaitServerReturn(row) {
        let probe = async () => {
            try {
                await fetch('API/GetNewSession', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}',
                    cache: 'no-store',
                });
                return true;
            }
            catch (e) {
                return false;
            }
        };
        let sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        // Generous, because "rebuild then relaunch" is genuinely slow on a cold build and the alternative is
        // telling someone their working restart failed. Both caps are counts of 2s polls.
        let downDeadline = 30;
        let upDeadline = 300;
        for (let i = 0; i < downDeadline; i++) {
            await sleep(2000);
            if (!await probe()) {
                row.textContent = 'Server restarting - waiting...';
                for (let j = 0; j < upDeadline; j++) {
                    await sleep(2000);
                    if (await probe()) {
                        row.textContent = 'Back up - reloading...';
                        this.hardRefresh();
                        return;
                    }
                }
                row.disabled = false;
                row.textContent = 'Restart Server';
                mUI.warn('The server has not come back yet. If it was not started from a launch script, it will not restart on its own.');
                return;
            }
        }
        // Never went down: the call was accepted but the process is still serving. Most likely the restart was
        // refused somewhere past the API layer, so say that rather than pretending it worked.
        row.disabled = false;
        row.textContent = 'Restart Server';
        mUI.warn('The server did not restart. Check the server logs.');
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
