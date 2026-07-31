/** MobileEnhancements standalone client - boot.
 * getSession → ListT2IParams + GetMyUserData → register tabs → router. Any boot failure unhides the static
 * failure banner with the classic-UI escape link instead of dying silently. */
class MApp {

    /** Boots the client. */
    init() {
        try {
            mState.load();
            getSession(() => {
                genericRequest('ListT2IParams', {}, data => {
                    mState.loadParamMeta(data);
                    mState.changed();
                });
                genericRequest('GetMyUserData', {}, data => {
                    mState.presets = data.presets || [];
                    // The autocompletion list rides this same response - no extra request, and it is
                    // null unless the user configured a source, in which case the feature stays inert.
                    mAutoComplete.loadFrom(data);
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
        let clear = mUI.el('button', 'm-more-item', 'Reset mobile client state');
        clear.addEventListener('click', () => {
            mUI.confirm('Clear saved prompt, presets selection, and params?', () => {
                localStorage.removeItem('m_client_state');
                location.reload();
            });
        });
        list.appendChild(clear);
        panel.appendChild(list);
    }
}

mApp = new MApp();
mApp.init();
