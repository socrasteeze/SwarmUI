/** MobileEnhancements standalone client - image history surface.
 * History tiles from ListImages (metadata arrives inline per file), chunk-rendered, with folder chips.
 * Tap opens a viewer overlay with swipe prev/next and the per-image actions - that viewer is shared,
 * mCreate's live preview tiles open it too. The live batch itself lives on the Create tab (mCreate),
 * not here, so generating never has to navigate away from the prompt box. */
class MImages {

    /** Sort options, label -> the ListImages sortBy/sortReverse pair it maps to. */
    static SortModes = {
        'Newest first': ['Date', true],
        'Oldest first': ['Date', false],
        'Name A-Z': ['Name', false],
        'Name Z-A': ['Name', true]
    };

    constructor() {
        /** Current history folder path ('' = root). */
        this.folder = '';
        /** Current sort mode label (a key of MImages.SortModes), persisted across sessions. */
        this.sortMode = localStorage.getItem('m_client_img_sort') || 'Newest first';
        if (!MImages.SortModes[this.sortMode]) {
            this.sortMode = 'Newest first';
        }
        /** Parsed history entries: {src, fullsrc, url, metadata}. */
        this.entries = [];
        /** How many history entries are currently rendered (chunked). */
        this.rendered = 0;
        /** Whether a refresh is needed on next show (set when images complete while elsewhere). */
        this.dirty = true;
        mGen.onFrame((kind, data) => this.onFrame(kind, data));
    }

    /** Builds the Images panel once. */
    build(panel) {
        this.panel = panel;
        let bar = mUI.el('div', 'm-images-bar');
        this.sortSelect = document.createElement('select');
        this.sortSelect.className = 'm-sort-select';
        for (let label in MImages.SortModes) {
            let opt = document.createElement('option');
            opt.value = label;
            opt.textContent = label;
            this.sortSelect.appendChild(opt);
        }
        this.sortSelect.value = this.sortMode;
        this.sortSelect.addEventListener('change', () => {
            this.sortMode = this.sortSelect.value;
            localStorage.setItem('m_client_img_sort', this.sortMode);
            this.refresh();
        });
        bar.appendChild(this.sortSelect);
        let refreshButton = mUI.el('button', 'm-refresh-button', '⟳');
        refreshButton.addEventListener('click', () => this.refresh());
        bar.appendChild(refreshButton);
        panel.appendChild(bar);
        this.folderChips = mUI.el('div', 'm-folder-chips');
        panel.appendChild(this.folderChips);
        this.grid = mUI.el('div', 'm-image-grid');
        panel.appendChild(this.grid);
        this.sentinel = mUI.el('div', 'm-scroll-sentinel');
        panel.appendChild(this.sentinel);
        let observer = new IntersectionObserver(() => this.renderMore(), { root: panel });
        observer.observe(this.sentinel);
    }

    /** Every activation: refresh history if marked dirty. */
    onShow() {
        if (this.dirty) {
            this.refresh();
        }
    }

    /** WS frame handling: the live tiles belong to mCreate, so all this surface needs to know is that
     * new files exist and the history listing is stale. */
    onFrame(kind, data) {
        if (kind == 'image' || kind == 'wake') {
            this.dirty = true;
        }
    }

    /** Best-effort conversion of a served image URL back to an output-root-relative path (for star/delete
     * and for attaching the file as a prompt image). Data URIs have no path - those are unsaved bytes, not
     * files. Absolute View URLs are stripped down to the same relative form ListImages reports. */
    urlToPath(url) {
        if (!url || `${url}`.startsWith('data:')) {
            return null;
        }
        let text = `${url}`;
        let prefix = `${getImageOutPrefix()}/`;
        let idx = text.indexOf(prefix);
        if (idx >= 0) {
            return text.substring(idx + prefix.length);
        }
        if (typeof isValidMediaPath == 'function' && isValidMediaPath(text)) {
            return text;
        }
        return null;
    }

    /** Prompt-image entry for a generated or history file. Always kind:'path' with the output-relative
     * path (raw/..., Starred/..., inputs/...). The server only expands those three prefixes into file
     * bytes; anything else is treated as base64, and ValidateParam interpolates the entire value into the
     * exception - a View URL or a data URI stuffed here is the "string too long" failure. Returns null
     * when the image was never saved (data URI preview, SaveFiles off). */
    promptPathEntry(urlOrPath) {
        let path = this.urlToPath(urlOrPath);
        if (!path || path.startsWith('data:')) {
            return null;
        }
        return { 'kind': 'path', 'value': path };
    }

    /** Fetches the current folder's history. */
    refresh() {
        this.dirty = false;
        let [sortBy, sortReverse] = MImages.SortModes[this.sortMode];
        genericRequest('ListImages', { 'path': this.folder, 'depth': 1, 'sortBy': sortBy, 'sortReverse': sortReverse }, data => {
            this.renderFolders(data.folders || []);
            let prefix = this.folder == '' ? '' : `${this.folder}/`;
            this.entries = (data.files || []).map(f => {
                let fullsrc = `${prefix}${f.src}`;
                let url = `${getImageOutPrefix()}/${fullsrc}`;
                // 'thumb' is what the grid renders; 'url' stays full-resolution for the viewer.
                // The grid draws into ~33vw cells, so pointing it at the original meant downloading and
                // DECODING a full 1024-2048px generation per ~120px tile. iOS holds decoded bitmaps at
                // 4 bytes/px, so a few dozen visible tiles is hundreds of MB of decode memory - which is how
                // a mobile Safari tab dies silently with no error. The server already renders a downscaled
                // preview for exactly this (WebServer.cs, ?preview=true) and the desktop history browser has
                // always used it (outputhistory.js); only this client was asking for originals.
                // Safe to always append: the server honours it only when the user's ImageHistoryUsePreviews
                // setting is on, and falls through to the original bytes for any file it cannot preview
                // (audio, unsupported formats), so this degrades to the previous behaviour rather than breaking.
                return { 'src': f.src, 'fullsrc': fullsrc, 'url': url, 'thumb': `${url}?preview=true`, 'metadata': f.metadata || '' };
            });
            this.grid.innerHTML = '';
            this.rendered = 0;
            this.renderMore();
        }, 0, err => {
            mUI.warn(`Could not load history: ${err}`);
        });
    }

    /** Renders the folder chip row (".." when inside a folder). */
    renderFolders(folders) {
        this.folderChips.innerHTML = '';
        if (this.folder != '') {
            let up = mUI.el('button', 'm-folder-chip m-folder-up', '←');
            up.addEventListener('click', () => {
                this.folder = this.folder.includes('/') ? this.folder.substring(0, this.folder.lastIndexOf('/')) : '';
                this.refresh();
            });
            this.folderChips.appendChild(up);
            this.folderChips.appendChild(mUI.el('span', 'm-folder-current', this.folder));
        }
        for (let folder of folders) {
            let chip = mUI.el('button', 'm-folder-chip', folder);
            chip.addEventListener('click', () => {
                this.folder = this.folder == '' ? folder : `${this.folder}/${folder}`;
                this.refresh();
            });
            this.folderChips.appendChild(chip);
        }
    }

    /** Renders the next chunk of history tiles (~40 per pass, images lazy-loaded). */
    renderMore() {
        let target = Math.min(this.rendered + 40, this.entries.length);
        for (let i = this.rendered; i < target; i++) {
            let entry = this.entries[i];
            let tile = mUI.el('div', 'm-image-tile-cell');
            let img = document.createElement('img');
            img.loading = 'lazy';
            // Off the main thread: a grid chunk is 40 images, and synchronous decode of that many at once is a
            // visible scroll stall on a phone.
            img.decoding = 'async';
            img.src = entry.thumb;
            tile.appendChild(img);
            tile.addEventListener('click', () => this.openViewer(entry, i));
            this.grid.appendChild(tile);
        }
        this.rendered = target;
    }

    /** Fullscreen viewer overlay: swipe left/right = prev/next history entry, action row below. */
    openViewer(entry, index) {
        let overlay = mUI.el('div', 'm-viewer');
        let imgWrap = mUI.el('div', 'm-viewer-imgwrap');
        let img = document.createElement('img');
        img.src = entry.url;
        imgWrap.appendChild(img);
        overlay.appendChild(imgWrap);
        let actions = mUI.el('div', 'm-viewer-actions');
        let close = () => overlay.remove();
        let show = (newEntry, newIndex) => {
            overlay.remove();
            this.openViewer(newEntry, newIndex);
        };
        let addAction = (label, handler) => {
            let btn = mUI.el('button', 'm-viewer-action', label);
            btn.addEventListener('click', handler);
            actions.appendChild(btn);
        };
        addAction('Reuse Params', () => {
            if (entry.metadata && mState.applyMetadata(entry.metadata)) {
                close();
                location.hash = 'create';
            }
            else {
                mUI.warn('No readable parameters on this image.');
            }
        });
        addAction('Prompt Img', () => {
            let attached = this.promptPathEntry(entry.fullsrc || entry.url);
            if (attached) {
                mState.promptImages.push(attached);
                mState.changed();
                close();
                location.hash = 'create';
            }
            else {
                mUI.warn('This image is not a saved file, so it cannot be attached as a path. Paste it into the prompt box instead.');
            }
        });
        addAction(entry.fullsrc && entry.fullsrc.startsWith('Starred/') ? 'Unstar' : 'Star', () => {
            if (entry.fullsrc) {
                genericRequest('ToggleImageStarred', { 'path': entry.fullsrc }, data => {
                    this.dirty = true;
                    close();
                    this.refresh();
                });
            }
        });
        addAction('Delete', () => {
            if (entry.fullsrc) {
                mUI.confirm('Delete this image?', () => {
                    genericRequest('DeleteImage', { 'path': entry.fullsrc }, data => {
                        this.dirty = true;
                        close();
                        this.refresh();
                    });
                });
            }
        });
        addAction('Raw', () => window.open(entry.url, '_blank'));
        addAction('Close', close);
        overlay.appendChild(actions);
        let startX = -1;
        let startY = -1;
        imgWrap.addEventListener('touchstart', (e) => {
            if (e.touches.length == 1) {
                startX = e.touches.item(0).clientX;
                startY = e.touches.item(0).clientY;
            }
            else {
                // Second finger down: this is a pinch, not a swipe. The single-touch check on touchstart alone
                // was not enough - a gesture that BEGAN with one finger had already recorded startX, so
                // spreading to a two-finger zoom and releasing still navigated away from the image being
                // zoomed. Disarming here is what makes the guard hold for the whole gesture.
                startX = -1;
                startY = -1;
            }
        }, { passive: true });
        imgWrap.addEventListener('touchcancel', () => {
            startX = -1;
            startY = -1;
        });
        imgWrap.addEventListener('touchend', (e) => {
            if (startX == -1 || index == null) {
                return;
            }
            let delta = e.changedTouches.item(0).clientX - startX;
            let deltaY = e.changedTouches.item(0).clientY - startY;
            startX = -1;
            startY = -1;
            // Axis lock: a diagonal drag (or a vertical one that drifted sideways past the threshold) should
            // not count as a horizontal swipe. Requiring horizontal travel to exceed vertical is what makes
            // this a swipe rather than "any gesture that happened to move 60px sideways".
            if (Math.abs(delta) > Math.abs(deltaY) && Math.abs(delta) > 60) {
                let next = delta < 0 ? index + 1 : index - 1;
                if (next >= 0 && next < this.entries.length) {
                    show(this.entries[next], next);
                }
            }
        });
        imgWrap.addEventListener('click', (e) => {
            if (e.target == imgWrap) {
                close();
            }
        });
        document.body.appendChild(overlay);
    }
}

mImages = new MImages();
