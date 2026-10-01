/** MobileEnhancements standalone client - server-backed image folder browser for /simple.
 * Opens a bottom sheet that lists Swarm output folders via ListImages (same API as the Images tab and
 * Classic's input browser). Configurable root chips (localStorage) jump to common trees under the
 * configured OutputPath - Inputs, Starred, MixStudio, year folders, etc. - without touching iOS Files.
 * Selection returns a path entry ({kind:'path', value:outputRelativePath}) that initimage / videoendimage /
 * promptimages already know how to send. An optional "From phone" control keeps the device picker as a
 * fallback for images that are not already on the server. */
class MImageBrowser {

    static StorageKey = 'm_client_img_browser_roots';

    /** Default roots under the user OutputPath. Paths are ListImages-relative (empty = output root). */
    static DefaultRoots = [
        { 'label': 'Output', 'path': '' },
        { 'label': 'Inputs', 'path': 'inputs' },
        { 'label': 'Starred', 'path': 'Starred' },
        { 'label': 'MixStudio', 'path': 'MixStudio' }
    ];

    constructor() {
        /** Current ListImages path under the output root. */
        this.path = '';
        /** Active root chip path (used to highlight the matching chip). */
        this.rootPath = '';
    }

    /** Loads configured roots from localStorage, falling back to DefaultRoots. */
    loadRoots() {
        try {
            let raw = localStorage.getItem(MImageBrowser.StorageKey);
            if (raw) {
                let parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed.map(r => ({
                        'label': `${r.label || r.path || 'Root'}`.trim() || 'Root',
                        'path': `${r.path || ''}`.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
                    }));
                }
            }
        }
        catch (e) {
            // Corrupt storage: fall through to defaults.
        }
        return MImageBrowser.DefaultRoots.map(r => ({ 'label': r.label, 'path': r.path }));
    }

    /** Persists roots to localStorage. */
    saveRoots(roots) {
        localStorage.setItem(MImageBrowser.StorageKey, JSON.stringify(roots));
    }

    /** Blurs whatever currently holds focus so the sheet is not trapped under the iOS keyboard. */
    dismissKeyboard() {
        if (document.activeElement && document.activeElement.blur) {
            document.activeElement.blur();
        }
    }

    /**
     * Opens the browser sheet.
     * @param {object} opts
     * @param {string} [opts.title] Sheet title.
     * @param {string[]} [opts.mediaTypes] Allowed getMediaType values (default ['image']).
     * @param {function} opts.onPick Called with {kind:'path'|'data', value:string} when the user picks.
     * @param {boolean} [opts.allowPhone=true] Show "From phone" fallback.
     * @param {string} [opts.startPath] Optional initial ListImages path (overrides last root).
     */
    open(opts) {
        this.dismissKeyboard();
        let title = opts.title || 'Pick image';
        let mediaTypes = opts.mediaTypes || ['image'];
        let onPick = opts.onPick;
        let allowPhone = opts.allowPhone !== false;
        let roots = this.loadRoots();
        if (typeof opts.startPath == 'string') {
            this.path = opts.startPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            this.rootPath = this.path;
        }
        else if (!this.path && roots.length) {
            this.path = roots[0].path;
            this.rootPath = roots[0].path;
        }
        let content = mUI.el('div', 'm-imgbrowser');
        content.appendChild(mUI.el('div', 'm-sheet-title', title));
        let rootsRow = mUI.el('div', 'm-imgbrowser-roots');
        content.appendChild(rootsRow);
        let folderChips = mUI.el('div', 'm-folder-chips');
        content.appendChild(folderChips);
        let toolbar = mUI.el('div', 'm-imgbrowser-toolbar');
        let pathLabel = mUI.el('div', 'm-imgbrowser-path', this.path || '(output root)');
        toolbar.appendChild(pathLabel);
        let rootsBtn = mUI.el('button', 'm-imgbrowser-tool', 'Roots');
        toolbar.appendChild(rootsBtn);
        let phoneInput = null;
        if (allowPhone) {
            phoneInput = document.createElement('input');
            phoneInput.type = 'file';
            phoneInput.accept = mediaTypes.includes('image') && mediaTypes.length == 1 ? 'image/*' : mediaTypes.map(t => `${t}/*`).join(',');
            phoneInput.style.display = 'none';
            content.appendChild(phoneInput);
            let phoneBtn = mUI.el('button', 'm-imgbrowser-tool', 'From phone');
            phoneBtn.addEventListener('click', () => phoneInput.click());
            toolbar.appendChild(phoneBtn);
        }
        content.appendChild(toolbar);
        let grid = mUI.el('div', 'm-imgbrowser-grid');
        content.appendChild(grid);
        let status = mUI.el('div', 'm-imgbrowser-status', 'Loading...');
        content.appendChild(status);
        let close = null;
        let pick = (entry) => {
            if (onPick) {
                onPick(entry);
            }
            if (close) {
                close();
            }
        };
        if (phoneInput) {
            phoneInput.addEventListener('change', () => {
                let file = phoneInput.files[0];
                if (!file) {
                    return;
                }
                let reader = new FileReader();
                reader.onload = () => pick({ 'kind': 'data', 'value': reader.result });
                reader.readAsDataURL(file);
                phoneInput.value = '';
            });
        }
        let renderRoots = () => {
            rootsRow.innerHTML = '';
            for (let root of roots) {
                let chip = mUI.el('button', 'm-folder-chip', root.label);
                if (this.rootPath == root.path || (this.path == root.path)) {
                    chip.classList.add('m-selected');
                }
                chip.addEventListener('click', () => {
                    this.path = root.path;
                    this.rootPath = root.path;
                    refresh();
                });
                rootsRow.appendChild(chip);
            }
        };
        let renderFolders = (folders) => {
            folderChips.innerHTML = '';
            folders = [...folders].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            if (this.path != '') {
                let up = mUI.el('button', 'm-folder-chip m-folder-up', '\u2190');
                up.addEventListener('click', () => {
                    this.path = this.path.includes('/') ? this.path.substring(0, this.path.lastIndexOf('/')) : '';
                    // Keep the highlighted root as the longest configured root that is still a prefix.
                    let match = roots.filter(r => r.path == this.path || (r.path && this.path.startsWith(`${r.path}/`)))
                        .sort((a, b) => b.path.length - a.path.length)[0];
                    this.rootPath = match ? match.path : '';
                    refresh();
                });
                folderChips.appendChild(up);
            }
            for (let folder of folders) {
                let chip = mUI.el('button', 'm-folder-chip', folder);
                chip.addEventListener('click', () => {
                    this.path = this.path == '' ? folder : `${this.path}/${folder}`;
                    refresh();
                });
                folderChips.appendChild(chip);
            }
        };
        let renderFiles = (files) => {
            grid.innerHTML = '';
            let prefix = this.path == '' ? '' : `${this.path}/`;
            let shown = 0;
            for (let f of files) {
                let fullsrc = `${prefix}${f.src}`;
                let type = typeof getMediaType == 'function' ? getMediaType(fullsrc) : 'image';
                if (!mediaTypes.includes(type)) {
                    continue;
                }
                let url = `${getImageOutPrefix()}/${fullsrc}`;
                let tile = mUI.el('button', 'm-imgbrowser-tile');
                tile.type = 'button';
                let img = document.createElement('img');
                img.loading = 'lazy';
                img.decoding = 'async';
                img.src = `${url}?preview=true`;
                img.alt = f.src;
                tile.appendChild(img);
                let name = mUI.el('div', 'm-imgbrowser-tile-name', f.src);
                tile.appendChild(name);
                tile.addEventListener('click', () => {
                    this.dismissKeyboard();
                    pick({ 'kind': 'path', 'value': fullsrc });
                });
                grid.appendChild(tile);
                shown++;
            }
            if (shown == 0) {
                status.textContent = files.length == 0 ? 'No files in this folder.' : 'No matching images in this folder.';
            }
            else {
                status.textContent = `${shown} image${shown == 1 ? '' : 's'}`;
            }
        };
        let refresh = () => {
            pathLabel.textContent = this.path || '(output root)';
            renderRoots();
            status.textContent = 'Loading...';
            grid.innerHTML = '';
            genericRequest('ListImages', { 'path': this.path, 'depth': 1, 'sortBy': 'Date', 'sortReverse': true }, data => {
                renderFolders(data.folders || []);
                renderFiles(data.files || []);
            }, 0, err => {
                status.textContent = `Could not list folder: ${err}`;
                mUI.warn(`Could not list folder: ${err}`);
            });
        };
        rootsBtn.addEventListener('click', () => {
            this.openRootsEditor(roots, (next) => {
                roots = next;
                this.saveRoots(roots);
                // If the current path vanished from the configured set, jump to the first root.
                if (!roots.some(r => r.path == this.rootPath || r.path == this.path || (r.path && this.path.startsWith(`${r.path}/`)))) {
                    this.path = roots[0] ? roots[0].path : '';
                    this.rootPath = this.path;
                }
                refresh();
            });
        });
        // Dismiss the keyboard when the user scrolls the file grid (same contract as the grid-axis LoRA search).
        let dismissKb = () => this.dismissKeyboard();
        grid.addEventListener('scroll', dismissKb, { passive: true });
        grid.addEventListener('touchmove', dismissKb, { passive: true });
        refresh();
        close = mUI.openSheet(content);
        return close;
    }

    /** Nested sheet for editing the configured folder roots (label + path under OutputPath). */
    openRootsEditor(currentRoots, onSave) {
        this.dismissKeyboard();
        let roots = currentRoots.map(r => ({ 'label': r.label, 'path': r.path }));
        let content = mUI.el('div', 'm-imgbrowser-roots-edit');
        content.appendChild(mUI.el('div', 'm-sheet-title', 'Folder roots'));
        content.appendChild(mUI.el('div', 'm-imgbrowser-hint',
            'Paths are relative to Swarm OutputPath (ListImages). Examples: inputs, Starred, MixStudio, raw/2026-09.'));
        let list = mUI.el('div', 'm-imgbrowser-roots-list');
        content.appendChild(list);
        let close = null;
        let render = () => {
            list.innerHTML = '';
            for (let i = 0; i < roots.length; i++) {
                let row = mUI.el('div', 'm-imgbrowser-root-row');
                let labelInput = document.createElement('input');
                labelInput.type = 'text';
                labelInput.className = 'm-imgbrowser-root-label';
                labelInput.placeholder = 'Label';
                labelInput.value = roots[i].label;
                labelInput.addEventListener('input', () => { roots[i].label = labelInput.value; });
                let pathInput = document.createElement('input');
                pathInput.type = 'text';
                pathInput.className = 'm-imgbrowser-root-path';
                pathInput.placeholder = 'path (empty = output root)';
                pathInput.value = roots[i].path;
                pathInput.addEventListener('input', () => {
                    roots[i].path = pathInput.value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                });
                let remove = mUI.el('button', 'm-imgbrowser-tool m-imgbrowser-root-remove', '\u00D7');
                remove.addEventListener('click', () => {
                    roots.splice(i, 1);
                    render();
                });
                row.appendChild(labelInput);
                row.appendChild(pathInput);
                row.appendChild(remove);
                list.appendChild(row);
            }
        };
        render();
        let addRow = mUI.el('div', 'm-imgbrowser-add-row');
        let addLabel = document.createElement('input');
        addLabel.type = 'text';
        addLabel.className = 'm-imgbrowser-root-label';
        addLabel.placeholder = 'New label';
        let addPath = document.createElement('input');
        addPath.type = 'text';
        addPath.className = 'm-imgbrowser-root-path';
        addPath.placeholder = 'New path';
        let addBtn = mUI.el('button', 'm-imgbrowser-tool', 'Add');
        addBtn.addEventListener('click', () => {
            let label = addLabel.value.trim() || addPath.value.trim() || 'Root';
            let path = addPath.value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            roots.push({ 'label': label, 'path': path });
            addLabel.value = '';
            addPath.value = '';
            render();
        });
        addRow.appendChild(addLabel);
        addRow.appendChild(addPath);
        addRow.appendChild(addBtn);
        content.appendChild(addRow);
        let suggest = mUI.el('div', 'm-imgbrowser-suggest');
        content.appendChild(suggest);
        genericRequest('ListImages', { 'path': '', 'depth': 1, 'sortBy': 'Name', 'sortReverse': false }, data => {
            let folders = [...(data.folders || [])].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            if (folders.length == 0) {
                return;
            }
            suggest.appendChild(mUI.el('div', 'm-imgbrowser-hint', 'Tap a top-level folder to add it:'));
            let chips = mUI.el('div', 'm-imgbrowser-roots');
            for (let folder of folders) {
                let chip = mUI.el('button', 'm-folder-chip', folder);
                chip.addEventListener('click', () => {
                    if (!roots.some(r => r.path == folder)) {
                        roots.push({ 'label': folder, 'path': folder });
                        render();
                    }
                });
                chips.appendChild(chip);
            }
            suggest.appendChild(chips);
        });
        let actions = mUI.el('div', 'm-edit-actions');
        let reset = mUI.el('button', 'm-edit-cancel-button', 'Reset defaults');
        reset.addEventListener('click', () => {
            roots = MImageBrowser.DefaultRoots.map(r => ({ 'label': r.label, 'path': r.path }));
            render();
        });
        let save = mUI.el('button', 'm-edit-save-button', 'Save');
        save.addEventListener('click', () => {
            let cleaned = roots
                .map(r => ({ 'label': `${r.label || r.path || 'Root'}`.trim() || 'Root', 'path': `${r.path || ''}`.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') }))
                .filter((r, idx, arr) => arr.findIndex(x => x.path == r.path) == idx);
            if (cleaned.length == 0) {
                cleaned = MImageBrowser.DefaultRoots.map(r => ({ 'label': r.label, 'path': r.path }));
            }
            onSave(cleaned);
            if (close) {
                close();
            }
        });
        actions.appendChild(reset);
        actions.appendChild(save);
        content.appendChild(actions);
        close = mUI.openSheet(content);
    }
}

mImageBrowser = new MImageBrowser();
