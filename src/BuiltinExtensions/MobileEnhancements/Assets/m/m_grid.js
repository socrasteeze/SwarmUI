/** MobileEnhancements standalone client - grid builder.
 *
 * Replaces the generic axis form that used to sit behind the Generate long-press. That form was the classic
 * UI's model shrunk onto a phone: pick a parameter id from a dropdown, then type its values as comma-
 * separated text. It technically covered everything and was usable for nothing - the values that matter most
 * here are LoRA paths and sampler ids, which nobody types correctly from memory on a phone keyboard.
 *
 * This is the same GridGenRun call with a built surface instead: five fixed axes, each with a picker suited
 * to its own type. Model, prompt and resolution axes are deliberately not here - a grid over those is a
 * desk job, and the classic UI is one tap away in More.
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
        { key: 'loras', mode: 'loras', label: 'LoRAs', kind: 'lora', separator: '||',
            hint: 'One cell per LoRA. Weight is left at the model default.' },
        { key: 'steps', mode: 'steps', label: 'Steps', kind: 'number', separator: ',',
            quick: ['4', '8', '16', '20', '30', '40'] },
        { key: 'cfgscale', mode: 'cfgscale', label: 'CFG Scale', kind: 'number', separator: ',',
            quick: ['1', '1.5', '2', '3.5', '5', '7'] },
        { key: 'sampler', mode: 'sampler', label: 'Sampler', kind: 'choice', separator: ',',
            hint: 'Euler, DPM++, ER-SDE and the rest live here.' },
        { key: 'scheduler', mode: 'scheduler', label: 'Scheduler', kind: 'choice', separator: ',',
            hint: 'Pairs with the Sampler above - normal, karras, beta.' }
    ];

    /** Values selected per axis key, kept across openings of the sheet within one session so a second run
     * that changes one axis does not mean rebuilding all of them. */
    constructor() {
        this.selected = {};
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
        if (typeof permissions != 'undefined' && permissions.hasPermission
            && !permissions.hasPermission('gridgen_generate_grids')) {
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
            this.buildAxisBody(axis, body, () => renderSummaries());
            cards.appendChild(card);
        }
        let footer = mUI.el('div', 'm-grid-footer');
        let count = mUI.el('div', 'm-grid-count');
        footer.appendChild(count);
        let runButton = mUI.el('button', 'm-generate-button m-grid-run', 'Run Grid');
        footer.appendChild(runButton);
        content.appendChild(footer);
        let renderSummaries = () => {
            for (let axis of MGrid.Axes) {
                let values = this.valuesFor(axis.key);
                summaries[axis.key].textContent = values.length == 0 ? 'off'
                    : `${values.length}: ${MGrid.summarise(values)}`;
                summaries[axis.key].classList.toggle('m-grid-card-on', values.length > 0);
            }
            let total = this.totalImages();
            count.textContent = total == 0 ? 'No axes set yet.'
                : `${total} image${total == 1 ? '' : 's'}`;
            // Disabled rather than hidden, and the count above says why: a Run button that vanishes reads as
            // a bug, while one that is visibly unavailable next to "No axes set yet" explains itself.
            runButton.disabled = total < 2;
        };
        renderSummaries();
        runButton.addEventListener('click', () => {
            let axes = [];
            for (let axis of MGrid.Axes) {
                let values = this.valuesFor(axis.key);
                if (values.length > 0) {
                    axes.push({ 'mode': axis.mode, 'vals': values.join(axis.separator) });
                }
            }
            if (axes.length == 0) {
                mUI.warn('Fill in at least one axis first.');
                return;
            }
            let base = this.buildBase();
            mGen.runGrid(base, axes);
            mUI.note(`Grid started: ${this.totalImages()} images.`);
            close();
        });
        let close = mUI.openSheet(content);
        return close;
    }

    /** Base parameters for the run: the Create tab as it stands, minus what the grid itself decides.
     *
     * `images` goes because the batch count would multiply every cell. The LoRA pair goes ONLY when a LoRA
     * axis is set, and that one matters: GridGenerator registers loras/loraweights as comma-stackable, so an
     * axis value is APPENDED to whatever the base already carries rather than replacing it. Left in, a grid
     * meant to compare LoRA A against LoRA B would run "current stack + A" against "current stack + B" - the
     * comparison still looks right and is measuring the wrong thing. */
    buildBase() {
        let base = mState.buildGenInput();
        delete base['images'];
        if (this.valuesFor('loras').length > 0) {
            delete base['loras'];
            delete base['loraweights'];
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
                let chip = mUI.el('span', 'm-grid-chip', MGrid.shortValue(value));
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
        if (axis.kind == 'number') {
            let quickRow = mUI.el('div', 'm-grid-quick');
            renderOptions = () => {
                quickRow.innerHTML = '';
                for (let value of axis.quick) {
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
            input.inputMode = 'decimal';
            input.placeholder = 'Other values, comma separated';
            customRow.appendChild(input);
            let add = mUI.el('button', 'm-grid-add-button', 'Add');
            let commit = () => {
                let added = `${input.value}`.split(',').map(v => v.trim()).filter(v => v != '');
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
                let meta = mState.paramMeta[axis.mode];
                let options = meta && meta.values ? meta.values : [];
                if (options.length == 0) {
                    list.appendChild(mUI.el('div', 'm-strip-empty',
                        `The server has not reported any ${axis.label.toLowerCase()} values.`));
                    return;
                }
                for (let i = 0; i < options.length; i++) {
                    let value = options[i];
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
                let matches = mState.starredFirst(
                    MCreate.filterModels(mCreate.loraList, search.value), 'LoRA');
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
                    let button = mUI.el('button', 'm-grid-option', mUI.modelName(value));
                    button.classList.toggle('m-selected', this.valuesFor(axis.key).includes(value));
                    button.addEventListener('click', () => toggle(value));
                    list.appendChild(button);
                }
                if (matches.length > shown.length) {
                    list.appendChild(mUI.el('div', 'm-list-count',
                        `${matches.length - shown.length} more - search to narrow.`));
                }
            };
            search.addEventListener('input', () => renderOptions());
            renderOptions();
            body.appendChild(list);
            // The Create tab loads this list when its own LoRA sheet is opened, which may never have
            // happened in this session. Fetched here rather than at boot: the grid sheet is the first place
            // that needs it and the request is not free.
            if (!mCreate.loraList) {
                genericRequest('ListModels', { 'path': '', 'depth': MCreate.ListDepth, 'subtype': 'LoRA',
                    'sortBy': 'Name', 'allowRemote': true, 'sortReverse': false, 'dataImages': false }, data => {
                    mCreate.indexLoras(data.files || []);
                    renderOptions();
                }, 0, error => {
                    list.innerHTML = '';
                    list.appendChild(mUI.el('div', 'm-strip-empty', `Could not load LoRAs: ${error}`));
                });
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

    /** One line naming an axis's values, truncated by count rather than by characters so the summary never
     * ends mid-name. */
    static summarise(values) {
        let shown = values.slice(0, 3).map(v => MGrid.shortValue(v));
        return values.length > shown.length ? `${shown.join(', ')}, +${values.length - shown.length}`
            : shown.join(', ');
    }
}

mGrid = new MGrid();
mGrid.install();
