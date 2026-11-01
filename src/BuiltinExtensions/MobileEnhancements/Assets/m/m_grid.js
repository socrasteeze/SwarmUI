/** MobileEnhancements standalone client - grid builder.
 *
 * Replaces the generic axis form that used to sit behind the Generate long-press. That form was the classic
 * UI's model shrunk onto a phone: pick a parameter id from a dropdown, then type its values as comma-
 * separated text. It technically covered everything and was usable for nothing - the values that matter most
 * here are LoRA paths and sampler ids, which nobody types correctly from memory on a phone keyboard.
 *
 * This is the same GridGenRun call with a built surface instead: fixed axes, each with a picker suited
 * to its own type. Preset is the shared [Grid Gen] Presets axis (mode gridgenpresets): one selected title
 * per cell, applied on the server on top of the Create tab. A model axis is deliberately not here - a grid
 * over that is a desk job, and the classic UI is one tap away in More.
 *
 * The axes are the four comparisons worth running from a phone, plus Sampler, which is what "scheduler"
 * usually means in practice - ER-SDE and the DPM family are samplers, and offering only the Scheduler
 * parameter would have quietly answered a different question than the one being asked. Both are here, named
 * as the server names them. */
class MGrid {

    /** The axes offered, in the order they appear. `mode` is the GridGenRun axis id, which is the cleaned
     * T2I parameter id - the server resolves it through the same table the classic UI uses.
     *
     * `separator` is '||' for LoRAs and ',' for the rest, and that is not cosmetic: GridGenCore splits an
     * axis on '||' when the string contains one and on ',' otherwise, and a LoRA axis VALUE can itself be a
     * comma-joined stack of LoRAs. Joining LoRAs with ',' would silently turn one three-LoRA stack into
     * three separate single-LoRA cells. */
    static Axes = [
        { key: 'preset', mode: 'gridgenpresets', label: 'Preset', kind: 'preset', separator: '||',
            hint: 'One cell per preset, on top of the Create tab. The preset wins where they disagree. {value} in the preset is the current prompt.' },
        { key: 'loras', mode: 'loras', label: 'LoRAs', kind: 'lora', separator: '||',
            hint: 'One cell per LoRA, stacked on top of the Create tab LoRAs. Same name -> grid wins. Weight is left at the model default.' },
        { key: 'loraweights', mode: 'loraweights', label: 'LoRA Strength', kind: 'number', separator: ',', needsLora: true,
            hint: 'Applies to the LoRAs axis above, so pick the LoRA there.',
            quick: ['0.25', '0.5', '0.75', '1', '1.25', '1.5'] },
        { key: 'loraconfinement', mode: 'lorasectionconfinement', label: 'LoRA Section', kind: 'choice', separator: ',', needsLora: true,
            hint: 'Where the LoRAs axis applies: the full generation, the base stage, or the refiner.' },
        { key: 'promptreplace', mode: 'gridgenpromptreplace', label: 'Prompt Replace', kind: 'text', separator: '||',
            hint: 'The first value is the text to find in the prompt, and it stays as the first cell. Each other value replaces it.' },
        { key: 'aspectratio', mode: 'aspectratio', label: 'Aspect Ratio', kind: 'choice', separator: ',', skip: 'Custom' },
        { key: 'steps', mode: 'steps', label: 'Steps', kind: 'number', separator: ',',
            quick: ['4', '8', '16', '20', '30', '40'] },
        { key: 'cfgscale', mode: 'cfgscale', label: 'CFG Scale', kind: 'number', separator: ',',
            quick: ['1', '1.5', '2', '3.5', '5', '7'] },
        { key: 'sampler', mode: 'sampler', label: 'Sampler', kind: 'choice', separator: ',',
            hint: 'Euler, DPM++, ER-SDE and the rest live here.' },
        { key: 'scheduler', mode: 'scheduler', label: 'Scheduler', kind: 'choice', separator: ',',
            hint: 'Pairs with the Sampler above - normal, karras, beta.' }
    ];

    /** Values selected per axis key, saved so a second run that changes one axis does not mean rebuilding
     * all of them, and so Grid mode's Generate button has something to run after a reload. */
    constructor() {
        this.selected = MGrid.loadSelected();
        /** Preferred contact-sheet row count. 0 = Auto (most values on X — never vertical). */
        this.rows = MGrid.loadRowsPref();
        /** Grid mode: the Create tab's Generate button runs the saved axes instead of one batch. */
        this.active = MGrid.loadActive();
        /** True while a run is resolving its backend, so a double tap cannot start two grids. */
        this.starting = false;
    }

    /** Saved axis values, keeping only known axes and text values. Empty on a missing or damaged entry. */
    static loadSelected() {
        try {
            let data = JSON.parse(localStorage.getItem('m_client_grid_selected') || '{}');
            let selected = {};
            for (let axis of MGrid.Axes) {
                if (Array.isArray(data[axis.key])) {
                    selected[axis.key] = data[axis.key].filter(v => typeof v == 'string');
                }
            }
            return selected;
        }
        catch (e) {
            return {};
        }
    }

    /** Stores the axis values. */
    saveSelected() {
        try {
            localStorage.setItem('m_client_grid_selected', JSON.stringify(this.selected));
        }
        catch (e) {
            /* private mode / quota */
        }
    }

    /** Whether Grid mode was left on. */
    static loadActive() {
        try {
            return localStorage.getItem('m_client_grid_mode') == 'grid';
        }
        catch (e) {
            return false;
        }
    }

    /** Turns Grid mode on or off, saves it, and repaints the Generate button. */
    setActive(active) {
        this.active = active;
        try {
            localStorage.setItem('m_client_grid_mode', active ? 'grid' : 'single');
        }
        catch (e) {
            /* private mode / quota */
        }
        mCreate.renderGenTarget();
    }

    /** Whether this session may run grids. */
    static permitted() {
        return typeof permissions == 'undefined' || !permissions.hasPermission
            || permissions.hasPermission('gridgen_generate_grids');
    }

    /** Whether Generate should run the grid: Grid mode is on and the session may use it. */
    isOn() {
        return this.active && MGrid.permitted();
    }

    /** True when LoRA Strength or Section has values but no LoRA axis. The server appends them after the
     * base LoRAs, so without an axis LoRA to line up with they are ignored and every cell comes out the same. */
    needsLoraAxis() {
        return this.valuesFor('loras').length == 0
            && MGrid.Axes.some(axis => axis.needsLora && this.valuesFor(axis.key).length > 0);
    }

    /** Whether the saved axes make a runnable grid. */
    isReady() {
        return this.totalImages() >= 2 && !this.needsLoraAxis();
    }

    /** Generate in Grid mode: runs the saved axes, or opens the sheet when they cannot run yet. */
    runOrOpen() {
        if (this.isReady()) {
            this.run(() => {});
        }
        else {
            this.open();
        }
    }

    /** The axes to send, or null after warning why they cannot be sent. */
    buildAxes() {
        let axes = [];
        for (let axis of MGrid.Axes) {
            let values = this.valuesFor(axis.key);
            if (axis.kind == 'text') {
                // A lone value replaces nothing, so it is not an axis.
                if (values.length < 2) {
                    continue;
                }
                // The server splits each cell on its first '=', so find text cannot contain one.
                if (values[0].includes('=')) {
                    mUI.warn(`${axis.label}: the first value cannot contain "=".`);
                    return null;
                }
                // Always the explicit find=value form: the server only builds it itself when no value
                // contains '=', so one replacement with an '=' in it would break the implicit form.
                axes.push({ 'mode': axis.mode, 'vals': values.map(v => `${values[0]}=${v}`).join(axis.separator) });
            }
            else if (values.length > 0) {
                axes.push({ 'mode': axis.mode, 'vals': values.join(axis.separator) });
            }
        }
        if (axes.length == 0) {
            mUI.warn('Fill in at least one axis first.');
            return null;
        }
        return axes;
    }

    /** Starts the grid on the backend the Generate button names. onStarted runs once it has been sent. */
    run(onStarted) {
        if (this.starting) {
            return;
        }
        let axes = this.buildAxes();
        if (!axes) {
            return;
        }
        let input = mState.buildGenInput();
        if (!`${input['prompt'] || ''}`.trim() && !input['promptimages'] && mState.activePresets.length == 0
            && this.valuesFor('preset').length == 0) {
            mUI.warn('Type a prompt or pick a preset first.');
            return;
        }
        this.starting = true;
        // Re-read on every run, as doGenerate does: a spoke's worker id changes whenever the spoke restarts.
        mState.refreshBackendTargets(() => {
            mCreate.renderGenTarget();
            let target = mState.resolveGenTarget();
            if (target.fellBack) {
                mUI.warn(`${MCreate.genTargetName(mState.genTarget, mState.backendTargets)} is not available - running here instead.`);
            }
            let start = (base) => {
                this.starting = false;
                let error = typeof mControlNet != 'undefined' ? mControlNet.validateGrid(base, this.valuesFor('preset')) : '';
                if (error) {
                    mUI.warn(error);
                    return;
                }
                // A control image has already pinned the backend that holds its model.
                if (!base.controlnetimageinput) {
                    if (target.id == null) {
                        delete base['exactbackendid'];
                    }
                    else {
                        base['exactbackendid'] = target.id;
                    }
                }
                mGen.runGrid(base, axes, { 'rows': this.rows });
                mUI.note(`Grid started: ${this.totalImages()} images.`);
                onStarted();
            };
            if (typeof mControlNet != 'undefined' && mControlNet.isAnima(mState.mergedParams())) {
                mControlNet.prepare(() => this.buildBase(), start, () => { this.starting = false; });
            }
            else {
                start(this.buildBase());
            }
        });
    }

    /** Persisted row-count preference. 0 means Auto. */
    static loadRowsPref() {
        try {
            let raw = localStorage.getItem('m_client_grid_rows');
            if (raw == null || raw === '') {
                return 0;
            }
            let n = parseInt(raw, 10);
            return Number.isFinite(n) && n >= 0 ? n : 0;
        }
        catch (e) {
            return 0;
        }
    }

    /** Stores the row-count preference (0 = Auto). */
    static saveRowsPref(rows) {
        try {
            localStorage.setItem('m_client_grid_rows', `${rows}`);
        }
        catch (e) {
            /* private mode / quota */
        }
    }

    /** Registers the More-tab entry. The Generate long-press still opens this too; the row exists because a
     * long-press is not a discoverable way to reach a whole feature. */
    install() {
        if (typeof mUI == 'undefined' || !mUI.registerMoreItem) {
            return;
        }
        mUI.registerMoreItem('Grid generate', () => this.open());
    }

    /** Currently-selected values for one axis, always an array. */
    valuesFor(key) {
        return this.selected[key] || [];
    }

    /** How many images the current selection would produce: the product of every axis that has 1+ values.
     * An axis with a single value still multiplies by one, so it costs nothing but does pin that value. */
    totalImages() {
        let total = 1;
        let axes = 0;
        for (let axis of MGrid.Axes) {
            let count = this.valuesFor(axis.key).length;
            if (count > 0) {
                total *= count;
                axes++;
            }
        }
        return axes == 0 ? 0 : total;
    }

    /** The grid sheet. */
    open() {
        if (!MGrid.permitted()) {
            mUI.warn('You do not have grid generation permission.');
            return;
        }
        let content = mUI.el('div', 'm-grid-sheet');
        content.appendChild(mUI.el('div', 'm-sheet-title', 'Grid Generate'));
        content.appendChild(mUI.el('div', 'm-grid-intro',
            'Runs every combination of the axes you fill in. Everything else comes from the Create tab as it '
            + 'stands right now.'));
        let cards = mUI.el('div', 'm-grid-cards');
        content.appendChild(cards);
        let summaries = {};
        for (let axis of MGrid.Axes) {
            let card = mUI.el('details', 'm-grid-card');
            let head = mUI.el('summary', 'm-grid-card-head');
            head.appendChild(mUI.el('span', 'm-grid-card-name', axis.label));
            let summary = mUI.el('span', 'm-grid-card-summary');
            head.appendChild(summary);
            summaries[axis.key] = summary;
            card.appendChild(head);
            let body = mUI.el('div', 'm-grid-card-body');
            card.appendChild(body);
            this.buildAxisBody(axis, body, () => {
                this.saveSelected();
                renderSummaries();
                mCreate.renderGenTarget();
            });
            cards.appendChild(card);
        }
        let footer = mUI.el('div', 'm-grid-footer');
        let count = mUI.el('div', 'm-grid-count');
        footer.appendChild(count);
        let layout = mUI.el('div', 'm-grid-layout');
        layout.appendChild(mUI.el('div', 'm-grid-layout-label', 'Rows'));
        let layoutRow = mUI.el('div', 'm-grid-layout-choices m-seg-group');
        let rowChoices = [
            { value: 0, label: 'Auto' },
            { value: 1, label: '1' },
            { value: 2, label: '2' },
            { value: 3, label: '3' },
            { value: 4, label: '4' }
        ];
        let paintRowChoice = () => {
            for (let button of layoutRow.querySelectorAll('.m-grid-layout-button')) {
                let value = parseInt(button.dataset.rows, 10);
                button.classList.toggle('m-selected', value == this.rows);
            }
        };
        for (let choice of rowChoices) {
            let button = mUI.el('button', 'm-grid-layout-button', choice.label);
            button.type = 'button';
            button.dataset.rows = `${choice.value}`;
            button.addEventListener('click', () => {
                this.rows = choice.value;
                MGrid.saveRowsPref(this.rows);
                paintRowChoice();
            });
            layoutRow.appendChild(button);
        }
        paintRowChoice();
        layout.appendChild(layoutRow);
        footer.appendChild(layout);
        let runButton = mUI.el('button', 'm-generate-button m-grid-run', 'Run Grid');
        footer.appendChild(runButton);
        content.appendChild(footer);
        let renderSummaries = () => {
            for (let axis of MGrid.Axes) {
                let values = this.valuesFor(axis.key);
                summaries[axis.key].textContent = values.length == 0 ? 'off'
                    : `${values.length}: ${MGrid.summarise(values, axis)}`;
                summaries[axis.key].classList.toggle('m-grid-card-on', values.length > 0);
            }
            let total = this.totalImages();
            let needsLora = this.needsLoraAxis();
            count.textContent = needsLora ? 'Pick a LoRA in the LoRAs axis first.'
                : total == 0 ? 'No axes set yet.'
                : `${total} image${total == 1 ? '' : 's'}`;
            // Disabled rather than hidden, and the count above says why: a Run button that vanishes reads as
            // a bug, while one that is visibly unavailable next to "No axes set yet" explains itself.
            runButton.disabled = !this.isReady();
        };
        renderSummaries();
        runButton.addEventListener('click', () => this.run(() => close()));
        let close = mUI.openSheet(content);
        return close;
    }

    /** Base parameters for the run: the Create tab as it stands, minus what the grid itself decides.
     *
     * `images` goes because the batch count would multiply every cell. Session (and preset-merged) LoRAs are
     * STACKED with a LoRA axis rather than cleared: GridGenerator registers loras/loraweights as
     * comma-stackable, so each cell appends the axis value onto this base. Same LoRA id in both -> the base
     * entry is dropped so the axis weight/entry wins. Non-LoRA preset params still ride through buildGenInput. */
    buildBase() {
        let base = mState.buildGenInput();
        delete base['images'];
        let gridLoras = this.valuesFor('loras');
        if (gridLoras.length > 0) {
            let axisIds = [];
            for (let cell of gridLoras) {
                for (let part of MState.toList(cell)) {
                    axisIds.push(part);
                }
            }
            let names = MState.toList(base['loras']);
            let weights = MState.toList(base['loraweights']);
            let confs = MState.toList(base['lorasectionconfinement']);
            let keepNames = [], keepWeights = [], keepConfs = [];
            let hadConf = confs.length > 0;
            for (let i = 0; i < names.length; i++) {
                if (axisIds.some(id => MState.sameModel(names[i], id))) {
                    continue;
                }
                keepNames.push(names[i]);
                keepWeights.push(weights.length > i ? weights[i] : '1');
                if (hadConf) {
                    keepConfs.push(confs.length > i && `${confs[i]}` != '' ? `${confs[i]}` : '0');
                }
            }
            if (keepNames.length == 0) {
                delete base['loras'];
                delete base['loraweights'];
                delete base['lorasectionconfinement'];
            }
            else {
                base['loras'] = keepNames;
                base['loraweights'] = keepWeights;
                if (keepConfs.some(c => c != '0')) {
                    base['lorasectionconfinement'] = keepConfs;
                }
                else {
                    delete base['lorasectionconfinement'];
                }
            }
        }
        return base;
    }

    /** Fills one axis card. Each kind gets the picker its values actually need. */
    buildAxisBody(axis, body, onChange) {
        if (axis.hint) {
            body.appendChild(mUI.el('div', 'm-grid-hint', axis.hint));
        }
        let chosen = mUI.el('div', 'm-grid-chosen');
        body.appendChild(chosen);
        let renderChosen = () => {
            chosen.innerHTML = '';
            let values = this.valuesFor(axis.key);
            if (values.length == 0) {
                chosen.appendChild(mUI.el('div', 'm-strip-empty', 'Nothing picked - this axis is off.'));
                return;
            }
            for (let value of values) {
                let chip = axis.kind == 'lora' ? mUI.el('span', 'm-grid-chip') : mUI.el('span', 'm-grid-chip', MGrid.valueLabel(axis, value));
                if (axis.kind == 'lora') {
                    chip.appendChild(MGrid.tailLabel(MGrid.valueLabel(axis, value)));
                }
                let x = mUI.el('span', 'm-grid-chip-x', '×');
                x.setAttribute('aria-label', `Remove ${value}`);
                x.addEventListener('click', () => {
                    this.selected[axis.key] = this.valuesFor(axis.key).filter(v => v != value);
                    renderChosen();
                    if (renderOptions) {
                        renderOptions();
                    }
                    onChange();
                });
                chip.appendChild(x);
                chosen.appendChild(chip);
            }
        };
        let toggle = (value) => {
            let values = this.valuesFor(axis.key);
            this.selected[axis.key] = values.includes(value)
                ? values.filter(v => v != value) : values.concat([value]);
            renderChosen();
            if (renderOptions) {
                renderOptions();
            }
            onChange();
        };
        let renderOptions = null;
        if (axis.kind == 'number' || axis.kind == 'text') {
            let quickRow = mUI.el('div', 'm-grid-quick');
            renderOptions = () => {
                quickRow.innerHTML = '';
                for (let value of axis.quick || []) {
                    let button = mUI.el('button', 'm-grid-quick-button', value);
                    button.classList.toggle('m-selected', this.valuesFor(axis.key).includes(value));
                    button.addEventListener('click', () => toggle(value));
                    quickRow.appendChild(button);
                }
            };
            renderOptions();
            body.appendChild(quickRow);
            // The quick row covers the values worth tapping; this covers everything else without making the
            // common case type anything. Accepts a comma list so a whole axis can be pasted in at once.
            let customRow = mUI.el('div', 'm-grid-custom');
            let input = mUI.el('input', 'm-grid-custom-input');
            input.type = 'text';
            input.inputMode = axis.kind == 'text' ? 'text' : 'decimal';
            input.placeholder = axis.kind == 'text' ? 'Add a value' : 'Other values, comma separated';
            customRow.appendChild(input);
            let add = mUI.el('button', 'm-grid-add-button', 'Add');
            let commit = () => {
                // Prompt text carries its own commas, so a text value is one whole entry.
                let added = (axis.kind == 'text' ? [`${input.value}`] : `${input.value}`.split(','))
                    .map(v => v.trim()).filter(v => v != '');
                if (added.length == 0) {
                    return;
                }
                let values = this.valuesFor(axis.key);
                for (let value of added) {
                    if (!values.includes(value)) {
                        values = values.concat([value]);
                    }
                }
                this.selected[axis.key] = values;
                input.value = '';
                renderChosen();
                renderOptions();
                onChange();
            };
            add.addEventListener('click', commit);
            customRow.appendChild(add);
            body.appendChild(customRow);
        }
        else if (axis.kind == 'choice') {
            let list = mUI.el('div', 'm-grid-options');
            renderOptions = () => {
                list.innerHTML = '';
                // The section param is free text on the server, so its choices are the Create tab's own list.
                let meta = axis.key == 'loraconfinement'
                    ? { values: MCreate.LoraSections.map(s => s[0]), value_names: MCreate.LoraSections.map(s => s[1]) }
                    : mState.paramMeta[axis.mode];
                let options = meta && meta.values ? meta.values : [];
                if (options.length == 0) {
                    list.appendChild(mUI.el('div', 'm-strip-empty',
                        `The server has not reported any ${axis.label.toLowerCase()} values.`));
                    return;
                }
                for (let i = 0; i < options.length; i++) {
                    let value = options[i];
                    if (value == axis.skip) {
                        continue;
                    }
                    let label = meta.value_names && meta.value_names[i] ? meta.value_names[i] : value;
                    let button = mUI.el('button', 'm-grid-option', label);
                    button.classList.toggle('m-selected', this.valuesFor(axis.key).includes(value));
                    button.addEventListener('click', () => toggle(value));
                    list.appendChild(button);
                }
            };
            renderOptions();
            body.appendChild(list);
        }
        else if (axis.kind == 'preset') {
            let search = mUI.el('input', 'm-grid-search');
            search.type = 'search';
            search.placeholder = 'Search presets';
            body.appendChild(search);
            let list = mUI.el('div', 'm-grid-options m-grid-preset-options');
            let settled = (mState.presets || []).length > 0;
            renderOptions = () => {
                list.innerHTML = '';
                let presets = mState.presets || [];
                if (!settled && presets.length == 0) {
                    list.appendChild(mUI.el('div', 'm-strip-empty', 'Loading presets...'));
                    return;
                }
                let term = search.value.trim().toLowerCase();
                let matches = presets.filter(preset => typeof MControlNet == 'undefined' || !MControlNet.isPreset(preset))
                    .filter(preset => !term
                    || `${preset.title} ${preset.description || ''} ${MGrid.shortValue(preset.title)}`.toLowerCase().includes(term));
                matches = [...matches].sort((a, b) => {
                    if (!!a.is_starred != !!b.is_starred) {
                        return a.is_starred ? -1 : 1;
                    }
                    return `${a.title}`.localeCompare(`${b.title}`);
                });
                if (matches.length == 0) {
                    list.appendChild(mUI.el('div', 'm-strip-empty', presets.length == 0
                        ? 'No presets yet.' : 'No presets match.'));
                    return;
                }
                let limit = typeof MPresets != 'undefined' && MPresets.PickerLimit ? MPresets.PickerLimit : 60;
                let shown = matches.slice(0, limit);
                for (let preset of shown) {
                    let label = MGrid.shortValue(preset.title);
                    if (preset.is_starred) {
                        label = `\u2605 ${label}`;
                    }
                    let button = mUI.el('button', 'm-grid-option', label);
                    button.title = preset.title;
                    button.dataset.preset = preset.title;
                    button.classList.toggle('m-selected', this.valuesFor(axis.key).includes(preset.title));
                    button.addEventListener('click', () => toggle(preset.title));
                    list.appendChild(button);
                }
                if (matches.length > shown.length) {
                    list.appendChild(mUI.el('div', 'm-list-count',
                        `${matches.length - shown.length} more - search to narrow.`));
                }
            };
            search.addEventListener('input', () => renderOptions());
            let dismissKb = () => {
                if (document.activeElement == search && search.blur) {
                    search.blur();
                }
            };
            list.addEventListener('scroll', dismissKb, { passive: true });
            // A press would otherwise move focus off the search, and closing the keyboard moves the sheet.
            list.addEventListener('mousedown', e => e.preventDefault());
            renderOptions();
            body.appendChild(list);
            // Boot may have loaded these already. Refresh anyway: a preset saved in the classic UI since
            // boot would otherwise be missing, and the grid is the first place that needs the new title.
            genericRequest('GetMyUserData', { 'includeAutocompletions': false }, data => {
                mState.presets = data.presets || [];
                settled = true;
                renderOptions();
            }, 0, error => {
                settled = true;
                list.innerHTML = '';
                list.appendChild(mUI.el('div', 'm-strip-empty', `Could not load presets: ${error}`));
            });
        }
        else if (axis.kind == 'lora') {
            let search = mUI.el('input', 'm-grid-search');
            search.type = 'search';
            search.placeholder = 'Search LoRAs';
            body.appendChild(search);
            let list = mUI.el('div', 'm-grid-options m-grid-lora-options');
            renderOptions = () => {
                list.innerHTML = '';
                if (!mCreate.loraList) {
                    list.appendChild(mUI.el('div', 'm-strip-empty', 'Loading LoRAs...'));
                    return;
                }
                let matches = mState.compatFirst(mState.starredFirst(
                    MCreate.filterModels(mCreate.loraList, search.value), 'LoRA'), 'LoRA');
                if (matches.length == 0) {
                    list.appendChild(mUI.el('div', 'm-strip-empty', 'No LoRAs match.'));
                    return;
                }
                // Bounded like every other picker in this client: the search above is faster than scrolling
                // a full library on a phone, and the count below says what is being held back.
                let shown = matches.slice(0, MGrid.LoraLimit);
                for (let model of shown) {
                    // Stripped, because a preset and the grid axis both store the extension-less form while
                    // ListModels reports 'ill/foo.safetensors'. Sending the listed name would make the axis
                    // value disagree with what the same LoRA looks like everywhere else in the app.
                    let value = MState.stripModelExt(model.name);
                    let button = mUI.el('button', 'm-grid-option');
                    button.appendChild(MGrid.tailLabel(mUI.modelName(value)));
                    button.classList.toggle('m-selected', this.valuesFor(axis.key).includes(value));
                    if (!mState.rowMatchesActive(model, 'LoRA')) {
                        button.classList.add('m-model-unavailable');
                        button.title = 'Incompatible with current model';
                    }
                    button.addEventListener('click', () => toggle(value));
                    list.appendChild(button);
                }
                if (matches.length > shown.length) {
                    list.appendChild(mUI.el('div', 'm-list-count',
                        `${matches.length - shown.length} more - search to narrow.`));
                }
            };
            MCreate.bindSearchInput(search, () => {
                renderOptions();
                let term = `${search.value || ''}`.trim();
                if (term && mCreate.searchLoraMetadata) {
                    mCreate.searchLoraMetadata(term, () => {
                        if (`${search.value || ''}`.trim().toLowerCase() == term.toLowerCase()) {
                            renderOptions();
                        }
                    });
                }
            });
            // Scrolling the results means hunting a row, so the keyboard gets out of the way. Only a real
            // scroll counts: touchmove also fires on the small finger movement inside an ordinary tap.
            let dismissKb = () => {
                if (document.activeElement == search && search.blur) {
                    search.blur();
                }
            };
            list.addEventListener('scroll', dismissKb, { passive: true });
            // A press would otherwise move focus off the search, and closing the keyboard moves the sheet.
            list.addEventListener('mousedown', e => e.preventDefault());
            renderOptions();
            body.appendChild(list);
            // The Create tab loads this list when its own LoRA sheet is opened, which may never have
            // happened in this session. enrichLoraMetadata indexes the boot corpus immediately, then
            // fetches the first metadata page. Render the corpus now and again when it settles.
            if (!mCreate.loraList) {
                let settled = false;
                mCreate.enrichLoraMetadata((failed, error) => {
                    settled = true;
                    if (failed && (!mCreate.loraList || mCreate.loraList.length == 0)) {
                        list.innerHTML = '';
                        list.appendChild(mUI.el('div', 'm-strip-empty', `Could not load LoRAs: ${error}`));
                        return;
                    }
                    renderOptions();
                });
                if (!settled) {
                    renderOptions();
                }
            }
        }
        renderChosen();
    }

    /** How many LoRA rows the picker renders at once. Truncation is reported, never silent. */
    static LoraLimit = 40;

    /** A value as it reads on a chip: the last path segment, so 'ill/style/foo' is 'foo'. */
    static shortValue(value) {
        let text = `${value}`;
        let slash = text.lastIndexOf('/');
        return slash >= 0 ? text.substring(slash + 1) : text;
    }

    /** A one-line label that cuts from the start when too long: a LoRA's version is at the end of its name.
     * The bdi keeps the name reading left to right inside the right-to-left box that makes the cut. */
    static tailLabel(text) {
        let label = mUI.el('span', 'm-grid-tail');
        label.appendChild(mUI.el('bdi', '', text));
        return label;
    }

    /** How one axis value reads on a chip or summary. */
    static valueLabel(axis, value) {
        if (axis.key == 'loraconfinement') {
            return MCreate.loraSectionLabel(value);
        }
        return axis.kind == 'text' ? `${value}` : MGrid.shortValue(value);
    }

    /** One line naming an axis's values, truncated by count rather than by characters so the summary never
     * ends mid-name. */
    static summarise(values, axis) {
        let shown = values.slice(0, 3).map(v => MGrid.valueLabel(axis, v));
        return values.length > shown.length ? `${shown.join(', ')}, +${values.length - shown.length}`
            : shown.join(', ');
    }
}

mGrid = new MGrid();
mGrid.install();
