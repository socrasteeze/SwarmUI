/** MobileEnhancements standalone client - server-backed image folder browser for /simple.
 * Output lists Swarm output folders through ListImages and returns relative path entries. Drives, when the
 * user has browse_server_images, lists machine folders through ListSimpleImageFolder and returns image data.
 * Favorites hold Output-relative paths, or full host paths (D:\Pictures, \\server\share) that open in Drives.
 * An optional phone picker remains available for device images. */
class MImageBrowser {

    static StorageKey = 'm_client_img_browser_roots';

    /** Persisted picker sort choice shared by Output and Drives. */
    static SortStorageKey = 'm_client_img_browser_sort';

    /** Labels and their descending-base API sort parameters. */
    static SortModes = {
        'Newest First': ['Date', false],
        'Oldest First': ['Date', true],
        'Name A-Z': ['Name', true],
        'Name Z-A': ['Name', false]
    };

    /** Forty-eight images: sixteen mobile rows or twelve desktop rows. */
    static PageSize = 48;

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
        /** Image order shared by Output and Drives in this browser instance. */
        this.sortMode = 'Name A-Z';
        try {
            let stored = localStorage.getItem(MImageBrowser.SortStorageKey);
            if (MImageBrowser.SortModes[stored]) {
                this.sortMode = stored;
            }
        }
        catch (e) { /* storage may be unavailable */ }
        /** Page and scroll for each folder visited during this page load. A reload clears it. */
        this.sessionPlaces = {};
    }

    /** True when a folder segment should stay out of the /simple image browser. */
    isHiddenFolder(name) {
        let n = `${name || ''}`.replace(/\\/g, '/').split('/').pop();
        return MImageBrowser.HiddenFolderRes.some(re => re.test(n));
    }

    /** True for a full host path (drive letter or UNC share), which opens in Drives rather than Output. */
    isMachinePath(path) {
        return /^[A-Za-z]:([\\/]|$)/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
    }

    /** Normalizes one favorite. Output paths become slash-separated and relative; host paths keep their
     * own separators and lose only trailing ones (a bare drive keeps its root, so D: becomes D:\). */
    cleanRoot(r) {
        let raw = `${r.path || ''}`.trim();
        let label = `${r.label || ''}`.trim();
        if (this.isMachinePath(raw)) {
            let path = raw.replace(/[\\/]+$/, '');
            if (/^[A-Za-z]:$/.test(path)) {
                path += '\\';
            }
            return { 'label': label || path, 'path': path, 'machine': true };
        }
        let path = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        return { 'label': label || path || 'Root', 'path': path };
    }

    /** Duplicate-check key: host paths compare case-insensitively and separator-blind, Output paths exactly. */
    rootKey(r) {
        return r.machine ? `m:${r.path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()}` : `o:${r.path}`;
    }

    /** Loads configured roots from localStorage, falling back to DefaultRoots. */
    loadRoots() {
        try {
            let raw = localStorage.getItem(MImageBrowser.StorageKey);
            if (raw) {
                let parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed.map(r => this.cleanRoot(r)).filter(r => r.machine || !this.isHiddenFolder(r.path || r.label));
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
        let forcedPath = false;
        if (typeof opts.startPath == 'string') {
            this.path = opts.startPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            this.rootPath = this.path;
            forcedPath = true;
        }
        else if (!this.path) {
            let first = roots.find(r => !r.machine);
            this.path = first ? first.path : '';
            this.rootPath = this.path;
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
        let favorites = mUI.el('div', 'm-imgbrowser-favorites');
        let favoritesSelect = document.createElement('select');
        favoritesSelect.className = 'm-imgbrowser-favorites-select';
        favoritesSelect.setAttribute('aria-label', 'Favorites');
        favorites.appendChild(favoritesSelect);
        let saveRootBtn = mUI.el('button', 'm-imgbrowser-tool', 'Save');
        saveRootBtn.type = 'button';
        saveRootBtn.setAttribute('aria-label', 'Save Folder to Favorites');
        favorites.appendChild(saveRootBtn);
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
        let searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.className = 'm-imgbrowser-search';
        searchInput.placeholder = 'Search filenames';
        searchInput.setAttribute('aria-label', 'Search Filenames');
        searchInput.autocomplete = 'off';
        searchInput.spellcheck = false;
        let searchRow = mUI.el('div', 'm-imgbrowser-search-row');
        searchRow.appendChild(searchInput);
        let sortSelect = document.createElement('select');
        sortSelect.className = 'm-imgbrowser-sort';
        sortSelect.setAttribute('aria-label', 'Sort Images');
        for (let label in MImageBrowser.SortModes) {
            let option = document.createElement('option');
            option.value = label;
            option.textContent = label;
            sortSelect.appendChild(option);
        }
        sortSelect.value = this.sortMode;
        searchRow.appendChild(sortSelect);
        content.appendChild(searchRow);
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
        let footerInfo = mUI.el('div', 'm-imgbrowser-footer-info');
        let status = mUI.el('div', 'm-imgbrowser-status', 'Loading...');
        status.setAttribute('role', 'status');
        footerInfo.appendChild(status);
        if (phoneBtn) {
            footerInfo.appendChild(phoneBtn);
        }
        footer.appendChild(footerInfo);
        let pager = mUI.el('div', 'm-imgbrowser-pager');
        pager.setAttribute('aria-label', 'Image Pages');
        let previousBtn = mUI.el('button', 'm-imgbrowser-tool m-imgbrowser-prev', 'Prev');
        previousBtn.type = 'button';
        previousBtn.setAttribute('aria-label', 'Previous Page');
        previousBtn.disabled = true;
        let pageLabel = mUI.el('span', 'm-imgbrowser-page', '1 / 1');
        let nextBtn = mUI.el('button', 'm-imgbrowser-tool m-imgbrowser-next', 'Next');
        nextBtn.type = 'button';
        nextBtn.setAttribute('aria-label', 'Next Page');
        nextBtn.disabled = true;
        pager.appendChild(previousBtn);
        pager.appendChild(pageLabel);
        pager.appendChild(nextBtn);
        footer.appendChild(pager);
        content.appendChild(footer);
        let close = null;
        let closed = false;
        let requestVersion = 0;
        let selectionVersion = 0;
        let selectionInFlight = false;
        let previewQueue = [];
        let previewsInFlight = 0;
        let pageOffset = 0;
        let nextOffset = null;
        let searchTimer = null;
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
        let isCurrentMachine = (root) => root.machine && this.rootKey(root) == this.rootKey({ 'machine': true, 'path': this.machinePath });
        let renderRoots = () => {
            favoritesSelect.innerHTML = '';
            let machine = this.source == 'machine';
            let matched = false;
            for (let i = 0; i < roots.length; i++) {
                let root = roots[i];
                if (root.machine && !canBrowseMachine) {
                    continue;
                }
                let option = document.createElement('option');
                option.value = `${i}`;
                option.textContent = root.label;
                let isCurrent = machine ? isCurrentMachine(root) : !root.machine && (this.rootPath == root.path || this.path == root.path);
                if (isCurrent && !matched) {
                    option.selected = true;
                    matched = true;
                }
                favoritesSelect.appendChild(option);
            }
            if (!matched) {
                // Browsing somewhere that is not itself a favorite: say so instead of showing a wrong label.
                let option = document.createElement('option');
                option.value = '';
                option.textContent = 'Favorites';
                option.disabled = true;
                option.selected = true;
                favoritesSelect.insertBefore(option, favoritesSelect.firstChild);
            }
            saveRootBtn.hidden = !machine || !this.machinePath || roots.some(isCurrentMachine);
        };
        let setSource = (source) => {
            this.source = source;
            let machine = source == 'machine';
            content.classList.toggle('m-imgbrowser-machine', machine);
            outputBtn.classList.toggle('m-selected', !machine);
            if (drivesBtn) {
                drivesBtn.classList.toggle('m-selected', machine);
            }
            machinePathInput.hidden = !machine;
            goBtn.hidden = !machine;
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
                let match = roots.filter(r => !r.machine && (r.path == this.path || (r.path && this.path.startsWith(`${r.path}/`))))
                    .sort((a, b) => b.path.length - a.path.length)[0];
                this.rootPath = match ? match.path : '';
            }
            openCurrent();
        });
        let renderFolderRows = (folders) => {
            foldersList.innerHTML = '';
            for (let folder of folders) {
                let row = mUI.el('button', 'm-imgbrowser-folder-row');
                row.type = 'button';
                row.title = folder.name || folder;
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
                    openCurrent();
                });
                foldersList.appendChild(row);
            }
        };
        let renderFolders = (folders) => {
            folders = [...folders]
                .filter(f => !this.isHiddenFolder(f))
                .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            renderFolderRows(folders);
        };
        let renderFiles = (files, version) => {
            grid.innerHTML = '';
            let prefix = this.path == '' ? '' : `${this.path}/`;
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
                    if (closed || version != requestVersion) {
                        return;
                    }
                    this.dismissKeyboard();
                    pick({ 'kind': 'path', 'value': fullsrc });
                });
                grid.appendChild(tile);
            }
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
        /** Key for the folder currently on screen. Output and Drives do not share a page. */
        let placeKey = () => this.source == 'machine' ? `machine\n${this.machinePath}\n${this.sortMode}` : `output\n${this.path}\n${this.sortMode}`;
        let suppressRemember = false;
        /** Writes the current page and scroll. Skipped while a refresh is forcing the grid back to the top. */
        let remember = () => {
            if (suppressRemember) {
                return;
            }
            this.sessionPlaces[placeKey()] = {
                'offset': pageOffset,
                'scroll': grid.scrollTop,
                'folderScroll': foldersList.scrollTop
            };
        };
        /** Reopens the current folder on the page and scroll it had earlier in this page load. */
        let openCurrent = () => {
            let saved = this.sessionPlaces[placeKey()];
            refresh(saved ? saved.offset : 0, saved || null);
        };
        let refresh = (offset = 0, restore = null) => {
            clearTimeout(searchTimer);
            searchTimer = null;
            let version = ++requestVersion;
            pageOffset = offset;
            nextOffset = null;
            previousBtn.disabled = true;
            nextBtn.disabled = true;
            selectionInFlight = false;
            selectionVersion++;
            previewQueue = [];
            if (observer) {
                observer.disconnect();
            }
            grid.innerHTML = '';
            suppressRemember = true;
            grid.scrollTop = 0;
            suppressRemember = false;
            foldersList.innerHTML = '';
            parentPath = null;
            upBtn.disabled = true;
            status.textContent = 'Loading...';
            let search = searchInput.value.trim();
            let [sortBy, sortReverse] = MImageBrowser.SortModes[this.sortMode];
            let finishPage = data => {
                let total = Number(data.total) || 0;
                let lastOffset = Math.max(0, Math.ceil(total / MImageBrowser.PageSize) - 1) * MImageBrowser.PageSize;
                if (offset > lastOffset) {
                    refresh(lastOffset);
                    return;
                }
                nextOffset = data.next_offset ?? null;
                previousBtn.disabled = offset == 0;
                nextBtn.disabled = nextOffset == null;
                let page = Math.floor(offset / MImageBrowser.PageSize) + 1;
                let pages = Math.max(1, Math.ceil(total / MImageBrowser.PageSize));
                pageLabel.textContent = `${page} / ${pages}`;
                pageLabel.setAttribute('aria-label', `Page ${page} of ${pages}`);
                let shown = grid.querySelectorAll('.m-imgbrowser-tile').length;
                status.textContent = shown ? `${offset + 1}\u2013${offset + shown} of ${total}`
                    : (search ? 'No matching images.' : 'No images in this folder.');
                remember();
                if (!restore) {
                    return;
                }
                requestAnimationFrame(() => {
                    if (closed || !content.isConnected || version != requestVersion) {
                        return;
                    }
                    suppressRemember = true;
                    grid.scrollTop = restore.scroll || 0;
                    foldersList.scrollTop = restore.folderScroll || 0;
                    suppressRemember = false;
                    remember();
                });
            };
            let failPage = err => {
                if (closed || !content.isConnected || version != requestVersion) {
                    return;
                }
                previousBtn.disabled = offset == 0;
                status.textContent = `Could not list folder: ${err}`;
            };
            if (this.source == 'machine') {
                machinePathInput.value = this.machinePath;
                pathLabel.textContent = this.machinePath || 'Drives';
                renderRoots();
                let requestedPath = this.machinePath;
                genericRequest('ListSimpleImageFolder', {
                    'path': this.machinePath, 'offset': offset, 'limit': MImageBrowser.PageSize,
                    'search': search, 'image_page': true, 'sortBy': sortBy, 'sortReverse': sortReverse
                }, data => {
                    if (closed || !content.isConnected || version != requestVersion) {
                        return;
                    }
                    this.machinePath = data.path || '';
                    if (machinePathInput.value == requestedPath) {
                        machinePathInput.value = this.machinePath;
                    }
                    pathLabel.textContent = this.machinePath || 'Drives';
                    parentPath = data.parent;
                    upBtn.disabled = parentPath == null;
                    renderRoots();
                    renderFolderRows(data.folders || []);
                    appendMachineFiles(data.files, version);
                    finishPage(data);
                }, 0, failPage);
                return;
            }
            pathLabel.textContent = this.path || '(output root)';
            parentPath = this.path == '' ? null : true;
            upBtn.disabled = parentPath == null;
            renderRoots();
            genericRequest('ListImages', {
                'path': this.path, 'depth': 1, 'sortBy': sortBy, 'sortReverse': sortReverse,
                'offset': offset, 'limit': MImageBrowser.PageSize, 'search': search, 'media_types': mediaTypes
            }, data => {
                if (closed || !content.isConnected || version != requestVersion) {
                    return;
                }
                renderFolders(data.folders || []);
                renderFiles(data.files || [], version);
                finishPage(data);
            }, 0, failPage);
        };
        previousBtn.addEventListener('click', () => {
            this.dismissKeyboard();
            refresh(Math.max(0, pageOffset - MImageBrowser.PageSize));
        });
        nextBtn.addEventListener('click', () => {
            if (nextOffset != null) {
                this.dismissKeyboard();
                refresh(nextOffset);
            }
        });
        searchInput.addEventListener('input', () => {
            // Invalidate stale page and selection responses before the debounce expires.
            requestVersion++;
            previousBtn.disabled = true;
            nextBtn.disabled = true;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => refresh(), 250);
        });
        searchInput.addEventListener('keydown', e => {
            if (e.key == 'Enter') {
                e.preventDefault();
                this.dismissKeyboard();
                refresh();
            }
        });
        sortSelect.addEventListener('change', () => {
            remember();
            this.sortMode = sortSelect.value;
            try {
                localStorage.setItem(MImageBrowser.SortStorageKey, this.sortMode);
            }
            catch (e) { /* storage may be unavailable */ }
            requestVersion++;
            selectionVersion++;
            previousBtn.disabled = true;
            nextBtn.disabled = true;
            refresh(0);
        });
        outputBtn.addEventListener('click', () => {
            remember();
            setSource('output');
            openCurrent();
        });
        if (drivesBtn) {
            drivesBtn.addEventListener('click', () => {
                remember();
                setSource('machine');
                openCurrent();
            });
        }
        let goMachine = () => {
            let next = machinePathInput.value.trim();
            if (!next) {
                status.textContent = 'Enter a folder path.';
                return;
            }
            this.machinePath = next;
            openCurrent();
        };
        goBtn.addEventListener('click', goMachine);
        machinePathInput.addEventListener('keydown', e => {
            if (e.key == 'Enter') {
                e.preventDefault();
                goMachine();
            }
        });
        favoritesSelect.addEventListener('change', () => {
            let root = roots[Number(favoritesSelect.value)];
            if (!root) {
                return;
            }
            if (root.machine) {
                setSource('machine');
                this.machinePath = root.path;
            }
            else {
                setSource('output');
                this.path = root.path;
                this.rootPath = this.path;
            }
            openCurrent();
        });
        saveRootBtn.addEventListener('click', () => {
            if (!this.machinePath) {
                return;
            }
            let name = this.machinePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
            let root = this.cleanRoot({ 'label': name, 'path': this.machinePath });
            if (!roots.some(r => this.rootKey(r) == this.rootKey(root))) {
                roots = [...roots, root];
                this.saveRoots(roots);
            }
            renderRoots();
            status.textContent = `Saved ${root.label} to favorites.`;
        });
        rootsBtn.addEventListener('click', () => {
            this.openRootsEditor(roots, (next) => {
                roots = next;
                this.saveRoots(roots);
                // If the current path vanished from the configured set, jump to the first root.
                if (this.source != 'machine' && !roots.some(r => !r.machine && (r.path == this.rootPath || r.path == this.path || (r.path && this.path.startsWith(`${r.path}/`))))) {
                    let first = roots.find(r => !r.machine);
                    this.path = first ? first.path : '';
                    this.rootPath = this.path;
                }
                openCurrent();
            });
        });
        // Dismiss the keyboard when the user scrolls the file grid (same contract as the grid-axis LoRA search).
        let dismissKb = () => this.dismissKeyboard();
        grid.addEventListener('scroll', () => {
            dismissKb();
            remember();
        }, { passive: true });
        foldersList.addEventListener('scroll', () => remember(), { passive: true });
        grid.addEventListener('touchmove', dismissKb, { passive: true });
        close = mUI.openSheet(content, () => {
            remember();
            clearTimeout(searchTimer);
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
        if (forcedPath) {
            refresh(0);
        }
        else {
            openCurrent();
        }
        return close;
    }

    /** Nested sheet for editing the configured folder roots (label + path under OutputPath). */
    openRootsEditor(currentRoots, onSave) {
        this.dismissKeyboard();
        let roots = currentRoots.map(r => ({ ...r }));
        let content = mUI.el('div', 'm-imgbrowser-roots-edit');
        let titleRow = mUI.el('div', 'm-imgbrowser-title-row');
        titleRow.appendChild(mUI.el('div', 'm-sheet-title', 'Favorites'));
        let closeBtn = mUI.el('button', 'm-imgbrowser-close', '\u00D7');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close');
        titleRow.appendChild(closeBtn);
        content.appendChild(titleRow);
        content.appendChild(mUI.el('div', 'm-imgbrowser-hint',
            'Use a path inside Output, or a full path like D:\\Pictures for another drive.'));
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
                    roots[i].path = pathInput.value;
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
            roots.push(this.cleanRoot({ 'label': addLabel.value, 'path': addPath.value }));
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
                    if (!roots.some(r => !r.machine && r.path == folder)) {
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
                .map(r => this.cleanRoot(r))
                .filter(r => r.machine || !this.isHiddenFolder(r.path || r.label))
                .filter((r, idx, arr) => arr.findIndex(x => this.rootKey(x) == this.rootKey(r)) == idx);
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
