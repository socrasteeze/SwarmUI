/** TagDex - the Characters browse tab.
 *
 * Auto-wired: WebServer.cs discovers Tabs/GenerateBottom/*.html, injects the nav item and pane into the Generate
 * bottom bar, and registers the `view_extension_tab_characters` permission. No core edits.
 *
 * Uses the core GenPageBrowserClass as a library. Two non-obvious constraints that shape the code below:
 *  - The 'Cards' format is the only one that writes the descriptor's `description` as innerHTML into the card body,
 *    which is where the core-tag chips live. Thumbnail formats render a plain caption instead.
 *  - GenPageBrowserClass.update() caches on folder alone, so every search or facet change must go through
 *    lightRefresh() (which clears that cache) rather than update(), or results go stale within a folder.
 */
class TagDexTabClass {

    /** Card image for an entry with no generated reference yet. Shared by the card builder and the delete path, so
     * clearing a thumbnail lands on exactly the image a never-generated card shows. */
    static PlaceholderImage = 'imgs/model_placeholder.jpg';

    constructor() {
        /** The core browser instance, built on first tab open. */
        this.browser = null;
        /** Currently selected dataset ID. */
        this.source = 'danbooru_character';
        /** Current free-text search. */
        this.search = '';
        /** Current sort mode. */
        this.sort = 'relevance';
        /** Selected facet values, keyed by facet name. */
        this.facets = { copyright: '', hairColor: '', hairLength: '', eyeColor: '', gender: '' };
        /** Server-reported dataset list. */
        this.sources = null;
        /** Token to copyright reverse map, so folder names never depend on the substitution glyph. */
        this.folderToCopyright = {};
        /** Debounce handle for the search box. */
        this.searchTimer = null;
        /** How many rows the last query reported in total. */
        this.lastTotal = 0;
        /** How many rows to request. Grows via the Load More button. */
        this.pageSize = 100;
        /** In-flight download source IDs. */
        this.downloading = {};
        /** Live download row elements, keyed by source ID, so a running download's row survives a list rebuild. */
        this.downloadRows = {};
        /** Whether the dataset manage drawer is open. */
        this.manageOpen = false;
        /** Whether a reference-image generation is currently running. The server serializes these anyway; this just
         * keeps the UI from queueing a pile of them behind one click each. Shared with the batch sweep below, so a
         * single-card click and a running sweep can never overlap either. */
        this.generatingThumb = false;
        /** Whether the "Generate All Visible" sweep is currently running. */
        this.batchRunning = false;
        /** Set by the Cancel button. Checked before every step; a step already in flight always finishes, only the
         * next one is skipped - the server has no cancel route, and there is only one request in flight at a time
         * to cancel anyway. */
        this.batchCancelled = false;
    }

    /** Wires the tab. Called once at script load; all real work is deferred to first open. */
    init() {
        let navLink = document.getElementById('maintab_characters');
        if (!navLink) {
            return;
        }
        navLink.addEventListener('shown.bs.tab', () => this.onShown());
    }

    /** First open builds the browser; later opens just refresh. */
    onShown() {
        if (this.browser) {
            return;
        }
        this.buildControls();
        this.loadSources(() => {
            this.ensureBrowser();
        });
    }

    /** Fetches the dataset list and decides between the empty state and the browser.
     * `reloadFacets` false skips the facet round trip when the caller knows the active dataset's contents did not
     * change. A switch of the active dataset reloads them regardless of the flag - this method can change
     * this.source itself, which no caller can predict. */
    loadSources(callback = null, reloadFacets = true) {
        genericRequest('TagDexListSources', {}, data => {
            this.sources = data.sources;
            if (data.prefs) {
                tagDexCore.prefs = Object.assign(tagDexCore.prefs, data.prefs);
            }
            let present = [];
            for (let i = 0; i < this.sources.length; i++) {
                if (this.sources[i].present) {
                    present.push(this.sources[i]);
                }
            }
            let sourceSelect = getRequiredElementById('tagdex_source');
            sourceSelect.innerHTML = '';
            for (let i = 0; i < present.length; i++) {
                let option = document.createElement('option');
                option.value = present[i].id;
                option.innerText = present[i].label;
                sourceSelect.appendChild(option);
            }
            let hasData = present.length > 0;
            getRequiredElementById('tagdex_empty').style.display = hasData ? 'none' : 'block';
            getRequiredElementById('tagdex_browser_container').style.display = hasData ? '' : 'none';
            // Hide the per-dataset query controls one at a time rather than hiding the row they sit in: the row
            // also carries the Datasets button, which has to stay reachable when there is nothing to query yet.
            // Restore with '' and never a literal - the class spans a select (inline-block), a div (block), and
            // the facet row (flex).
            let dataControls = document.querySelectorAll('.tagdex-data-control');
            for (let i = 0; i < dataControls.length; i++) {
                dataControls[i].style.display = hasData ? '' : 'none';
            }
            this.buildDownloadList();
            if (!hasData) {
                this.setManageOpen(true);
                return;
            }
            let previousSource = this.source;
            if (!present.some(s => s.id == this.source)) {
                this.source = present[0].id;
            }
            sourceSelect.value = this.source;
            this.syncSortOptions();
            if (reloadFacets || previousSource != this.source) {
                this.loadFacets();
            }
            if (previousSource != this.source) {
                // A live browser is still showing the old dataset's results, and ensureBrowser() no-ops once one
                // exists, so the caller's callback cannot cover this.
                this.requery();
            }
            if (callback) {
                callback();
            }
        });
    }

    /** Renders the per-dataset rows in the manage drawer, and updates the toggle button's installed count. */
    buildDownloadList() {
        let container = getRequiredElementById('tagdex_download_list');
        container.innerHTML = '';
        if (!this.sources) {
            return;
        }
        let downloadable = 0;
        let installed = 0;
        // The toggle carries data-requiredpermission, but the drawer force-opens itself when there is no data at
        // all, so a user without the permission would still be shown buttons that can only fail with an opaque
        // websocket error. init() runs from sessionReadyCallbacks, so permissions have loaded and this cannot
        // fail open the way it would at page boot.
        let canManage = typeof permissions == 'undefined' || !permissions.hasPermission || permissions.hasPermission('tagdex_manage');
        for (let i = 0; i < this.sources.length; i++) {
            let source = this.sources[i];
            if (source.downloadable) {
                // Tallied here rather than in a separate pass so the badge can never disagree with the rows on
                // screen: absent local datasets are skipped below, so counting all of this.sources would overstate.
                downloadable++;
                if (source.present) {
                    installed++;
                }
            }
            if (this.downloading[source.id] && this.downloadRows[source.id]) {
                // startDownload's progress callback holds this row's own button and status nodes. Building a fresh
                // pair would leave the running download writing into a detached element, while the new button
                // looked live but silently no-opped on the this.downloading guard. innerHTML = '' orphans children
                // without destroying them or their listeners, so re-appending restores the row intact.
                container.appendChild(this.downloadRows[source.id]);
                continue;
            }
            if (!source.downloadable) {
                // Locally supplied datasets (the anima-styles export) have nothing to fetch. Listing them with a
                // dead Download button would read as broken.
                if (!source.present) {
                    continue;
                }
                let localRow = document.createElement('div');
                localRow.className = 'tagdex-download-row';
                let localLabel = document.createElement('span');
                localLabel.className = 'tagdex-download-label';
                localLabel.innerText = source.label;
                let localStatus = document.createElement('span');
                localStatus.className = 'tagdex-download-status';
                localStatus.innerText = `Supplied locally - ${source.rows.toLocaleString()} of ${source.total_rows.toLocaleString()} entries loaded`;
                localRow.appendChild(localLabel);
                if (canManage) {
                    this.addManageButtons(localRow, source);
                }
                localRow.appendChild(localStatus);
                container.appendChild(localRow);
                continue;
            }
            let row = document.createElement('div');
            row.className = 'tagdex-download-row';
            let label = document.createElement('span');
            label.className = 'tagdex-download-label';
            label.innerText = source.label;
            let status = document.createElement('span');
            status.className = 'tagdex-download-status';
            status.id = `tagdex_dl_status_${source.id}`;
            status.innerText = source.present ? `Installed - ${source.rows.toLocaleString()} of ${source.total_rows.toLocaleString()} rows loaded` : '';
            row.appendChild(label);
            if (canManage) {
                let button = document.createElement('button');
                button.className = 'basic-button tagdex-button';
                button.innerText = source.present ? 'Re-download' : 'Download';
                button.addEventListener('click', () => this.startDownload(source.id, button, status));
                row.appendChild(button);
                this.addManageButtons(row, source);
            }
            row.appendChild(status);
            container.appendChild(row);
            this.downloadRows[source.id] = row;
        }
        if (!canManage) {
            let note = document.createElement('div');
            note.className = 'tagdex-download-status';
            note.innerText = 'Downloading tag data needs the TagDex manage permission.';
            container.appendChild(note);
        }
        getRequiredElementById('tagdex_manage_count').innerText = downloadable > 0 ? `${installed}/${downloadable}` : '';
    }

    /** Adds the Reload and Unload buttons to one dataset row. Both routes are tagdex_manage-gated server-side, and
     * the drawer these live in only opens from a toggle carrying the same permission. */
    addManageButtons(row, source) {
        if (source.present) {
            let reload = document.createElement('button');
            reload.className = 'basic-button tagdex-button';
            reload.innerText = 'Reload';
            reload.title = 'Re-parse this dataset from disk, picking up an edited file.';
            reload.addEventListener('click', () => {
                reload.disabled = true;
                genericRequest('TagDexReloadSource', { source: source.id }, data => {
                    this.afterManageAction(source.id, true);
                }, 0, error => {
                    // A custom error handler replaces genericRequest's own showError path, so it owes the user a
                    // visible failure and a button that is usable again.
                    showError(error);
                    reload.disabled = false;
                });
            });
            row.appendChild(reload);
        }
        if (source.loaded) {
            let unload = document.createElement('button');
            unload.className = 'basic-button tagdex-button';
            unload.innerText = 'Unload';
            unload.title = 'Drop this dataset from memory. Searching it loads it again automatically.';
            unload.addEventListener('click', () => {
                unload.disabled = true;
                genericRequest('TagDexUnloadSource', { source: source.id }, data => {
                    this.afterManageAction(source.id, false);
                }, 0, error => {
                    showError(error);
                    unload.disabled = false;
                });
            });
            row.appendChild(unload);
        }
    }

    /** Refreshes the drawer after a reload or unload.
     * `dataChanged` separates the two cases, and the distinction is load-bearing. A reload re-parses a possibly
     * edited file, so both the typeahead's cached index and the on-screen results are stale. An unload changes
     * nothing on disk, so both are still accurate - and refreshing the results would be actively wrong, because
     * TagDexSearchEntries routes through EnsureLoaded and would pull the dataset straight back into memory,
     * freeing nothing. Unloading the active dataset is still safe for the same reason: the next query reloads it. */
    afterManageAction(sourceId, dataChanged) {
        let wasActive = sourceId == this.source;
        if (dataChanged) {
            tagDexCore.status = 'unloaded';
            tagDexCore.shards = [];
        }
        this.loadSources(() => {
            if (this.browser && wasActive && dataChanged) {
                this.browser.refresh();
            }
        }, wasActive && dataChanged);
    }

    /** Shows or hides the dataset manage drawer. */
    setManageOpen(open) {
        this.manageOpen = open;
        getRequiredElementById('tagdex_manage').style.display = open ? '' : 'none';
        getRequiredElementById('tagdex_manage_toggle').classList.toggle('tagdex-button-active', open);
    }

    /** Toggle-button handler. Opening re-checks the dataset list, so a CSV dropped into Data/TagDex/ by hand shows
     * up without a page reload. Deliberately not folded into setManageOpen: loadSources force-opens the drawer
     * whenever there is no data, so refreshing from inside the setter would recurse forever. */
    onManageToggle() {
        this.setManageOpen(!this.manageOpen);
        if (this.manageOpen) {
            this.loadSources(null, false);
        }
    }

    /** Runs the websocket download for one dataset, reporting progress inline. */
    startDownload(sourceId, button, status) {
        if (this.downloading[sourceId]) {
            return;
        }
        this.downloading[sourceId] = true;
        button.disabled = true;
        status.innerText = 'Starting...';
        makeWSRequest('TagDexDownloadSource', { source: sourceId }, data => {
            if (data.status == 'downloading') {
                let percent = Math.round((data.current_percent || 0) * 100);
                let mb = Math.round((data.downloaded || 0) / (1024 * 1024));
                let totalMb = Math.round((data.total || 0) / (1024 * 1024));
                status.innerText = `Downloading ${percent}% (${mb} / ${totalMb} MB)`;
            }
            else if (data.status == 'parsing') {
                status.innerText = 'Parsing...';
            }
            else if (data.success) {
                status.innerText = `Done - ${data.rows.toLocaleString()} of ${data.total_rows.toLocaleString()} rows loaded, ~${data.approx_mb} MB`;
                button.disabled = false;
                delete this.downloading[sourceId];
                // The index the typeahead already fetched is now stale.
                tagDexCore.status = 'unloaded';
                tagDexCore.shards = [];
                // Only the downloaded dataset changed server-side - TagDexDownloadSource unloads and reloads that
                // one ID alone - so the browser's view is stale only when it is showing that same dataset.
                // Rebuilding it unconditionally threw away the user's folder, scroll position and search, and
                // leaked a document mousemove/mouseup pair plus a layoutResets entry every time: browsers.js
                // registers those under `if (!this.hasGenerated)` on first build and never removes them.
                let wasActive = sourceId == this.source;
                this.loadSources(() => {
                    if (!this.browser) {
                        // Required, not defensive: on a fresh install loadSources returns early while there is no
                        // data, so the first download is the case that still has to construct the browser.
                        this.ensureBrowser();
                    }
                    else if (wasActive) {
                        // Full refresh, not lightRefresh: listEntries only sends withFolders at root, so a user
                        // inside a folder would otherwise keep a tree built from the pre-download data.
                        this.browser.refresh();
                    }
                }, wasActive);
            }
        }, 0, error => {
            status.innerText = `Failed: ${error}`;
            button.disabled = false;
            delete this.downloading[sourceId];
        });
    }

    /** Wires the control row. Safe to call more than once. */
    buildControls() {
        if (this.controlsBuilt) {
            return;
        }
        this.controlsBuilt = true;
        let searchBox = getRequiredElementById('tagdex_search');
        searchBox.addEventListener('input', () => {
            this.search = searchBox.value;
            if (this.searchTimer) {
                clearTimeout(this.searchTimer);
            }
            this.searchTimer = setTimeout(() => this.requery(), 180);
        });
        getRequiredElementById('tagdex_source').addEventListener('change', event => {
            this.source = event.target.value;
            this.facets.copyright = '';
            this.syncSortOptions();
            this.loadFacets();
            this.requery();
        });
        getRequiredElementById('tagdex_sort').addEventListener('change', event => {
            this.sort = event.target.value;
            this.requery();
        });
        getRequiredElementById('tagdex_refresh').addEventListener('click', () => this.requery());
        getRequiredElementById('tagdex_manage_toggle').addEventListener('click', () => this.onManageToggle());
        getRequiredElementById('tagdex_batch_generate').addEventListener('click', () => this.startBatchGenerate());
        getRequiredElementById('tagdex_batch_cancel').addEventListener('click', () => this.cancelBatchGenerate());
        // One delegated listener on the container, whose identity is stable across browser rebuilds (build() only
        // clears innerHTML). Avoids inline onclick, which would need escaping for names like "jeanne_d'arc".
        getRequiredElementById('tagdex_browser_container').addEventListener('click', event => {
            let chip = event.target.closest('.tagdex-chip');
            if (!chip) {
                return;
            }
            event.stopPropagation();
            event.preventDefault();
            this.insertTag(chip.dataset.tagdextag);
        });
    }

    /** Fetches and renders the facet dropdowns for the active dataset. */
    loadFacets() {
        genericRequest('TagDexGetFacets', { source: this.source, topCopyrights: 400 }, data => {
            if (!data.facets) {
                return;
            }
            let container = getRequiredElementById('tagdex_facets');
            container.innerHTML = '';
            this.folderToCopyright = {};
            let copyrightOptions = [{ value: '', label: 'Any series' }];
            for (let i = 0; i < data.facets.copyright.length; i++) {
                let entry = data.facets.copyright[i];
                this.folderToCopyright[entry.token] = entry.name;
                copyrightOptions.push({ value: entry.name, label: `${entry.name.replaceAll('_', ' ')} (${entry.count})` });
            }
            let hasTraits = data.facets.hair_color && data.facets.hair_color.length > 0;
            container.appendChild(this.buildSelect('copyright', copyrightOptions));
            if (hasTraits && this.sourceKind() == 'character') {
                container.appendChild(this.buildSelect('gender', this.optionsFrom(data.facets.gender, 'Any gender')));
                container.appendChild(this.buildSelect('hairColor', this.optionsFrom(data.facets.hair_color, 'Any hair color')));
                container.appendChild(this.buildSelect('hairLength', this.optionsFrom(data.facets.hair_length, 'Any hair length')));
                container.appendChild(this.buildSelect('eyeColor', this.optionsFrom(data.facets.eye_color, 'Any eye color')));
            }
        });
    }

    /** Shows the uniqueness/quality sort modes only for datasets that actually carry those scores, and falls back
     * to relevance if the active sort just disappeared. */
    syncSortOptions() {
        let scored = false;
        if (this.sources) {
            for (let i = 0; i < this.sources.length; i++) {
                if (this.sources[i].id == this.source) {
                    scored = this.sources[i].scored == true;
                }
            }
        }
        let sortSelect = getRequiredElementById('tagdex_sort');
        let options = sortSelect.querySelectorAll('.tagdex-scored-sort');
        for (let i = 0; i < options.length; i++) {
            options[i].style.display = scored ? '' : 'none';
        }
        if (!scored && (this.sort == 'uniqueness' || this.sort == 'avg_score')) {
            this.sort = 'relevance';
        }
        sortSelect.value = this.sort;
    }

    /** The kind ('character' or 'artist') of the active dataset. */
    sourceKind() {
        if (!this.sources) {
            return 'character';
        }
        for (let i = 0; i < this.sources.length; i++) {
            if (this.sources[i].id == this.source) {
                return this.sources[i].kind;
            }
        }
        return 'character';
    }

    /** Normalizes a facet vocabulary into select options. */
    optionsFrom(values, anyLabel) {
        let options = [{ value: '', label: anyLabel }];
        for (let i = 0; i < values.length; i++) {
            let entry = values[i];
            if (typeof entry == 'object') {
                options.push({ value: entry.value, label: entry.label });
            }
            else {
                options.push({ value: entry, label: entry });
            }
        }
        return options;
    }

    /** Builds one facet select bound to a key of this.facets. */
    buildSelect(key, options) {
        let select = document.createElement('select');
        select.className = 'tagdex-select auto-dropdown';
        for (let i = 0; i < options.length; i++) {
            let option = document.createElement('option');
            option.value = options[i].value;
            option.innerText = options[i].label;
            select.appendChild(option);
        }
        select.value = this.facets[key] || '';
        select.addEventListener('change', event => {
            this.facets[key] = event.target.value;
            this.requery();
        });
        return select;
    }

    /** Constructs the browser on first use. */
    ensureBrowser() {
        if (this.browser) {
            return;
        }
        this.browser = new GenPageBrowserClass('tagdex_browser_container', this.listEntries.bind(this), 'tagdex',
            'Cards', this.describe.bind(this), this.selectEntry.bind(this), '', 1);
        this.browser.showDepth = false;
        // The built-in filter only filters the loaded page, while ours queries the whole dataset. Two search boxes
        // with different scopes is a trap, so only ours is shown.
        this.browser.showFilter = false;
        this.browser.folderTreeShowFiles = false;
        this.browser.maxPreBuild = 200;
        this.browser.navigate('');
    }

    /** Re-runs the current query. Always lightRefresh, never update - see the class comment. */
    requery() {
        if (!this.browser) {
            return;
        }
        this.browser.lightRefresh();
    }

    /** GenPageBrowserClass listFoldersAndFiles contract. */
    listEntries(path, isRefresh, callback, depth) {
        let copyright = this.facets.copyright;
        if (path) {
            // The browser hands folder paths with a trailing slash, and nests by '/' segment - see
            // buildTreeElements in browsers.js, which builds each child as `${path}${name}/`. Our folders are one
            // flat level of copyright tokens, and a token never contains a real slash (ToFolderToken swaps it for
            // U+2215), so the last non-empty segment is the token. Without this strip the raw 'pokemon/' reaches
            // the server, matches no copyright, and every folder reads as empty.
            let token = path.replace(/\/+$/, '').split('/').pop();
            copyright = this.folderToCopyright[token] || token;
        }
        genericRequest('TagDexSearchEntries', {
            source: this.source,
            search: this.search,
            copyright: copyright,
            hairColor: this.facets.hairColor,
            hairLength: this.facets.hairLength,
            eyeColor: this.facets.eyeColor,
            gender: this.facets.gender,
            sortBy: this.sort,
            offset: 0,
            limit: this.pageSize,
            withFolders: !path
        }, data => {
            if (data.missing_data) {
                callback([], []);
                this.setStatus('No data downloaded for this dataset yet.');
                return;
            }
            this.lastTotal = data.total;
            let folders = [];
            if (data.copyrights) {
                for (let i = 0; i < data.copyrights.length && i < 400; i++) {
                    this.folderToCopyright[data.copyrights[i].token] = data.copyrights[i].name;
                    folders.push(data.copyrights[i].token);
                }
            }
            let files = [];
            for (let i = 0; i < data.results.length; i++) {
                let record = data.results[i];
                record.src = record.thumb || '';
                files.push({ name: record.name, data: record });
            }
            this.setStatus(this.statusText(data.results.length, data.total, data.took_ms));
            callback(folders, files);
        }, 0, error => {
            this.setStatus(`Search failed: ${error}`);
            callback([], []);
        });
    }

    /** Builds the result-count line. A silent cap looks exactly like missing data, so the cap is always stated. */
    statusText(shown, total, tookMs) {
        if (total == 0) {
            return 'No matches.';
        }
        if (shown < total) {
            return `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} matches (${tookMs} ms) - refine your search, or load more.`;
        }
        return `${total.toLocaleString()} match${total == 1 ? '' : 'es'} (${tookMs} ms).`;
    }

    /** Writes the status line, appending a Load More button when the result set is capped. */
    setStatus(text) {
        let status = getRequiredElementById('tagdex_status');
        status.innerHTML = '';
        let span = document.createElement('span');
        span.innerText = text;
        status.appendChild(span);
        if (this.lastTotal > this.pageSize) {
            let more = document.createElement('button');
            more.className = 'basic-button tagdex-button tagdex-more';
            more.innerText = 'Load more';
            more.addEventListener('click', () => {
                this.pageSize = Math.min(this.pageSize + 150, 250);
                this.requery();
            });
            status.appendChild(more);
        }
    }

    /** GenPageBrowserClass describe contract. */
    describe(file) {
        let record = file.data;
        let primary = escapeHtmlNoBr(record.display || record.name);
        let html = `<span class="tagdex-card-name tag-text tag-type-${record.kind == 'artist' ? 1 : 4}">${primary}</span>`;
        if (record.copyright_display) {
            html += `<span class="tagdex-card-sub">${escapeHtmlNoBr(record.copyright_display)}</span>`;
        }
        html += `<span class="tagdex-card-count">${largeCountStringify(record.count)} posts`;
        if (record.solo_count > 0) {
            html += ` &middot; ${largeCountStringify(record.solo_count)} solo`;
        }
        html += '</span>';
        if (record.uniqueness || record.avg_score) {
            html += '<span class="tagdex-card-count">';
            if (record.uniqueness) {
                html += `distinctiveness ${record.uniqueness}`;
            }
            if (record.uniqueness && record.avg_score) {
                html += ' &middot; ';
            }
            if (record.avg_score) {
                html += `quality ${record.avg_score}`;
            }
            html += '</span>';
        }
        if (record.core_tags && record.core_tags.length > 0) {
            html += '<span class="tagdex-chips">';
            for (let i = 0; i < record.core_tags.length; i++) {
                let tag = record.core_tags[i];
                html += `<button type="button" class="tagdex-chip" data-tagdextag="${escapeHtmlNoBr(tag)}">${escapeHtmlNoBr(tag)}</button>`;
            }
            html += '</span>';
        }
        let buttons = [
            { label: 'Insert trigger', onclick: () => this.insertTag(record.trigger) },
            { label: 'Insert trigger + all core tags', onclick: () => this.insertTag([record.trigger].concat(record.core_tags || []).join(', ')) },
            { label: 'Insert as <character:> tag', onclick: () => this.insertTag(`<character:${record.name}>`) },
            { label: record.thumb ? 'Regenerate reference image' : 'Generate reference image', onclick: (div) => this.generateThumb(record, div) },
            { label: 'Use current image as reference', onclick: (div) => this.setThumbFromCurrentImage(record, div) }
        ];
        // Only offered when there is something to delete - a card still showing the placeholder has no file behind it.
        if (record.thumb) {
            buttons.push({ label: 'Delete reference image', onclick: (div) => this.deleteThumb(record, div) });
        }
        buttons.push({ label: 'Open on booru', href: record.url, is_download: false });
        return {
            name: record.trigger,
            display: record.display || record.name,
            description: html,
            image: record.thumb || TagDexTabClass.PlaceholderImage,
            className: 'tagdex-card',
            searchable: `${record.name} ${record.copyright || ''} ${(record.core_tags || []).join(' ')}`,
            buttons: buttons
        };
    }

    /** GenPageBrowserClass select contract - a card click inserts the trigger only. */
    selectEntry(file, div) {
        this.insertTag(file.data.trigger);
    }

    /** Generates a reference image for one entry using the user's current model and settings.
     * Deliberately sends the live Generate-tab parameters: the whole point of generating locally rather than
     * shipping stock references is that the preview shows what THIS checkpoint does with the tag, which doubles as
     * the answer to "does my model even know this character". */
    generateThumb(record, div) {
        if (this.generatingThumb) {
            this.setStatus('A reference image is already generating - they run one at a time.');
            return;
        }
        this.generatingThumb = true;
        this.setStatus(`Generating reference for ${record.display || record.name}...`);
        let input = getGenInput();
        makeWSRequest('TagDexGenerateThumbnail', { source: this.source, name: record.name, rawInput: input }, data => {
            if (data.status == 'queued') {
                this.setStatus(`Queued (${data.queue_depth} waiting)...`);
            }
            else if (data.gen_progress && data.gen_progress.overall_percent != null) {
                this.setStatus(`Generating ${record.display || record.name}: ${Math.round(data.gen_progress.overall_percent * 100)}%`);
            }
            else if (data.success) {
                this.generatingThumb = false;
                this.setStatus(`Reference image saved for ${record.display || record.name}.`);
                this.repaintCardThumb(div, data.thumb);
            }
        }, 0, error => {
            this.generatingThumb = false;
            this.setStatus(`Reference generation failed: ${error}`);
        });
    }

    /** Finds every currently-rendered card that still shows the placeholder image, for the batch sweep below.
     * Cards render lazily - an unrevealed `<img>` never gets a real `src` attribute, only `dataset.src` (see
     * `browsers.js` `makeVisible`), while a card repainted by `repaintCardThumb` gets a real `src` regardless of
     * whether it has been revealed yet. Checking the attribute first and falling back to the dataset value covers
     * both states correctly; checking `img.src` directly would not, since an `<img>` with no `src` attribute
     * reports the page's own URL rather than an empty string. */
    collectPlaceholderCards() {
        let container = document.getElementById('tagdex_browser_container');
        if (!container) {
            return [];
        }
        let cards = [];
        for (let block of container.querySelectorAll('.model-block')) {
            let name = block.dataset.name;
            if (!name) {
                continue;
            }
            let img = block.querySelector('img');
            let src = (img && (img.getAttribute('src') || img.dataset.src)) || '';
            if (src.includes(TagDexTabClass.PlaceholderImage)) {
                let nameEl = block.querySelector('.tagdex-card-name');
                cards.push({ div: block, name: name, display: nameEl ? nameEl.innerText : name });
            }
        }
        return cards;
    }

    /** "Generate All Visible" button handler. Queues every placeholder card currently on screen and runs them
     * sequentially - see `runBatchStep` for why sequential is required, not just preferred. */
    startBatchGenerate() {
        if (this.batchRunning) {
            return;
        }
        if (this.generatingThumb) {
            this.setBatchStatus('A reference image is already generating - wait for it to finish before starting a batch sweep.');
            return;
        }
        let cards = this.collectPlaceholderCards();
        if (cards.length == 0) {
            this.setBatchStatus('Nothing to generate - every visible card already has a reference image.');
            return;
        }
        this.batchRunning = true;
        this.batchCancelled = false;
        getRequiredElementById('tagdex_batch_generate').disabled = true;
        getRequiredElementById('tagdex_batch_cancel').style.display = '';
        this.runBatchStep(cards, 0);
    }

    /** Runs one card of the batch sweep, then recurses onto the next. Deliberately sequential and never
     * `Promise.all`-style fanned out: `TagDexThumbs.cs` guards generation with a single-slot `SemaphoreSlim`, so
     * concurrent requests would only queue up behind it server-side while consuming a websocket connection each for
     * no gain - and it is what lets Cancel take effect after the in-flight request alone, rather than an unknown
     * pile of already-sent ones. */
    runBatchStep(cards, index) {
        let total = cards.length;
        if (this.batchCancelled || index >= total) {
            this.finishBatch(this.batchCancelled ? `Cancelled after ${index} of ${total}.` : `Done - generated ${total} of ${total}.`);
            return;
        }
        let { div, name, display } = cards[index];
        this.generatingThumb = true;
        this.setBatchStatus(`Generating ${index + 1} of ${total}: ${display}...`);
        let input = getGenInput();
        makeWSRequest('TagDexGenerateThumbnail', { source: this.source, name: name, rawInput: input }, data => {
            if (data.status == 'queued') {
                this.setBatchStatus(`Generating ${index + 1} of ${total}: ${display} (queued, ${data.queue_depth} waiting)...`);
            }
            else if (data.gen_progress && data.gen_progress.overall_percent != null) {
                this.setBatchStatus(`Generating ${index + 1} of ${total}: ${display} (${Math.round(data.gen_progress.overall_percent * 100)}%)`);
            }
            else if (data.success) {
                this.generatingThumb = false;
                this.repaintCardThumb(div, data.thumb);
                this.runBatchStep(cards, index + 1);
            }
        }, 0, error => {
            this.generatingThumb = false;
            this.setBatchStatus(`Generating ${index + 1} of ${total}: ${display} failed (${error}) - continuing...`);
            this.runBatchStep(cards, index + 1);
        });
    }

    /** Cancel button handler. The step already in flight always finishes and repaints its card - only the next one
     * is skipped, per the `batchCancelled` field comment. */
    cancelBatchGenerate() {
        if (!this.batchRunning || this.batchCancelled) {
            return;
        }
        this.batchCancelled = true;
        getRequiredElementById('tagdex_batch_cancel').disabled = true;
    }

    /** Resets the batch controls once a sweep stops, whether it finished, failed out, or was cancelled. */
    finishBatch(message) {
        this.batchRunning = false;
        this.batchCancelled = false;
        getRequiredElementById('tagdex_batch_generate').disabled = false;
        let cancelButton = getRequiredElementById('tagdex_batch_cancel');
        cancelButton.style.display = 'none';
        cancelButton.disabled = false;
        this.setBatchStatus(message);
    }

    /** Writes the batch sweep's own progress line, separate from `setStatus` so a running sweep's progress and a
     * search's result count never overwrite each other. */
    setBatchStatus(text) {
        getRequiredElementById('tagdex_batch_status').innerText = text;
    }

    /** Sets one entry's reference image from whatever image is currently selected on the Generate tab.
     * Complements generateThumb: the image worth keeping is often one already made and then inpainted, upscaled, or
     * cherry-picked out of a batch, none of which regenerating from the tag alone would reproduce. */
    setThumbFromCurrentImage(record, div) {
        if (!currentImgSrc) {
            this.setStatus('No current image - generate or pick one on the Generate tab first.');
            return;
        }
        this.setStatus(`Saving current image as reference for ${record.display || record.name}...`);
        // resize256 matches what the model preview flow sends, keeping the upload small; the server still runs it
        // through the same JPEG helper the generate route uses.
        imageToData(currentImgSrc, dataURL => {
            if (!dataURL) {
                this.setStatus('Could not read the current image.');
                return;
            }
            genericRequest('TagDexSetThumbnail', { source: this.source, name: record.name, image: dataURL }, data => {
                this.setStatus(`Reference image saved for ${record.display || record.name}.`);
                this.repaintCardThumb(div, data.thumb);
            }, 0, error => {
                this.setStatus(`Could not save reference: ${error}`);
            });
        }, true);
    }

    /** Deletes one entry's reference image, reverting the card to the placeholder.
     * Confirms first, the same way the wildcard browser guards its delete: the file is cheap to regenerate, but the
     * button sits in a dense card grid where a misclick costs a gen to undo. */
    deleteThumb(record, div) {
        if (!confirm(`Delete the reference image for ${record.display || record.name}?`)) {
            return;
        }
        genericRequest('TagDexDeleteThumbnail', { source: this.source, name: record.name }, data => {
            record.thumb = null;
            this.setStatus(data.removed > 0
                ? `Reference image deleted for ${record.display || record.name}.`
                : `No reference image on disk for ${record.display || record.name}.`);
            this.repaintCardThumb(div, TagDexTabClass.PlaceholderImage);
        }, 0, error => {
            this.setStatus(`Could not delete reference: ${error}`);
        });
    }

    /** Repaints one card's image in place rather than refetching the whole page, falling back to a requery when the
     * card element cannot be found (eg the view changed under us). */
    repaintCardThumb(div, thumb) {
        let block = div ? div.closest('.model-block, .model-block-small, .model-block-big') : null;
        let target = block ? block.querySelector('img') : null;
        if (target) {
            // Generated thumbs reuse one URL per entry, so they need the cache buster; the static placeholder does
            // not, and busting it would refetch the same asset on every delete.
            target.src = thumb == TagDexTabClass.PlaceholderImage ? thumb : `${thumb}?t=${Date.now()}`;
            // The batch sweep reaches cards that have not scrolled into view yet, so the img can still be lazy:
            // `browsers.js` makeVisible would overwrite src from the stale dataset.src on the next scroll, silently
            // reverting the image we just wrote - and leaving the card looking un-generated to the next sweep,
            // which reads the same dataset.src. Mark it revealed exactly the way makeVisible does.
            target.classList.remove('lazyload');
            delete target.dataset.src;
        }
        else {
            this.requery();
        }
    }

    /** Appends a tag to the prompt, or removes it if already present as a comma-separated segment.
     * Modeled on wildcards.js selectWildcard. Note that uiImprover.getLastSelectedTextbox only reports a box touched
     * within the last second, so a click from this tab reliably takes the fallback branch and appends to the end of
     * the main prompt box - that is intended, not a caret insert. */
    insertTag(text) {
        if (!text) {
            return;
        }
        let [promptBox, cursorPos] = uiImprover.getLastSelectedTextbox();
        if (!promptBox) {
            promptBox = getRequiredElementById('alt_prompt_textbox');
            cursorPos = promptBox.value.length;
        }
        let current = promptBox.value;
        let segments = current.split(',').map(s => s.trim());
        let existing = segments.indexOf(text.trim());
        if (existing >= 0) {
            segments.splice(existing, 1);
            promptBox.value = segments.filter(s => s.length > 0).join(', ');
            triggerChangeFor(promptBox);
            return;
        }
        let prefix = current.substring(0, cursorPos);
        let suffix = current.substring(cursorPos);
        let joiner = trimSpaces(prefix).length == 0 || trimSpaces(prefix).endsWith(',') ? ' ' : ', ';
        promptBox.value = `${trimSpaces(prefix)}${trimSpaces(prefix).length == 0 ? '' : joiner}${text}${trimSpaces(suffix).length == 0 ? '' : ', ' + trimSpaces(suffix)}`;
        let caret = promptBox.value.length - trimSpaces(suffix).length;
        promptBox.selectionStart = caret;
        promptBox.selectionEnd = caret;
        promptBox.focus();
        triggerChangeFor(promptBox);
    }
}

tagDexTab = new TagDexTabClass();
if (typeof sessionReadyCallbacks != 'undefined') {
    sessionReadyCallbacks.push(() => tagDexTab.init());
}
