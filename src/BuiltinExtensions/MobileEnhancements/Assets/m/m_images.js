/** MobileEnhancements standalone client - unified Images surface.
 * One grid: live tiles for the current batch (fed by WS gen_progress/image frames, keyed
 * `${request_id}_${batch_index}`) above history tiles from ListImages (metadata arrives inline per file).
 * Tap opens a viewer overlay with swipe prev/next and the per-image actions. */
class MImages {

    constructor() {
        /** Live tiles by `${request_id}_${batch_index}`. */
        this.liveTiles = {};
        /** Current history folder path ('' = root). */
        this.folder = '';
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
        this.folderChips = mUI.el('div', 'm-folder-chips');
        panel.appendChild(this.folderChips);
        this.liveGrid = mUI.el('div', 'm-image-grid m-live-grid');
        panel.appendChild(this.liveGrid);
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

    /** WS frame handling: live tile lifecycle. */
    onFrame(kind, data) {
        if (kind == 'progress') {
            let tile = this.getLiveTile(`${data.request_id}_${data.batch_index}`);
            if (data.preview) {
                tile.querySelector('img').src = data.preview;
            }
            let pct = Math.round((data.overall_percent || 0) * 100);
            tile.querySelector('.m-tile-progress').style.width = `${pct}%`;
        }
        else if (kind == 'image') {
            let tile = this.getLiveTile(`${data.request_id}_${data.batch_index}`);
            let img = tile.querySelector('img');
            let url = data.image.startsWith('data:') ? data.image : `${data.image}`;
            img.src = url;
            tile.dataset.metadata = data.metadata || '';
            tile.dataset.url = url;
            tile.classList.add('m-tile-done');
            tile.querySelector('.m-tile-progress').style.width = '';
            this.dirty = true;
        }
        else if (kind == 'discard') {
            for (let key in this.liveTiles) {
                if (data.includes(parseInt(key.split('_').pop()))) {
                    this.liveTiles[key].remove();
                    delete this.liveTiles[key];
                }
            }
        }
        else if (kind == 'wake') {
            this.dirty = true;
        }
    }

    /** Gets or creates a live tile. A new request_id clears finished tiles from older requests (mirrors the
     * genpage Batch view the fork owner uses as the real preview). */
    getLiveTile(key) {
        if (this.liveTiles[key]) {
            return this.liveTiles[key];
        }
        let requestId = key.substring(0, key.lastIndexOf('_'));
        for (let existing in this.liveTiles) {
            if (!existing.startsWith(`${requestId}_`) && this.liveTiles[existing].classList.contains('m-tile-done')) {
                this.liveTiles[existing].remove();
                delete this.liveTiles[existing];
            }
        }
        let tile = mUI.el('div', 'm-image-tile-cell m-live-tile');
        let img = document.createElement('img');
        tile.appendChild(img);
        let bar = mUI.el('div', 'm-tile-progress');
        tile.appendChild(bar);
        tile.addEventListener('click', () => {
            if (tile.dataset.url) {
                this.openViewer({ 'url': tile.dataset.url, 'metadata': tile.dataset.metadata, 'fullsrc': this.urlToPath(tile.dataset.url) });
            }
        });
        this.liveTiles[key] = tile;
        this.liveGrid.appendChild(tile);
        return tile;
    }

    /** Best-effort conversion of a served image URL back to an output-root-relative path (for star/delete). */
    urlToPath(url) {
        let prefix = `${getImageOutPrefix()}/`;
        if (url.startsWith(prefix)) {
            return url.substring(prefix.length);
        }
        return null;
    }

    /** Fetches the current folder's history. */
    refresh() {
        this.dirty = false;
        genericRequest('ListImages', { 'path': this.folder, 'depth': 1, 'sortBy': 'Date', 'sortReverse': true }, data => {
            this.renderFolders(data.folders || []);
            let prefix = this.folder == '' ? '' : `${this.folder}/`;
            this.entries = (data.files || []).map(f => {
                let fullsrc = `${prefix}${f.src}`;
                return { 'src': f.src, 'fullsrc': fullsrc, 'url': `${getImageOutPrefix()}/${fullsrc}`, 'metadata': f.metadata || '' };
            });
            this.grid.innerHTML = '';
            this.rendered = 0;
            this.renderMore();
        }, 0, err => {
            mUI.note(`Could not load history: ${err}`);
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
            img.src = entry.url;
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
                mUI.note('No readable parameters on this image.');
            }
        });
        addAction('Prompt Img', () => {
            if (entry.fullsrc) {
                mState.promptImages.push({ 'kind': 'path', 'value': entry.fullsrc });
                mState.changed();
                close();
                location.hash = 'create';
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
        imgWrap.addEventListener('touchstart', (e) => {
            if (e.touches.length == 1) {
                startX = e.touches.item(0).clientX;
            }
        }, { passive: true });
        imgWrap.addEventListener('touchend', (e) => {
            if (startX == -1 || index == null) {
                return;
            }
            let delta = e.changedTouches.item(0).clientX - startX;
            startX = -1;
            if (Math.abs(delta) > 60) {
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
