/** TagDex - the Characters browse tab.
 *
 * Auto-wired: WebServer.cs discovers Tabs/Text2Image/*.html, injects the nav item and pane, and registers the
 * `view_extension_tab_characters` permission. No core edits.
 *
 * Uses the core GenPageBrowserClass as a library. Two non-obvious constraints that shape the code below:
 *  - The 'Cards' format is the only one that writes the descriptor's `description` as innerHTML into the card body,
 *    which is where the core-tag chips live. Thumbnail formats render a plain caption instead.
 *  - GenPageBrowserClass.update() caches on folder alone, so every search or facet change must go through
 *    lightRefresh() (which clears that cache) rather than update(), or results go stale within a folder.
 */
class TagDexTabClass {

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
        /** Whether a reference-image generation is currently running. The server serializes these anyway; this just
         * keeps the UI from queueing a pile of them behind one click each. */
        this.generatingThumb = false;
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

    /** Fetches the dataset list and decides between the empty state and the browser. */
    loadSources(callback) {
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
            getRequiredElementById('tagdex_source').parentElement.style.display = hasData ? '' : 'none';
            this.buildDownloadList();
            if (!hasData) {
                return;
            }
            if (!present.some(s => s.id == this.source)) {
                this.source = present[0].id;
            }
            sourceSelect.value = this.source;
            this.syncSortOptions();
            this.loadFacets();
            if (callback) {
                callback();
            }
        });
    }

    /** Renders the per-dataset download rows in the empty state. */
    buildDownloadList() {
        let container = getRequiredElementById('tagdex_download_list');
        container.innerHTML = '';
        if (!this.sources) {
            return;
        }
        for (let i = 0; i < this.sources.length; i++) {
            let source = this.sources[i];
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
            let button = document.createElement('button');
            button.className = 'basic-button tagdex-button';
            button.innerText = source.present ? 'Re-download' : 'Download';
            button.addEventListener('click', () => this.startDownload(source.id, button, status));
            row.appendChild(label);
            row.appendChild(button);
            row.appendChild(status);
            container.appendChild(row);
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
                this.browser = null;
                this.loadSources(() => this.ensureBrowser());
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
            copyright = this.folderToCopyright[path] || path;
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
        return {
            name: record.trigger,
            display: record.display || record.name,
            description: html,
            image: record.thumb || 'imgs/model_placeholder.jpg',
            className: 'tagdex-card',
            searchable: `${record.name} ${record.copyright || ''} ${(record.core_tags || []).join(' ')}`,
            buttons: [
                { label: 'Insert trigger', onclick: () => this.insertTag(record.trigger) },
                { label: 'Insert trigger + all core tags', onclick: () => this.insertTag([record.trigger].concat(record.core_tags || []).join(', ')) },
                { label: 'Insert as <character:> tag', onclick: () => this.insertTag(`<character:${record.name}>`) },
                { label: record.thumb ? 'Regenerate reference image' : 'Generate reference image', onclick: (div) => this.generateThumb(record, div) },
                { label: 'Open on booru', href: record.url, is_download: false }
            ]
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
                // Repaint just this card's image rather than refetching the page.
                let img = div ? div.closest('.model-block, .model-block-small, .model-block-big') : null;
                let target = img ? img.querySelector('img') : null;
                if (target) {
                    target.src = `${data.thumb}?t=${Date.now()}`;
                }
                else {
                    this.requery();
                }
            }
        }, 0, error => {
            this.generatingThumb = false;
            this.setStatus(`Reference generation failed: ${error}`);
        });
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
