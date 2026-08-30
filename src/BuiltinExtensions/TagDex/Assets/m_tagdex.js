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
                return ['\nNo character data yet - get it from More > TagDex datasets.'];
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
        mUI.registerMoreItem('TagDex datasets', () => this.openDatasetSheet());
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
        content.appendChild(controls);
        let status = mUI.el('div', 'm-tagdex-browse-status', 'Loading...');
        content.appendChild(status);
        let results = mUI.el('div', 'm-tagdex-browse-results');
        content.appendChild(results);
        let more = mUI.el('button', 'm-wide-button m-tagdex-more', 'Load more');
        more.style.display = 'none';
        content.appendChild(more);
        mUI.openSheet(content);
        let ctx = { 'sources': [], 'source': '', 'limit': 50, 'token': 0, 'timer': null, 'total': 0 };
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
                'sortBy': 'relevance',
                'offset': 0,
                'limit': ctx.limit,
                'withFolders': false
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
                    results.appendChild(this.buildBrowseRow(records[i]));
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
            runSearch();
        });
        search.addEventListener('input', () => {
            clearTimeout(ctx.timer);
            ctx.timer = setTimeout(() => {
                ctx.limit = 50;
                runSearch();
            }, 180);
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
            runSearch();
        });
    }

    /** Builds one browse result. The whole row is the action: tapping inserts the trigger at the Create
     * prompt's remembered caret and leaves the sheet open for another pick. */
    buildBrowseRow(record) {
        let row = mUI.el('button', 'm-tagdex-card');
        row.setAttribute('aria-label', `Add ${record.display || record.name}`);
        let image = document.createElement('img');
        image.className = 'm-tagdex-card-image';
        image.src = record.thumb || 'imgs/model_placeholder.jpg';
        image.loading = 'lazy';
        image.alt = '';
        row.appendChild(image);
        let textWrap = mUI.el('span', 'm-tagdex-card-text');
        textWrap.appendChild(mUI.el('span', 'm-tagdex-card-name', record.display || record.name));
        if (record.copyright_display) {
            textWrap.appendChild(mUI.el('span', 'm-tagdex-card-sub', record.copyright_display));
        }
        textWrap.appendChild(mUI.el('span', 'm-tagdex-card-count', `${largeCountStringify(record.count)} posts`));
        row.appendChild(textWrap);
        row.addEventListener('click', () => {
            if (typeof mCreate == 'undefined' || typeof mCreate.insertIntoPrompt != 'function') {
                mUI.warn('Create panel is unavailable.');
                return;
            }
            mCreate.insertIntoPrompt(record.trigger);
            mUI.note(`Added ${record.display || record.name}.`);
        });
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
        content.appendChild(mUI.el('div', 'm-sheet-title', 'TagDex datasets'));
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
        row.appendChild(actions);
        return row;
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
