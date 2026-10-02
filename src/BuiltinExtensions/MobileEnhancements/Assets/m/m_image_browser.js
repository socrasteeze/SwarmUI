/** MobileEnhancements standalone client - server-backed image folder browser for /simple.
 * Output lists Swarm output folders through ListImages and returns relative path entries. Drives, when the
 * user has browse_server_images, lists machine folders through ListSimpleImageFolder and returns image data.
 * Configurable roots only apply to Output. An optional phone picker remains available for device images. */
class MImageBrowser {

    static StorageKey = 'm_client_img_browser_roots';

    /** Default roots under the user OutputPath. Paths are ListImages-relative (empty = output root). */
    static DefaultRoots = [
        { 'label': 'Output', 'path': '' },
        { 'label': 'Inputs', 'path': 'inputs' },
        { 'label': 'Starred', 'path': 'Starred' },
        { 'label': 'MixStudio', 'path': 'MixStudio' }
    ];

    /** Folder name prefixes hidden from this browser (Comfy paste dumps, test scratch).
     * Matching is case-insensitive on the final path segment. Complements HiddenHistoryFolders. */
    static HiddenFolderRes = [
        /^_comfy/i,
        /^_charsheet/i,
        /^_restore_test/i
    ];

    constructor() {
        /** Current ListImages path under the output root. */
        this.path = '';
        /** Active root chip path (used to highlight the matching chip). */
        this.rootPath = '';
        /** Current simple-machine-browser path. This remains in memory, never in output-root storage. */
        this.machinePath = '';
        /** Last selected source in this browser instance. */
        this.source = 'output';
    }

    /** True when a folder segment should stay out of the /simple image browser. */
    isHiddenFolder(name) {
        let n = `${name || ''}`.replace(/\\/g, '/').split('/').pop();
        return MImageBrowser.HiddenFolderRes.some(re => re.test(n));
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
                    })).filter(r => !this.isHiddenFolder(r.path || r.label));
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
        let canBrowseMachine = typeof permissions != 'undefined' && permissions.hasPermission
            && permissions.hasPermission('browse_server_images');
        if (typeof opts.startPath == 'string') {
            this.path = opts.startPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            this.rootPath = this.path;
        }
        else if (!this.path && roots.length) {
            this.path = roots[0].path;
            this.rootPath = roots[0].path;
        }
        let content = mUI.el('div', 'm-imgbrowser');
        let titleRow = mUI.el('div', 'm-imgbrowser-title-row');
        titleRow.appendChild(mUI.el('div', 'm-sheet-title', title));
        let closeBtn = mUI.el('button', 'm-imgbrowser-close', '\u00D7');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close');
        titleRow.appendChild(closeBtn);
        content.appendChild(titleRow);
        let sourceRow = mUI.el('div', 'm-imgbrowser-sources');
        let outputBtn = mUI.el('button', 'm-imgbrowser-source', 'Output');
        outputBtn.type = 'button';
        sourceRow.appendChild(outputBtn);
        let drivesBtn = null;
        if (canBrowseMachine) {
            drivesBtn = mUI.el('button', 'm-imgbrowser-source', 'Drives');
            drivesBtn.type = 'button';
            sourceRow.appendChild(drivesBtn);
        }
        content.appendChild(sourceRow);
        let machineHint = mUI.el('div', 'm-imgbrowser-hint', 'Folders on the SwarmUI host.');
        content.appendChild(machineHint);
        let favorites = mUI.el('div', 'm-imgbrowser-favorites');
        let favoritesSelect = document.createElement('select');
        favoritesSelect.className = 'm-imgbrowser-favorites-select';
        favoritesSelect.setAttribute('aria-label', 'Favorites');
        favorites.appendChild(favoritesSelect);
        let rootsBtn = mUI.el('button', 'm-imgbrowser-tool', 'Edit');
        rootsBtn.type = 'button';
        favorites.appendChild(rootsBtn);
        content.appendChild(favorites);
        let navigation = mUI.el('div', 'm-imgbrowser-navigation');
        let pathLabel = mUI.el('div', 'm-imgbrowser-path', this.path || '(output root)');
        navigation.appendChild(pathLabel);
        let upBtn = mUI.el('button', 'm-imgbrowser-up', 'Up');
        upBtn.type = 'button';
        upBtn.disabled = true;
        navigation.appendChild(upBtn);
        let parentPath = null;
        let machinePathInput = document.createElement('input');
        machinePathInput.type = 'text';
        machinePathInput.className = 'm-imgbrowser-machine-path';
        machinePathInput.placeholder = 'Folder Path';
        machinePathInput.setAttribute('aria-label', 'Folder Path');
        let goBtn = mUI.el('button', 'm-imgbrowser-tool', 'Go');
        goBtn.type = 'button';
        navigation.appendChild(machinePathInput);
        navigation.appendChild(goBtn);
        let phoneInput = null;
        let phoneBtn = null;
        if (allowPhone) {
            phoneInput = document.createElement('input');
            phoneInput.type = 'file';
            phoneInput.accept = mediaTypes.includes('image') && mediaTypes.length == 1 ? 'image/*' : mediaTypes.map(t => `${t}/*`).join(',');
            phoneInput.style.display = 'none';
            content.appendChild(phoneInput);
            phoneBtn = mUI.el('button', 'm-imgbrowser-tool', 'From Phone');
            phoneBtn.addEventListener('click', () => phoneInput.click());
        }
        content.appendChild(navigation);
        let body = mUI.el('div', 'm-imgbrowser-body');
        let foldersPanel = mUI.el('div', 'm-imgbrowser-folders-panel');
        foldersPanel.appendChild(mUI.el('div', 'm-imgbrowser-panel-title', 'Folders'));
        let foldersList = mUI.el('div', 'm-imgbrowser-folders');
        foldersPanel.appendChild(foldersList);
        body.appendChild(foldersPanel);
        let imagesPanel = mUI.el('div', 'm-imgbrowser-images-panel');
        imagesPanel.appendChild(mUI.el('div', 'm-imgbrowser-panel-title', 'Images'));
        let grid = mUI.el('div', 'm-imgbrowser-grid');
        imagesPanel.appendChild(grid);
        body.appendChild(imagesPanel);
        content.appendChild(body);
        let footer = mUI.el('div', 'm-imgbrowser-footer');
        let status = mUI.el('div', 'm-imgbrowser-status', 'Loading...');
        footer.appendChild(status);
        if (phoneBtn) {
            footer.appendChild(phoneBtn);
        }
        content.appendChild(footer);
        let close = null;
        let closed = false;
        let requestVersion = 0;
        let selectionVersion = 0;
        let selectionInFlight = false;
        let previewQueue = [];
        let previewsInFlight = 0;
        let observer = typeof IntersectionObserver == 'undefined' ? null : new IntersectionObserver(entries => {
            for (let entry of entries) {
                if (entry.isIntersecting) {
                    observer.unobserve(entry.target);
                    previewQueue.push(entry.target);
                }
            }
            loadPreviews();
        }, { 'root': grid, 'rootMargin': '160px' });
        closeBtn.addEventListener('click', () => {
            closed = true;
            requestVersion++;
            selectionInFlight = false;
            selectionVersion++;
            if (observer) {
                observer.disconnect();
            }
            if (close) {
                close();
            }
        });
        let pick = (entry) => {
            if (closed || !content.isConnected) {
                return;
            }
            closed = true;
            requestVersion++;
            selectionInFlight = false;
            selectionVersion++;
            if (observer) {
                observer.disconnect();
            }
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
            favoritesSelect.innerHTML = '';
            for (let root of roots) {
                let option = document.createElement('option');
                option.value = root.path;
                option.textContent = root.label;
                if (this.rootPath == root.path || (this.path == root.path)) {
                    option.selected = true;
                }
                favoritesSelect.appendChild(option);
            }
        };
        let setSource = (source) => {
            this.source = source;
            let machine = source == 'machine';
            content.classList.toggle('m-imgbrowser-machine', machine);
            outputBtn.classList.toggle('m-selected', !machine);
            if (drivesBtn) {
                drivesBtn.classList.toggle('m-selected', machine);
            }
            favorites.hidden = machine;
            machinePathInput.hidden = !machine;
            goBtn.hidden = !machine;
            machineHint.hidden = !machine;
            if (machine) {
                machinePathInput.value = this.machinePath;
            }
        };
        upBtn.addEventListener('click', () => {
            if (upBtn.disabled) {
                return;
            }
            if (this.source == 'machine') {
                this.machinePath = parentPath;
            }
            else {
                this.path = this.path.includes('/') ? this.path.substring(0, this.path.lastIndexOf('/')) : '';
                let match = roots.filter(r => r.path == this.path || (r.path && this.path.startsWith(`${r.path}/`)))
                    .sort((a, b) => b.path.length - a.path.length)[0];
                this.rootPath = match ? match.path : '';
            }
            refresh();
        });
        let renderFolderRows = (folders, append) => {
            if (!append) {
                foldersList.innerHTML = '';
            }
            for (let folder of folders) {
                let row = mUI.el('button', 'm-imgbrowser-folder-row');
                row.type = 'button';
                row.appendChild(mUI.el('span', 'm-imgbrowser-folder-name', folder.name || folder));
                let chevron = mUI.el('span', 'm-imgbrowser-folder-chevron', '\u203A');
                chevron.setAttribute('aria-hidden', 'true');
                row.appendChild(chevron);
                row.addEventListener('click', () => {
                    if (this.source == 'machine') {
                        this.machinePath = folder.path;
                    }
                    else {
                        this.path = this.path == '' ? folder : `${this.path}/${folder}`;
                    }
                    refresh();
                });
                foldersList.appendChild(row);
            }
        };
        let renderFolders = (folders) => {
            folders = [...folders]
                .filter(f => !this.isHiddenFolder(f))
                .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            renderFolderRows(folders, false);
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
        let renderMachineFolders = (folders, parent, append) => {
            renderFolderRows(folders || [], append);
        };
        let loadPreviews = () => {
            while (previewsInFlight < 4 && previewQueue.length > 0) {
                let tile = previewQueue.shift();
                let version = Number(tile.dataset.version);
                let path = tile.dataset.path;
                if (closed || !content.isConnected || version != requestVersion || !path || tile.dataset.loading == 'true') {
                    continue;
                }
                tile.dataset.loading = 'true';
                previewsInFlight++;
                genericRequest('ReadSimpleImage', { 'path': path, 'preview': true }, data => {
                    previewsInFlight--;
                    if (!closed && content.isConnected && version == requestVersion && data && data.image) {
                        tile.querySelector('img').src = data.image;
                    }
                    loadPreviews();
                }, 0, () => {
                    previewsInFlight--;
                    loadPreviews();
                });
            }
        };
        let appendMachineFiles = (files, version) => {
            for (let file of files || []) {
                let tile = mUI.el('button', 'm-imgbrowser-tile');
                tile.type = 'button';
                tile.dataset.path = file.path;
                tile.dataset.version = version;
                let img = document.createElement('img');
                img.alt = file.name;
                tile.appendChild(img);
                tile.appendChild(mUI.el('div', 'm-imgbrowser-tile-name', file.name));
                tile.addEventListener('click', () => {
                    if (selectionInFlight || tile.disabled || closed || !content.isConnected || version != requestVersion) {
                        return;
                    }
                    this.dismissKeyboard();
                    let selection = ++selectionVersion;
                    selectionInFlight = true;
                    tile.disabled = true;
                    status.textContent = 'Loading image...';
                    genericRequest('ReadSimpleImage', { 'path': file.path, 'preview': false }, data => {
                        if (closed || !content.isConnected || selection != selectionVersion || version != requestVersion) {
                            return;
                        }
                        if (data && data.image) {
                            pick({ 'kind': 'data', 'value': data.image });
                            return;
                        }
                        selectionInFlight = false;
                        tile.disabled = false;
                        status.textContent = 'Could not load image. Try again.';
                    }, 0, () => {
                        if (!closed && content.isConnected && selection == selectionVersion && version == requestVersion) {
                            selectionInFlight = false;
                            tile.disabled = false;
                            status.textContent = 'Could not load image. Try again.';
                        }
                    });
                });
                grid.appendChild(tile);
                if (observer) {
                    observer.observe(tile);
                }
                else {
                    previewQueue.push(tile);
                }
            }
            loadPreviews();
        };
        let refresh = (offset = 0, append = false) => {
            let version = append ? requestVersion : ++requestVersion;
            if (!append) {
                selectionInFlight = false;
                selectionVersion++;
                previewQueue = [];
                if (observer) {
                    observer.disconnect();
                }
                grid.innerHTML = '';
                foldersList.innerHTML = '';
                parentPath = null;
                upBtn.disabled = true;
            }
            if (this.source == 'machine') {
                this.dismissKeyboard();
                machinePathInput.value = this.machinePath;
                pathLabel.textContent = this.machinePath || 'Drives';
                status.textContent = 'Loading...';
                let requestedPath = this.machinePath;
                genericRequest('ListSimpleImageFolder', { 'path': this.machinePath, 'offset': offset, 'limit': 100 }, data => {
                    if (closed || !content.isConnected || version != requestVersion) {
                        return;
                    }
                    this.machinePath = data.path || '';
                    if (machinePathInput.value == requestedPath) {
                        machinePathInput.value = this.machinePath;
                    }
                    pathLabel.textContent = this.machinePath || 'Drives';
                    parentPath = data.parent;
                    upBtn.disabled = parentPath === null || parentPath === undefined;
                    renderMachineFolders(data.folders, data.parent, append);
                    appendMachineFiles(data.files, version);
                    let oldMore = grid.querySelector('.m-imgbrowser-more');
                    if (oldMore) {
                        oldMore.remove();
                    }
                    if (data.next_offset !== null && data.next_offset !== undefined) {
                        let more = mUI.el('button', 'm-imgbrowser-more', 'Load More');
                        more.type = 'button';
                        more.addEventListener('click', () => {
                            more.disabled = true;
                            refresh(data.next_offset, true);
                        });
                        grid.appendChild(more);
                    }
                    let count = grid.querySelectorAll('.m-imgbrowser-tile').length;
                    status.textContent = count ? `${count} image${count == 1 ? '' : 's'}` : 'No images in this folder.';
                }, 0, err => {
                    if (!closed && content.isConnected && version == requestVersion) {
                        if (!append) {
                            grid.innerHTML = '';
                            foldersList.innerHTML = '';
                            parentPath = null;
                            upBtn.disabled = true;
                        }
                        let more = grid.querySelector('.m-imgbrowser-more');
                        if (more) {
                            more.remove();
                        }
                        status.textContent = `Could not list folder: ${err}`;
                    }
                });
                return;
            }
            pathLabel.textContent = this.path || '(output root)';
            parentPath = this.path == '' ? null : true;
            upBtn.disabled = parentPath === null;
            renderRoots();
            status.textContent = 'Loading...';
            grid.innerHTML = '';
            genericRequest('ListImages', { 'path': this.path, 'depth': 1, 'sortBy': 'Date', 'sortReverse': true }, data => {
                if (closed || !content.isConnected || version != requestVersion) {
                    return;
                }
                renderFolders(data.folders || []);
                renderFiles(data.files || []);
            }, 0, err => {
                if (closed || !content.isConnected || version != requestVersion) {
                    return;
                }
                status.textContent = `Could not list folder: ${err}`;
                mUI.warn(`Could not list folder: ${err}`);
            });
        };
        outputBtn.addEventListener('click', () => {
            setSource('output');
            refresh();
        });
        if (drivesBtn) {
            drivesBtn.addEventListener('click', () => {
                setSource('machine');
                refresh();
            });
        }
        let goMachine = () => {
            let next = machinePathInput.value.trim();
            if (!next) {
                status.textContent = 'Enter a folder path.';
                return;
            }
            this.machinePath = next;
            refresh();
        };
        goBtn.addEventListener('click', goMachine);
        machinePathInput.addEventListener('keydown', e => {
            if (e.key == 'Enter') {
                e.preventDefault();
                goMachine();
            }
        });
        favoritesSelect.addEventListener('change', () => {
            this.path = favoritesSelect.value;
            this.rootPath = this.path;
            refresh();
        });
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
        close = mUI.openSheet(content, () => {
            closed = true;
            requestVersion++;
            selectionInFlight = false;
            selectionVersion++;
            previewQueue = [];
            if (observer) {
                observer.disconnect();
            }
        });
        setSource(canBrowseMachine && this.source == 'machine' ? 'machine' : 'output');
        refresh();
        return close;
    }

    /** Nested sheet for editing the configured folder roots (label + path under OutputPath). */
    openRootsEditor(currentRoots, onSave) {
        this.dismissKeyboard();
        let roots = currentRoots.map(r => ({ 'label': r.label, 'path': r.path }));
        let content = mUI.el('div', 'm-imgbrowser-roots-edit');
        let titleRow = mUI.el('div', 'm-imgbrowser-title-row');
        titleRow.appendChild(mUI.el('div', 'm-sheet-title', 'Output Favorites'));
        let closeBtn = mUI.el('button', 'm-imgbrowser-close', '\u00D7');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close');
        titleRow.appendChild(closeBtn);
        content.appendChild(titleRow);
        content.appendChild(mUI.el('div', 'm-imgbrowser-hint',
            'Use paths relative to Output. Select Drives in the browser for other drives.'));
        let list = mUI.el('div', 'm-imgbrowser-roots-list');
        content.appendChild(list);
        let close = null;
        let dismiss = () => {
            if (close) {
                close();
            }
        };
        closeBtn.addEventListener('click', dismiss);
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
            let folders = [...(data.folders || [])]
                .filter(f => !this.isHiddenFolder(f))
                .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
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
        let cancel = mUI.el('button', 'm-edit-cancel-button', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', dismiss);
        let reset = mUI.el('button', 'm-edit-cancel-button', 'Reset defaults');
        reset.type = 'button';
        reset.addEventListener('click', () => {
            roots = MImageBrowser.DefaultRoots.map(r => ({ 'label': r.label, 'path': r.path }));
            render();
        });
        let save = mUI.el('button', 'm-edit-save-button', 'Save');
        save.type = 'button';
        save.addEventListener('click', () => {
            let cleaned = roots
                .map(r => ({ 'label': `${r.label || r.path || 'Root'}`.trim() || 'Root', 'path': `${r.path || ''}`.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') }))
                .filter(r => !this.isHiddenFolder(r.path || r.label))
                .filter((r, idx, arr) => arr.findIndex(x => x.path == r.path) == idx);
            if (cleaned.length == 0) {
                cleaned = MImageBrowser.DefaultRoots.map(r => ({ 'label': r.label, 'path': r.path }));
            }
            onSave(cleaned);
            dismiss();
        });
        actions.appendChild(cancel);
        actions.appendChild(reset);
        actions.appendChild(save);
        content.appendChild(actions);
        close = mUI.openSheet(content);
    }
}

mImageBrowser = new MImageBrowser();
