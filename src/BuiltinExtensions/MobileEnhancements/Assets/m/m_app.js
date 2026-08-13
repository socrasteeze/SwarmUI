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
        for (let i = 0; i < mUI.moreItems.length; i++) {
            let entry = mUI.moreItems[i];
            let item = mUI.el('button', 'm-more-item', entry.label);
            item.addEventListener('click', () => entry.onClick());
            list.appendChild(item);
        }
        panel.appendChild(list);
    }
}

mApp = new MApp();
mApp.init();
