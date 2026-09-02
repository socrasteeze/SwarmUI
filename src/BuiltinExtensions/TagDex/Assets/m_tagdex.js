/** TagDex - /simple standalone client hook.
 *
 * The /simple client shares no code with the genpage: it has its own MAutoComplete (an inline chip strip rather
 * than a floating popover). This wraps that class the same way tagdex_prompt.js wraps the genpage's, and both
 * delegate the actual matching and merging to the one shared tagDexCore singleton.
 *
 * One behavioral difference matters. MAutoComplete.buildChip reads `val.clean || val.name` for the chip label and
 * ignores `clean_html`, while the genpage's onInput lets `clean` OVERWRITE `clean_html`. So exactly one of the two
 * can be set, and which one depends on the surface - hence the plainOnly flag threaded into tagDexCore.entryAt.
 *
 * Loaded explicitly by Assets/m/index.html. It is registered in OtherAssets rather than ScriptFiles, because
 * ScriptFiles would inject it into every Razor page, where MAutoComplete does not exist.
 */
class MTagDexClass {

    constructor() {
        /** Whether install() has already run. */
        this.installed = false;
        /** Whether the Create-panel browse button has already been mounted. */
        this.browseInstalled = false;
    }

    /** Wraps the /simple completer. No-ops anywhere MAutoComplete is absent. */
    install() {
        if (this.installed || typeof MAutoComplete == 'undefined' || typeof tagDexCore == 'undefined') {
            return;
        }
        if (typeof MAutoComplete.prototype.getPossibleList != 'function') {
            console.log('[TagDex] MAutoComplete.getPossibleList is missing - typeahead disabled on /simple.');
            return;
        }
        this.installed = true;
        let original = MAutoComplete.prototype.getPossibleList;
        // Function, not arrow: `this` must stay the MAutoComplete instance.
        MAutoComplete.prototype.getPossibleList = function (box) {
            let base = original.call(this, box);
            try {
                return tagDexCore.augment(this, box, base, true);
            }
            catch (e) {
                console.log(`[TagDex] Suggestion merge failed on /simple: ${e}`);
                return base;
            }
        };
        // Load the index on first prompt focus rather than at boot, so a phone that never uses the feature pays no
        // request and no memory. This is also why no edit to m_app.js's boot sequence is needed.
        let originalEnable = MAutoComplete.prototype.enableFor;
        if (typeof originalEnable == 'function') {
            MAutoComplete.prototype.enableFor = function (box, paramId) {
                originalEnable.call(this, box, paramId);
                box.addEventListener('focus', () => tagDexCore.ensureLoaded(), { once: true });
            };
        }
        this.registerPrefix();
    }

    /** Registers `<character:name>` on the /simple completer.
     * As on the genpage, the returned objects carry no `tag` key, so buildChip leaves the splice anchor at the `<`
     * and the whole tag is replaced rather than leaving a dangling `<character:`. */
    registerPrefix() {
        if (typeof mAutoComplete == 'undefined' || !mAutoComplete.registerPrefix) {
            return;
        }
        mAutoComplete.registerPrefix('character', 'Booru character or artist trigger', (prefix) => {
            tagDexCore.ensureLoaded();
            if (tagDexCore.status != 'ready') {
                return ['\nNo character data yet - get it from More > TagDex Datasets.'];
            }
            if (!prefix || prefix.length < 2) {
                return ['\nType at least two characters.'];
            }
            let hits = tagDexCore.match(prefix);
            let results = [];
            for (let i = 0; i < hits.length && results.length < 20; i++) {
                let record = tagDexCore.recordAt(hits[i]);
                let comma = record.trigger.indexOf(',');
                let primary = comma > 0 ? record.trigger.substring(0, comma) : record.trigger;
                let entry = { raw: true, name: record.trigger, clean: primary };
                if (record.count > 0) {
                    entry.count_display = largeCountStringify(record.count);
                }
                results.push(entry);
            }
            if (results.length == 0) {
                return ['\nNo match.'];
            }
            return results;
        });
        mAutoComplete.registerAltPrefix('char', 'character');
    }

    /** Adds the dataset row to the More tab. Separate from install(): that one bails when MAutoComplete is absent,
     * and the datasets sheet is worth having either way. */
    installMoreItem() {
        if (typeof mUI == 'undefined' || !mUI.registerMoreItem) {
            return;
        }
        mUI.registerMoreItem('TagDex Datasets', () => this.openDatasetSheet());
    }

    /** Registers the Characters tab in the bottom nav. Runs at script load, before m_app.js wires the
     * router - the registerNavTab contract. The tab and the Create-row sheet share buildBrowseRow and the
     * server search; the tab adds pagination, because "thousands of characters" as one endless list is
     * exactly the stall this client exists to avoid. */
    installTab() {
        if (typeof mUI == 'undefined' || !mUI.registerNavTab) {
            return;
        }
        mUI.registerNavTab('characters', 'Characters', '\u2726', panel => this.buildTab(panel), null);
    }

    /** Builds the Characters tab: dataset + search + favorites controls, one page of cards, Prev/Next.
     *
     * Deliberately paged rather than infinite-scrolled. A page is one bounded request (pageSize rows) and one
     * bounded DOM (pageSize cards), so the tab costs the same whether the dataset has 500 rows or 50,000 -
     * there is no way to scroll it into holding thousands of img elements. The panel DOM persists across tab
     * switches (tabs build once), so returning to the tab re-shows the last page with zero requests. */
    buildTab(panel) {
        let wrap = mUI.el('div', 'm-tagdex-tab');
        let controls = mUI.el('div', 'm-tagdex-browse-controls');
        let source = document.createElement('select');
        source.className = 'm-tagdex-source';
        source.setAttribute('aria-label', 'Dataset');
        controls.appendChild(source);
        let search = document.createElement('input');
        search.type = 'search';
        search.placeholder = 'Search';
        search.className = 'm-tagdex-search';
        search.setAttribute('aria-label', 'Search characters and artists');
        controls.appendChild(search);
        let favorites = mUI.el('button', 'm-tagdex-favorite-filter', '\u2605 Favorites');
        favorites.setAttribute('aria-pressed', 'false');
        favorites.title = 'Show favorites only';
        wrap.appendChild(controls);
        // Second row: the filter and the layout toggle. Kept off the picker/search row so neither shrinks
        // below a comfortable tap target on a phone.
        let filterRow = mUI.el('div', 'm-tagdex-filter-row');
        filterRow.appendChild(favorites);
        let sortSelect = this.buildSortSelect();
        filterRow.appendChild(sortSelect);
        let status = mUI.el('div', 'm-tagdex-browse-status', 'Loading...');
        let results = mUI.el('div', 'm-tagdex-browse-results');
        filterRow.appendChild(this.buildViewToggle(results));
        wrap.appendChild(filterRow);
        wrap.appendChild(status);
        wrap.appendChild(results);
        let pager = mUI.el('div', 'm-tagdex-pager');
        let prev = mUI.el('button', 'm-tagdex-page-button', '\u2039 Prev');
        prev.setAttribute('aria-label', 'Previous page');
        let pageLabel = mUI.el('span', 'm-tagdex-page-label', '');
        let next = mUI.el('button', 'm-tagdex-page-button', 'Next \u203A');
        next.setAttribute('aria-label', 'Next page');
        pager.appendChild(prev);
        pager.appendChild(pageLabel);
        pager.appendChild(next);
        pager.style.display = 'none';
        wrap.appendChild(pager);
        panel.appendChild(wrap);
        let ctx = { 'sources': [], 'source': '', 'offset': 0, 'pageSize': 50, 'total': 0, 'token': 0, 'timer': null, 'favoritesOnly': false, 'sortBy': this.sortMode() };
        let runSearch;
        let render = (records) => {
            results.innerHTML = '';
            for (let i = 0; i < records.length; i++) {
                results.appendChild(this.buildBrowseRow(records[i], ctx.source, () => runSearch()));
            }
            if (records.length == 0) {
                results.appendChild(mUI.el('div', 'm-strip-empty', ctx.favoritesOnly ? 'No favorites yet - star characters to pin them here.' : 'No matches.'));
            }
            let first = ctx.offset + 1;
            let last = ctx.offset + records.length;
            let pages = Math.max(1, Math.ceil(ctx.total / ctx.pageSize));
            let page = Math.floor(ctx.offset / ctx.pageSize) + 1;
            status.textContent = ctx.total == 0 ? '0 matches'
                : `${first.toLocaleString()}\u2013${last.toLocaleString()} of ${ctx.total.toLocaleString()}`;
            pageLabel.textContent = `${page} / ${pages}`;
            pager.style.display = ctx.total > ctx.pageSize ? '' : 'none';
            prev.disabled = ctx.offset <= 0;
            next.disabled = ctx.offset + ctx.pageSize >= ctx.total;
        };
        runSearch = () => {
            if (!ctx.source) {
                results.innerHTML = '';
                status.textContent = 'No datasets. Download one from More.';
                pager.style.display = 'none';
                return;
            }
            let token = ++ctx.token;
            status.textContent = 'Searching...';
            genericRequest('TagDexSearchEntries', {
                'source': ctx.source,
                'search': search.value.trim(),
                'sortBy': ctx.sortBy || 'relevance',
                'offset': ctx.offset,
                'limit': ctx.pageSize,
                'withFolders': false,
                'favoritesOnly': ctx.favoritesOnly
            }, data => {
                if (token != ctx.token) {
                    return;
                }
                if (data.missing_data) {
                    results.innerHTML = '';
                    status.textContent = 'Dataset not downloaded.';
                    pager.style.display = 'none';
                    return;
                }
                ctx.total = data.total || 0;
                // A stale offset (favorites unstarred down to a smaller list, or a narrower search) can point
                // past the end. Clamp to the last real page and re-ask rather than showing an empty page 7.
                if (ctx.offset > 0 && ctx.offset >= ctx.total) {
                    ctx.offset = Math.max(0, (Math.ceil(ctx.total / ctx.pageSize) - 1) * ctx.pageSize);
                    runSearch();
                    return;
                }
                render(data.results || []);
            }, 0, error => {
                if (token != ctx.token) {
                    return;
                }
                results.innerHTML = '';
                status.textContent = 'Search failed.';
                pager.style.display = 'none';
                mUI.warn(`TagDex: ${error}`);
            });
        };
        let restart = () => {
            ctx.offset = 0;
            runSearch();
        };
        source.addEventListener('change', () => {
            ctx.source = source.value;
            // Re-gate before searching: a dataset without scores must not keep a score sort selected.
            this.syncSortOptions(sortSelect, ctx);
            restart();
        });
        sortSelect.addEventListener('change', () => {
            ctx.sortBy = sortSelect.value;
            this.saveSortMode(ctx.sortBy);
            restart();
        });
        search.addEventListener('input', () => {
            clearTimeout(ctx.timer);
            ctx.timer = setTimeout(restart, 180);
        });
        favorites.addEventListener('click', () => {
            ctx.favoritesOnly = !ctx.favoritesOnly;
            favorites.setAttribute('aria-pressed', `${ctx.favoritesOnly}`);
            restart();
        });
        let flip = (delta) => {
            ctx.offset = Math.max(0, ctx.offset + delta * ctx.pageSize);
            // Back to the top of the new page: keeping the old scroll depth on fresh rows reads as a glitch.
            panel.scrollTop = 0;
            runSearch();
        };
        prev.addEventListener('click', () => flip(-1));
        next.addEventListener('click', () => flip(1));
        this.fetchSources((sources, prefs) => {
            ctx.sources = sources.filter(item => item.present);
            source.innerHTML = '';
            for (let i = 0; i < ctx.sources.length; i++) {
                let option = document.createElement('option');
                option.value = ctx.sources[i].id;
                option.textContent = ctx.sources[i].label;
                source.appendChild(option);
            }
            let preferred = prefs && prefs.active_sources ? prefs.active_sources.find(id => ctx.sources.some(item => item.id == id)) : '';
            ctx.source = preferred || (ctx.sources.length > 0 ? ctx.sources[0].id : '');
            source.value = ctx.source;
            this.syncSortOptions(sortSelect, ctx);
            runSearch();
        });
    }

    /** Mounts the Characters picker beside the Create panel's model and LoRA pickers. Called from m_create.js
     * because TagDex loads before MCreate and cannot safely patch a panel that does not exist yet. */
    installBrowse(row) {
        if (this.browseInstalled || !row || typeof mUI == 'undefined') {
            return;
        }
        this.browseInstalled = true;
        let button = mUI.el('button', 'm-picker-button m-tagdex-browse-button', 'Characters');
        button.addEventListener('click', () => this.openBrowseSheet());
        row.appendChild(button);
    }

    /** Opens the compact character/artist browser. It uses the same server search as the genpage browse tab,
     * but deliberately limits the phone surface to dataset + text search: facets remain in the full UI. */
    openBrowseSheet() {
        let content = mUI.el('div', 'm-tagdex-browse-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', 'Characters'));
        let controls = mUI.el('div', 'm-tagdex-browse-controls');
        let source = document.createElement('select');
        source.className = 'm-tagdex-source';
        source.setAttribute('aria-label', 'Dataset');
        controls.appendChild(source);
        let search = document.createElement('input');
        search.type = 'search';
        search.placeholder = 'Search';
        search.className = 'm-tagdex-search';
        search.setAttribute('aria-label', 'Search characters and artists');
        controls.appendChild(search);
        let favorites = mUI.el('button', 'm-tagdex-favorite-filter', '★ Favorites');
        favorites.setAttribute('aria-pressed', 'false');
        favorites.title = 'Show favorites only';
        content.appendChild(controls);
        let filterRow = mUI.el('div', 'm-tagdex-filter-row');
        filterRow.appendChild(favorites);
        let sortSelect = this.buildSortSelect();
        filterRow.appendChild(sortSelect);
        let status = mUI.el('div', 'm-tagdex-browse-status', 'Loading...');
        let results = mUI.el('div', 'm-tagdex-browse-results');
        filterRow.appendChild(this.buildViewToggle(results));
        content.appendChild(filterRow);
        content.appendChild(status);
        content.appendChild(results);
        let more = mUI.el('button', 'm-wide-button m-tagdex-more', 'Load More');
        more.style.display = 'none';
        content.appendChild(more);
        mUI.openSheet(content);
        let ctx = { 'sources': [], 'source': '', 'limit': 50, 'token': 0, 'timer': null, 'total': 0, 'favoritesOnly': false, 'sortBy': this.sortMode() };
        let runSearch = () => {
            if (!ctx.source) {
                results.innerHTML = '';
                status.textContent = 'No datasets. Download one from More.';
                more.style.display = 'none';
                return;
            }
            let token = ++ctx.token;
            status.textContent = 'Searching...';
            genericRequest('TagDexSearchEntries', {
                'source': ctx.source,
                'search': search.value.trim(),
                'sortBy': ctx.sortBy || 'relevance',
                'offset': 0,
                'limit': ctx.limit,
                'withFolders': false,
                'favoritesOnly': ctx.favoritesOnly
            }, data => {
                if (token != ctx.token) {
                    return;
                }
                results.innerHTML = '';
                if (data.missing_data) {
                    status.textContent = 'Dataset not downloaded.';
                    more.style.display = 'none';
                    return;
                }
                let records = data.results || [];
                ctx.total = data.total || 0;
                for (let i = 0; i < records.length; i++) {
                    results.appendChild(this.buildBrowseRow(records[i], ctx.source, () => runSearch()));
                }
                if (records.length == 0) {
                    results.appendChild(mUI.el('div', 'm-strip-empty', 'No matches.'));
                }
                status.textContent = records.length < ctx.total
                    ? `${records.length.toLocaleString()} of ${ctx.total.toLocaleString()}`
                    : `${ctx.total.toLocaleString()} match${ctx.total == 1 ? '' : 'es'}`;
                more.style.display = records.length < ctx.total && ctx.limit < 250 ? '' : 'none';
            }, 0, error => {
                if (token != ctx.token) {
                    return;
                }
                results.innerHTML = '';
                status.textContent = 'Search failed.';
                more.style.display = 'none';
                mUI.warn(`TagDex: ${error}`);
            });
        };
        source.addEventListener('change', () => {
            ctx.source = source.value;
            ctx.limit = 50;
            this.syncSortOptions(sortSelect, ctx);
            runSearch();
        });
        sortSelect.addEventListener('change', () => {
            ctx.sortBy = sortSelect.value;
            this.saveSortMode(ctx.sortBy);
            ctx.limit = 50;
            runSearch();
        });
        search.addEventListener('input', () => {
            clearTimeout(ctx.timer);
            ctx.timer = setTimeout(() => {
                ctx.limit = 50;
                runSearch();
            }, 180);
        });
        favorites.addEventListener('click', () => {
            ctx.favoritesOnly = !ctx.favoritesOnly;
            ctx.limit = 50;
            favorites.setAttribute('aria-pressed', `${ctx.favoritesOnly}`);
            runSearch();
        });
        more.addEventListener('click', () => {
            ctx.limit = Math.min(250, ctx.limit + 50);
            runSearch();
        });
        this.fetchSources((sources, prefs) => {
            ctx.sources = sources.filter(item => item.present);
            source.innerHTML = '';
            for (let i = 0; i < ctx.sources.length; i++) {
                let option = document.createElement('option');
                option.value = ctx.sources[i].id;
                option.textContent = ctx.sources[i].label;
                source.appendChild(option);
            }
            let preferred = prefs && prefs.active_sources ? prefs.active_sources.find(id => ctx.sources.some(item => item.id == id)) : '';
            ctx.source = preferred || (ctx.sources.length > 0 ? ctx.sources[0].id : '');
            source.value = ctx.source;
            this.syncSortOptions(sortSelect, ctx);
            runSearch();
        });
    }

    /** Sort modes offered on the compact surfaces, mirroring the genpage tab's dropdown so the same dataset
     * sorts the same way on both. Values are the server's (`TagDexSearch.Run`); `scored` and `character` mark the
     * ones that only apply to some datasets, exactly as the genpage gates them. */
    static SortModes = [
        { 'value': 'relevance', 'label': 'Best Match' },
        { 'value': 'count', 'label': 'Most Posts' },
        { 'value': 'solo_count', 'label': 'Most Solo Posts' },
        { 'value': 'uniqueness', 'label': 'Most Distinctive Style', 'needs': 'scored' },
        { 'value': 'avg_score', 'label': 'Highest Quality Score', 'needs': 'scored' },
        { 'value': 'name', 'label': 'Name A-Z' },
        { 'value': 'copyright', 'label': 'Series A-Z', 'needs': 'character' }
    ];

    /** Reads the remembered sort mode, falling back to relevance for an absent or unknown value. */
    sortMode() {
        try {
            let stored = localStorage.getItem('m_client_tagdex_sort');
            for (let i = 0; i < MTagDexClass.SortModes.length; i++) {
                if (MTagDexClass.SortModes[i].value == stored) {
                    return stored;
                }
            }
        }
        catch (e) {
            // Storage can throw outright in private mode - fall through to the default.
        }
        return 'relevance';
    }

    /** Builds the sort dropdown. Every mode is added up front; syncSortOptions hides the ones the active dataset
     * cannot answer, which is cheaper than rebuilding the list on each dataset change. */
    buildSortSelect() {
        let select = document.createElement('select');
        select.className = 'm-tagdex-sort';
        select.setAttribute('aria-label', 'Sort order');
        select.title = 'Sort order';
        for (let i = 0; i < MTagDexClass.SortModes.length; i++) {
            let mode = MTagDexClass.SortModes[i];
            let option = document.createElement('option');
            option.value = mode.value;
            option.textContent = mode.label;
            if (mode.needs) {
                option.dataset.needs = mode.needs;
            }
            select.appendChild(option);
        }
        select.value = this.sortMode();
        return select;
    }

    /** Hides sort modes the active dataset cannot answer: the two score-based ones unless the dataset carries
     * scores, and the series sort unless it holds characters (artist rows have no copyright to sort on). If the
     * selected mode is the one that just disappeared, drops back to relevance rather than silently sorting by a
     * field of nulls. */
    syncSortOptions(select, ctx) {
        let scored = false;
        let isCharacter = false;
        for (let i = 0; i < ctx.sources.length; i++) {
            if (ctx.sources[i].id == ctx.source) {
                scored = ctx.sources[i].scored == true;
                isCharacter = ctx.sources[i].kind == 'character';
            }
        }
        let options = select.querySelectorAll('option');
        for (let i = 0; i < options.length; i++) {
            let needs = options[i].dataset.needs;
            let allowed = !needs || (needs == 'scored' ? scored : isCharacter);
            options[i].style.display = allowed ? '' : 'none';
            if (!allowed && select.value == options[i].value) {
                select.value = 'relevance';
            }
        }
        ctx.sortBy = select.value;
    }

    /** Remembers the sort mode across sheets, tabs and reloads, the same way the layout toggle is remembered. */
    saveSortMode(mode) {
        try {
            localStorage.setItem('m_client_tagdex_sort', mode);
        }
        catch (e) {
            mUI.warn('Could not save the sort preference.');
        }
    }

    /** The layouts the toggle cycles through, in order. Explicit column counts rather than an auto-fill grid:
     * auto-fill gives seven tiles across on a desktop window, which is not a browsing layout anyone asked for. */
    static ViewModes = ['list', 'grid2', 'grid3'];

    /** Reads the remembered results layout. An absent or corrupt value falls back to the list, so a bad write
     * can never leave the browser in a layout the user cannot name. */
    viewMode() {
        try {
            let stored = localStorage.getItem('m_client_tagdex_view');
            return MTagDexClass.ViewModes.includes(stored) ? stored : 'list';
        }
        catch (e) {
            // localStorage throws outright in some private-mode configurations - fail to the default layout.
            return 'list';
        }
    }

    /** Applies a layout to a results container. The cards are the same elements in every mode; only the
     * container's classes change, so switching never needs a re-render or another search. */
    applyView(results, mode) {
        results.classList.toggle('m-tagdex-grid', mode != 'list');
        results.classList.toggle('m-tagdex-grid-2', mode == 'grid2');
        results.classList.toggle('m-tagdex-grid-3', mode == 'grid3');
    }

    /** Builds the layout toggle, cycling List -> 2 wide -> 3 wide. Shared by the Characters tab and the
     * Create-row sheet so the two surfaces cannot drift apart, and so one preference governs both. */
    buildViewToggle(results) {
        let labels = { 'list': '☰ List', 'grid2': '▦ 2 wide', 'grid3': '▦ 3 wide' };
        let button = mUI.el('button', 'm-tagdex-view-toggle', '');
        let sync = () => {
            let mode = this.viewMode();
            this.applyView(results, mode);
            button.textContent = labels[mode];
            button.title = 'Change the results layout';
            button.setAttribute('aria-label', `Results layout: ${labels[mode]}`);
        };
        button.addEventListener('click', () => {
            let next = MTagDexClass.ViewModes[(MTagDexClass.ViewModes.indexOf(this.viewMode()) + 1) % MTagDexClass.ViewModes.length];
            try {
                localStorage.setItem('m_client_tagdex_view', next);
            }
            catch (e) {
                mUI.warn('Could not save the layout preference.');
            }
            sync();
        });
        sync();
        return button;
    }

    /** Builds one browse result. The main action inserts the trigger at the Create prompt's remembered caret;
     * the separate star keeps favorite changes from also modifying the prompt. */
    buildBrowseRow(record, source, onFavoriteRemoved) {
        let row = mUI.el('div', 'm-tagdex-card');
        let main = mUI.el('button', 'm-tagdex-card-main');
        main.setAttribute('aria-label', `Add ${record.display || record.name}`);
        let image = document.createElement('img');
        image.className = 'm-tagdex-card-image';
        image.src = record.thumb || 'imgs/model_placeholder.jpg';
        image.loading = 'lazy';
        image.alt = '';
        main.appendChild(image);
        let textWrap = mUI.el('span', 'm-tagdex-card-text');
        textWrap.appendChild(mUI.el('span', 'm-tagdex-card-name', record.display || record.name));
        if (record.copyright_display) {
            textWrap.appendChild(mUI.el('span', 'm-tagdex-card-sub', record.copyright_display));
        }
        textWrap.appendChild(mUI.el('span', 'm-tagdex-card-count', `${largeCountStringify(record.count)} posts`));
        main.appendChild(textWrap);
        let insert = (text, note) => {
            if (typeof mCreate == 'undefined' || typeof mCreate.insertIntoPrompt != 'function') {
                mUI.warn('Create panel is unavailable.');
                return;
            }
            mCreate.insertIntoPrompt(text);
            mUI.note(note);
        };
        main.addEventListener('click', () => {
            insert(record.trigger, `Added ${record.display || record.name}.`);
        });
        row.appendChild(main);
        // The trigger alone is a character's name, not their appearance: on most checkpoints it produces the
        // right person only where the base model already knows them well. core_tags is the descriptive set the
        // dataset ships alongside it (hair, eyes, outfit), and it is what makes an unfamiliar character render
        // as themselves. Both are one tap, because which one is wanted depends on the model - this mirrors the
        // desktop tab, where the card inserts the trigger and its menu offers "Insert All Tags".
        let coreTags = record.core_tags || [];
        if (coreTags.length > 0) {
            let all = mUI.el('button', 'm-tagdex-alltags-button', '+');
            let allLabel = `Add ${record.display || record.name} with all ${coreTags.length} tags`;
            all.setAttribute('aria-label', allLabel);
            all.title = allLabel;
            all.addEventListener('click', () => {
                insert([record.trigger].concat(coreTags).join(', '),
                    `Added ${record.display || record.name} + ${coreTags.length} tags.`);
            });
            row.appendChild(all);
        }
        let favoriteLabel = record.favorited ? 'Remove Favorite' : 'Add Favorite';
        let favorite = mUI.el('button', `m-tagdex-favorite-button${record.favorited ? ' m-tagdex-favorite-active' : ''}`, record.favorited ? '★' : '☆');
        favorite.setAttribute('aria-label', favoriteLabel);
        favorite.setAttribute('aria-pressed', `${record.favorited == true}`);
        favorite.title = record.favorited ? 'Remove from favorites' : 'Add to favorites';
        favorite.addEventListener('click', () => {
            favorite.disabled = true;
            genericRequest('TagDexToggleFavorite', { 'source': source, 'name': record.name }, data => {
                let favorited = data.favorited == true;
                record.favorited = favorited;
                favorite.disabled = false;
                favorite.classList.toggle('m-tagdex-favorite-active', favorited);
                favorite.textContent = favorited ? '★' : '☆';
                favorite.setAttribute('aria-label', favorited ? 'Remove Favorite' : 'Add Favorite');
                favorite.setAttribute('aria-pressed', `${favorited}`);
                favorite.title = favorited ? 'Remove from favorites' : 'Add to favorites';
                if (!favorited && onFavoriteRemoved) {
                    onFavoriteRemoved();
                }
            }, 0, error => {
                favorite.disabled = false;
                mUI.warn(`Favorite failed: ${error}`);
            });
        });
        row.appendChild(favorite);
        return row;
    }

    /** The dataset download/manage sheet. Without it /simple is a dead end - the `<character:` handler can only
     * report that there is no data, with no way to act on it.
     *
     * One download at a time, deliberately. The genpage drawer preserves in-flight rows across a list rebuild;
     * here the simpler rule is to disable every action while one runs, which makes that whole class of stranded-
     * row bug unreachable. Two large CSVs at once over cellular is not a phone use case worth the machinery. */
    openDatasetSheet() {
        let content = mUI.el('div', 'm-tagdex-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', 'TagDex Datasets'));
        let results = mUI.el('div', 'm-tagdex-results');
        content.appendChild(results);
        // Checked at sheet-open rather than at page boot: permissions.hasPermission() fails OPEN before the
        // session lands, and a deep link to #more can build that tab before GetNewSession returns. By the time
        // someone has tapped through to here, the session is up. The list itself needs only tagdex_use, so it
        // renders for everyone and only the action buttons are withheld.
        // One shared mutable context rather than snapshot parameters. `busy` has to be read live at click time: a
        // render-time copy would leave every other row's button still believing nothing was running.
        let ctx = {
            'sources': null,
            'busy': false,
            'canManage': typeof permissions == 'undefined' || !permissions.hasPermission || permissions.hasPermission('tagdex_manage')
        };
        ctx.render = () => {
            results.innerHTML = '';
            if (!ctx.sources) {
                results.appendChild(mUI.el('div', 'm-strip-empty', 'Loading...'));
                return;
            }
            for (let i = 0; i < ctx.sources.length; i++) {
                let source = ctx.sources[i];
                if (!source.downloadable && !source.present) {
                    // A locally supplied dataset that was never dropped in has nothing to show and nothing to do.
                    continue;
                }
                results.appendChild(this.buildDatasetRow(ctx, source));
            }
            if (!ctx.canManage) {
                results.appendChild(mUI.el('div', 'm-list-count', 'Downloading needs the TagDex manage permission.'));
            }
        };
        ctx.refresh = () => {
            ctx.busy = false;
            this.fetchSources(fresh => {
                ctx.sources = fresh;
                ctx.render();
            });
        };
        let close = mUI.openSheet(content);
        ctx.render();
        ctx.refresh();
        return close;
    }

    /** Fetches the dataset list. Needs only tagdex_use, so it works for every account. */
    fetchSources(callback) {
        genericRequest('TagDexListSources', {}, data => {
            callback(data.sources || [], data.prefs || {});
        }, 0, error => {
            mUI.warn(`Could not list datasets: ${error}`);
            callback([], {});
        });
    }

    /** Builds one dataset row for the sheet. */
    buildDatasetRow(ctx, source) {
        let row = mUI.el('div', 'm-tagdex-row');
        let info = mUI.el('div', 'm-tagdex-info');
        info.appendChild(mUI.el('div', 'm-tagdex-name', source.label));
        let status = mUI.el('div', 'm-tagdex-status', this.statusFor(source));
        info.appendChild(status);
        row.appendChild(info);
        if (!ctx.canManage) {
            return row;
        }
        let actions = mUI.el('div', 'm-tagdex-actions');
        if (source.downloadable) {
            let download = mUI.el('button', 'm-tagdex-action', source.present ? 'Re-download' : 'Download');
            download.disabled = ctx.busy;
            download.addEventListener('click', () => {
                if (ctx.busy) {
                    // The disabled attribute is only a render-time snapshot, so say why rather than no-op.
                    mUI.warn('Another dataset operation is already running.');
                    return;
                }
                ctx.busy = true;
                download.disabled = true;
                status.textContent = 'Starting...';
                makeWSRequest('TagDexDownloadSource', { 'source': source.id }, data => {
                    if (data.status == 'downloading') {
                        let percent = Math.round((data.current_percent || 0) * 100);
                        let mb = Math.round((data.downloaded || 0) / (1024 * 1024));
                        let totalMb = Math.round((data.total || 0) / (1024 * 1024));
                        status.textContent = `Downloading ${percent}% (${mb} / ${totalMb} MB)`;
                    }
                    else if (data.status == 'parsing') {
                        status.textContent = 'Parsing...';
                    }
                    else if (data.success) {
                        // The index the typeahead already fetched is now stale.
                        tagDexCore.status = 'unloaded';
                        tagDexCore.shards = [];
                        mUI.note(`${source.label}: ${data.rows.toLocaleString()} rows ready.`);
                        ctx.refresh();
                    }
                }, 0, error => {
                    // An errorHandle replaces makeWSRequest's own showError path, so this owes the user a visible
                    // failure - otherwise a rejected download looks exactly like a dead button.
                    status.textContent = 'Failed.';
                    mUI.warn(`${source.label}: ${error}`);
                    ctx.busy = false;
                    download.disabled = false;
                });
            });
            actions.appendChild(download);
        }
        if (source.present) {
            actions.appendChild(this.buildActionButton(ctx, source, 'Reload', 'TagDexReloadSource', true));
        }
        if (source.loaded) {
            actions.appendChild(this.buildActionButton(ctx, source, 'Unload', 'TagDexUnloadSource', false));
        }
        if (source.present && (source.id == 'danbooru_character' || source.id == 'danbooru_artist')) {
            actions.appendChild(this.buildFavoriteSyncButton(ctx, source, status));
        }
        row.appendChild(actions);
        return row;
    }

    /** Builds the explicit two-way AnimaDex favorite reconciliation action. */
    buildFavoriteSyncButton(ctx, source, status) {
        let button = mUI.el('button', 'm-tagdex-action', 'Sync Favorites');
        button.disabled = ctx.busy;
        button.addEventListener('click', () => {
            if (ctx.busy) {
                mUI.warn('Another dataset operation is already running.');
                return;
            }
            ctx.busy = true;
            button.disabled = true;
            status.textContent = 'Syncing favorites...';
            genericRequest('TagDexReconcileFavorites', { 'source': source.id }, data => {
                let unavailable = (data.remote_unavailable || 0) + (data.local_unavailable || 0);
                mUI.note(`${source.label}: synced ${data.total.toLocaleString()} favorites${unavailable > 0 ? `, ${unavailable.toLocaleString()} unavailable` : ''}.`);
                ctx.refresh();
            }, 0, error => {
                status.textContent = 'Sync failed.';
                mUI.warn(`${source.label}: ${error}`);
                ctx.busy = false;
                button.disabled = false;
            });
        });
        return button;
    }

    /** Builds a Reload or Unload button. `dataChanged` clears the typeahead's cached index, which a reload needs
     * (the file may have been edited) and an unload must not do - refetching would pull the dataset straight back
     * into memory and free nothing. */
    buildActionButton(ctx, source, label, route, dataChanged) {
        let button = mUI.el('button', 'm-tagdex-action', label);
        button.disabled = ctx.busy;
        button.addEventListener('click', () => {
            if (ctx.busy) {
                mUI.warn('Another dataset operation is already running.');
                return;
            }
            ctx.busy = true;
            button.disabled = true;
            genericRequest(route, { 'source': source.id }, data => {
                if (dataChanged) {
                    tagDexCore.status = 'unloaded';
                    tagDexCore.shards = [];
                }
                mUI.note(`${source.label}: ${label.toLowerCase()}ed.`);
                ctx.refresh();
            }, 0, error => {
                mUI.warn(`${source.label}: ${error}`);
                ctx.busy = false;
                button.disabled = false;
            });
        });
        return button;
    }

    /** One-line state description for a dataset. */
    statusFor(source) {
        if (!source.present) {
            return 'Not downloaded';
        }
        if (!source.loaded) {
            return source.downloadable ? 'Installed, not in memory' : 'Supplied locally, not in memory';
        }
        let prefix = source.downloadable ? 'Installed' : 'Supplied locally';
        return `${prefix} - ${source.rows.toLocaleString()} of ${source.total_rows.toLocaleString()} rows`;
    }
}

mTagDex = new MTagDexClass();
mTagDex.install();
mTagDex.installMoreItem();
mTagDex.installTab();
