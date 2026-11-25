/** MobileEnhancements standalone client - grid builder.
 *
 * Replaces the generic axis form that used to sit behind the Generate long-press. That form was the classic
 * UI's model shrunk onto a phone: pick a parameter id from a dropdown, then type its values as comma-
 * separated text. It technically covered everything and was usable for nothing - the values that matter most
 * here are LoRA paths and sampler ids, which nobody types correctly from memory on a phone keyboard.
 *
 * This is the same GridGenRun call with a built surface instead: fixed axes, each with a picker suited
 * to its own type. Preset is the shared [Grid Gen] Presets axis (mode gridgenpresets): one selected title
 * per cell, applied on the server on top of the Create tab. The picker groups those titles by the folder
 * in front of the first slash, because the same name is saved in more than one folder. A model axis is
 * deliberately not here - a grid over that is a desk job, and the classic UI is one tap away in More.
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
            hint: 'The first value is the text to find in the prompt, and it stays as the first cell. Each other value replaces it. Paste a key || value || value list to set the whole axis.' },
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

    /** Axis values. Absent means no axes. */
    static SelectedKey = 'm_client_grid_selected';

    /** 'grid' or absent. Absent is Single. */
    static ModeKey = 'm_client_grid_mode';

    /** Contact-sheet row count. Absent or 0 is Auto. */
    static RowsKey = 'm_client_grid_rows';

    /** Axis keys the user left open. Sections start collapsed, so a missing key is collapsed
     * and only an opened section is stored. */
    static OpenKey = 'm_client_grid_open';

    /** Merged grid image. Absent means on, which is the default. '0' means off: each cell still saves. */
    static CompositeKey = 'm_client_grid_composite';

    /** Values selected per axis key, saved so a second run that changes one axis does not mean rebuilding
     * all of them, and so Grid mode's Generate button has something to run after a reload. */
    constructor() {
        this.selected = MGrid.loadSelected();
        /** Preferred contact-sheet row count. 0 = Auto (most values on X — never vertical). */
        this.rows = MGrid.loadRowsPref();
        /** Grid mode: the Create tab's Generate button runs the saved axes instead of one batch. */
        this.active = MGrid.loadActive();
        /** Axis key -> true when that section was left open. Missing means collapsed. */
        this.openSections = MGrid.loadOpenSections();
        /** True when the user wants the merged grid image. More than three axes still skips it. */
        this.composite = MGrid.loadComposite();
        /** The grid sheet element while it is on screen, so a reset can rebuild it in place. */
        this.sheetContent = null;
        this.sheetClose = null;
        /** True while a run is resolving its backend, so a double tap cannot start two grids. */
        this.starting = false;
    }

    /** Drops every persisted Simple grid setting. An absent key is the default. */
    static clearStorage() {
        for (let key of [MGrid.SelectedKey, MGrid.ModeKey, MGrid.RowsKey, MGrid.OpenKey, MGrid.CompositeKey]) {
            try {
                localStorage.removeItem(key);
            }
            catch (e) {
                /* private mode */
            }
        }
    }

    /** Saved axis values, keeping only known axes and text values. Empty on a missing or damaged entry. */
    static loadSelected() {
        try {
            let data = JSON.parse(localStorage.getItem(MGrid.SelectedKey) || '{}');
            let selected = {};
            for (let axis of MGrid.Axes) {
                if (Array.isArray(data[axis.key])) {
                    let values = data[axis.key].filter(v => typeof v == 'string');
                    // A saved Prompt Replace file is one string. Expand it so the chips match the cells.
                    if (axis.kind == 'text') {
                        values = MGrid.splitPromptReplace(values);
                    }
                    selected[axis.key] = values;
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
            localStorage.setItem(MGrid.SelectedKey, JSON.stringify(this.selected));
        }
        catch (e) {
            /* private mode / quota */
        }
    }

    /** Whether Grid mode was left on. */
    static loadActive() {
        try {
            return localStorage.getItem(MGrid.ModeKey) == 'grid';
        }
        catch (e) {
            return false;
        }
    }

    /** Turns Grid mode on or off, saves it, and repaints the Generate button. */
    setActive(active) {
        this.active = active;
        try {
            localStorage.setItem(MGrid.ModeKey, active ? 'grid' : 'single');
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

    /** The axis definition for a key, or null. */
    static axis(key) {
        for (let axis of MGrid.Axes) {
            if (axis.key == key) {
                return axis;
            }
        }
        return null;
    }

    /** Cells of an axis. A lone Prompt Replace value counts as one so the readout stays "1 image",
     * but isGridAxis still does not send it. */
    cellCount(axis) {
        if (!axis) {
            return 0;
        }
        return this.cellsFor(axis).length;
    }

    /** The one cell of an axis that is not being sent, or null when it is empty or a real grid axis. */
    oneCell(key) {
        let axis = MGrid.axis(key);
        if (this.cellCount(axis) != 1 || this.isGridAxis(axis)) {
            return null;
        }
        return this.cellsFor(axis)[0];
    }

    /** True when Strength or Section has two or more cells. Those axes append after the LoRA axis,
     * so a one-cell LoRA still has to be sent or the weight lines up with nothing. It multiplies by one. */
    loraDependentsVary() {
        return this.cellCount(MGrid.axis('loraweights')) >= 2 || this.cellCount(MGrid.axis('loraconfinement')) >= 2;
    }

    /** Whether this axis is sent as a grid axis. One cell is a fixed base param, except the LoRA case above. */
    isGridAxis(axis) {
        let count = this.cellCount(axis);
        if (count >= 2) {
            return true;
        }
        return axis.key == 'loras' && count == 1 && this.loraDependentsVary();
    }

    /** How many axes the payload will actually send. */
    sentAxisCount() {
        let count = 0;
        for (let axis of MGrid.Axes) {
            if (this.isGridAxis(axis)) {
                count++;
            }
        }
        return count;
    }

    /** A grid image has three slots (X, Y, Y2). More than that cannot ask for one. */
    compositeAllowed() {
        return this.sentAxisCount() <= 3;
    }

    /** Grid Image, unless the user turned the merged image off or more than three axes vary.
     * Both of those still generate every cell. */
    outputType() {
        if (!this.compositeAllowed() || !this.composite) {
            return 'Just Images';
        }
        return 'Grid Image';
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

    /** The axes to send, or null after warning why they cannot be sent.
     * A one-cell axis is not included. applyFixed writes it onto the base instead. */
    buildAxes() {
        let axes = [];
        for (let axis of MGrid.Axes) {
            if (!this.isGridAxis(axis)) {
                continue;
            }
            let values = this.cellsFor(axis);
            if (axis.kind == 'text') {
                // The server splits each cell on its first '=', so find text cannot contain one.
                if (values[0].includes('=')) {
                    mUI.warn(`${axis.label}: the first value cannot contain "=".`);
                    return null;
                }
                // Always the explicit find=value form: the server only builds it itself when no value
                // contains '=', so one replacement with an '=' in it would break the implicit form.
                axes.push({ 'mode': axis.mode, 'vals': values.map(v => `${values[0]}=${v}`).join(axis.separator) });
            }
            else {
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
                // Re-read so a run from the Generate button matches the stored choice, not a stale copy.
                // More than three axes still forces Just Images inside outputType().
                this.composite = MGrid.loadComposite();
                let outputType = this.outputType();
                mGen.runGrid(base, axes, { 'rows': this.rows, 'outputType': outputType });
                let sheet = outputType == 'Just Images' ? ' No combined grid image.' : '';
                mUI.note(`Grid started: ${this.totalImages()} images.${sheet}`);
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
            let raw = localStorage.getItem(MGrid.RowsKey);
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
            localStorage.setItem(MGrid.RowsKey, `${rows}`);
        }
        catch (e) {
            /* private mode / quota */
        }
    }

    /** True when the merged grid image is wanted. A missing key is on. */
    static loadComposite() {
        try {
            return localStorage.getItem(MGrid.CompositeKey) != '0';
        }
        catch (e) {
            return true;
        }
    }

    /** Stores the merged-image choice. On removes the key so the default stays "absent". */
    static saveComposite(on) {
        try {
            if (on) {
                localStorage.removeItem(MGrid.CompositeKey);
            }
            else {
                localStorage.setItem(MGrid.CompositeKey, '0');
            }
        }
        catch (e) {
            /* private mode / quota */
        }
    }

    /** Sections the user left open. Unknown keys and anything other than true are dropped.
     * A missing or damaged entry is every section collapsed, which is also the first-open default. */
    static loadOpenSections() {
        try {
            let data = JSON.parse(localStorage.getItem(MGrid.OpenKey) || '{}');
            let open = {};
            if (!data || typeof data != 'object' || Array.isArray(data)) {
                return open;
            }
            for (let axis of MGrid.Axes) {
                if (typeof data[axis.key] == 'boolean' && data[axis.key]) {
                    open[axis.key] = true;
                }
            }
            return open;
        }
        catch (e) {
            return {};
        }
    }

    /** Whether this section should open. Default is collapsed. */
    isSectionOpen(key) {
        return this.openSections[key] === true;
    }

    /** Remembers one section. Closing the last open section removes the key so the default stays "absent". */
    setSectionOpen(key, open) {
        if (open) {
            this.openSections[key] = true;
        }
        else {
            delete this.openSections[key];
        }
        try {
            if (Object.keys(this.openSections).length == 0) {
                localStorage.removeItem(MGrid.OpenKey);
            }
            else {
                localStorage.setItem(MGrid.OpenKey, JSON.stringify(this.openSections));
            }
        }
        catch (e) {
            /* private mode / quota */
        }
    }

    /** Clears axes, Grid mode, rows, remembered section state, and the merged-image choice, then
     * repaints an open grid sheet and the Generate button. Other client prefs are left alone. */
    reset() {
        this.selected = {};
        this.rows = 0;
        this.active = false;
        this.openSections = {};
        this.composite = true;
        MGrid.clearStorage();
        if (this.sheetContent && this.sheetContent.isConnected) {
            this.fillSheet(this.sheetContent, this.sheetClose || (() => {}));
        }
        this.syncModeSheet();
        if (typeof mCreate != 'undefined' && mCreate.renderGenTarget) {
            mCreate.renderGenTarget();
        }
    }

    /** The Generate-on sheet's Single/Grid choice is built once. A reset has to move the highlight
     * itself, or the sheet keeps showing Grid after the mode is already Single. */
    syncModeSheet() {
        for (let group of document.querySelectorAll('.m-gen-mode')) {
            for (let button of group.querySelectorAll('.m-seg-button')) {
                button.classList.toggle('m-selected', (button.textContent == 'Grid') == !!this.active);
            }
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

    /** Cells of one axis. Prompt Replace expands a `key || a || b` value into one cell per piece, so a
     * pasted grid file counts as the axis it is. Every other axis returns its stored values unchanged. */
    cellsFor(axis) {
        let values = this.valuesFor(axis.key);
        if (axis.kind != 'text') {
            return values;
        }
        return MGrid.splitPromptReplace(values);
    }

    /** Splits prompt-replace values on `||`. A value without that separator stays one cell. Blank pieces
     * are dropped. One remaining cell is not a runnable axis; callers decide that. */
    static splitPromptReplace(values) {
        let cells = [];
        for (let value of values) {
            let text = `${value}`;
            if (!text.includes('||')) {
                if (text.trim() != '') {
                    cells.push(text);
                }
                continue;
            }
            let parts = text.split('||');
            for (let part of parts) {
                let trimmed = part.trim();
                if (trimmed != '') {
                    cells.push(trimmed);
                }
            }
        }
        return cells;
    }

    /** How many images the current selection would produce: the product of the multi-value axes only.
     * A one-cell axis is pinned on the base and does not multiply. No multi-value axis is one image when
     * something is pinned, and zero when nothing is set. */
    totalImages() {
        let total = 1;
        let multi = 0;
        let fixed = false;
        for (let axis of MGrid.Axes) {
            let count = this.cellCount(axis);
            if (count >= 2) {
                total *= count;
                multi++;
            }
            else if (count == 1) {
                fixed = true;
            }
        }
        if (multi == 0) {
            return fixed ? 1 : 0;
        }
        return total;
    }

    /** Fills a grid sheet element. `close` dismisses that sheet. Reset calls this again on the open element
     * so the summaries, rows, and which sections are open match the cleared defaults without a second sheet. */
    fillSheet(content, close) {
        let previousTitle = content.querySelector('.m-sheet-title');
        let titleId = previousTitle && previousTitle.id ? previousTitle.id : '';
        content.innerHTML = '';
        let title = mUI.el('div', 'm-sheet-title', 'Grid Generate');
        if (titleId) {
            title.id = titleId;
        }
        content.appendChild(title);
        content.appendChild(mUI.el('div', 'm-grid-intro',
            'Runs every combination of the axes you fill in. Everything else comes from the Create tab as it '
            + 'stands right now.'));
        let cards = mUI.el('div', 'm-grid-cards');
        content.appendChild(cards);
        let summaries = {};
        for (let axis of MGrid.Axes) {
            let card = mUI.el('details', 'm-grid-card');
            // Set before the toggle listener, so restoring a remembered section does not write it again.
            if (this.isSectionOpen(axis.key)) {
                card.open = true;
            }
            let head = mUI.el('summary', 'm-grid-card-head');
            // The native disclosure marker is hidden. This chevron is the visible open/closed affordance.
            // The summary itself is still the toggle, so keyboard and screen-reader behavior stays native.
            let chevron = mUI.el('span', 'm-grid-card-chevron');
            chevron.setAttribute('aria-hidden', 'true');
            head.appendChild(chevron);
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
            card.addEventListener('toggle', () => {
                this.setSectionOpen(axis.key, card.open);
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
        let compositeRow = mUI.el('div', 'm-grid-layout');
        let compositeLabel = mUI.el('div', 'm-grid-layout-label', 'Grid Image');
        compositeRow.appendChild(compositeLabel);
        let compositeChoices = mUI.el('div', 'm-grid-layout-choices m-seg-group');
        compositeChoices.setAttribute('role', 'group');
        compositeChoices.setAttribute('aria-label', 'Grid Image');
        let paintComposite = () => {
            let allowed = this.compositeAllowed();
            let on = allowed && this.composite;
            for (let button of compositeChoices.querySelectorAll('.m-grid-composite-button')) {
                button.classList.toggle('m-selected', (button.dataset.composite == '1') == on);
                button.disabled = !allowed;
            }
            compositeLabel.title = allowed
                ? 'On builds one merged image. Off saves each cell only.'
                : 'A grid image holds 3 axes. This run saves each cell.';
        };
        for (let choice of [{ value: '1', label: 'On' }, { value: '0', label: 'Off' }]) {
            let button = mUI.el('button', 'm-grid-composite-button', choice.label);
            button.type = 'button';
            button.dataset.composite = choice.value;
            button.addEventListener('click', () => {
                if (!this.compositeAllowed()) {
                    return;
                }
                this.composite = choice.value == '1';
                MGrid.saveComposite(this.composite);
                renderSummaries();
            });
            compositeChoices.appendChild(button);
        }
        compositeRow.appendChild(compositeChoices);
        footer.appendChild(compositeRow);
        let runButton = mUI.el('button', 'm-generate-button m-grid-run', 'Run Grid');
        footer.appendChild(runButton);
        content.appendChild(footer);
        let renderSummaries = () => {
            for (let axis of MGrid.Axes) {
                let values = this.cellsFor(axis);
                summaries[axis.key].textContent = values.length == 0 ? 'off'
                    : `${values.length}: ${MGrid.summarise(values, axis)}`;
                summaries[axis.key].classList.toggle('m-grid-card-on', values.length > 0);
            }
            let total = this.totalImages();
            let needsLora = this.needsLoraAxis();
            let combined = total >= 2 && this.outputType() == 'Just Images' ? ', no combined grid image' : '';
            count.textContent = needsLora ? 'Pick a LoRA in the LoRAs axis first.'
                : total == 0 ? 'No axes set yet.'
                : `${total} image${total == 1 ? '' : 's'}${combined}`;
            paintComposite();
            // Disabled rather than hidden, and the count above says why: a Run button that vanishes reads as
            // a bug, while one that is visibly unavailable next to "No axes set yet" explains itself.
            runButton.disabled = !this.isReady();
        };
        renderSummaries();
        runButton.type = 'button';
        runButton.addEventListener('click', () => this.run(() => close()));
    }

    /** The grid sheet. */
    open() {
        if (!MGrid.permitted()) {
            mUI.warn('You do not have grid generation permission.');
            return;
        }
        this.composite = MGrid.loadComposite();
        let content = mUI.el('div', 'm-grid-sheet');
        let close = () => {};
        this.fillSheet(content, () => close());
        close = mUI.openSheet(content, () => {
            if (this.sheetContent == content) {
                this.sheetContent = null;
                this.sheetClose = null;
            }
        });
        this.sheetContent = content;
        this.sheetClose = close;
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
        this.applyFixed(base);
        return base;
    }

    /** Writes one-cell axes onto the base. Strength and Section land on the LoRA list: on the one LoRA
     * when that axis is not sent, or as the trailing entries the server lines up with each LoRA cell. */
    applyFixed(base) {
        let lora = MGrid.axis('loras');
        if (this.cellCount(lora) == 1 && !this.isGridAxis(lora)) {
            this.pinLora(base, this.cellsFor(lora)[0]);
        }
        else if (this.isGridAxis(lora)) {
            let extra = this.loraCellWidth();
            let weight = this.oneCell('loraweights');
            let section = this.oneCell('loraconfinement');
            if (weight != null) {
                this.appendLoraList(base, 'loraweights', weight, '1', extra);
            }
            if (section != null) {
                this.appendLoraList(base, 'lorasectionconfinement', section, '0', extra);
            }
        }
        for (let axis of MGrid.Axes) {
            if (axis.key == 'loras' || axis.key == 'loraweights' || axis.key == 'loraconfinement' || axis.kind == 'text') {
                continue;
            }
            if (this.cellCount(axis) != 1) {
                continue;
            }
            let value = this.cellsFor(axis)[0];
            if (axis.mode == 'aspectratio' && MState.AspectReferences[value]) {
                base['aspectratio'] = value;
                base['sidelength'] = `${mState.resolveSideLength(base)}`;
                delete base['width'];
                delete base['height'];
            }
            else {
                base[axis.mode] = value;
            }
        }
    }

    /** How many LoRAs the widest LoRA cell appends. One name is one. A comma stack inside a cell is more. */
    loraCellWidth() {
        let width = 1;
        for (let cell of this.cellsFor(MGrid.axis('loras'))) {
            let count = MState.toList(cell).length;
            if (count > width) {
                width = count;
            }
        }
        return width;
    }

    /** Appends the one LoRA cell onto the base, with its one strength and section when those are set. */
    pinLora(base, cell) {
        let weight = this.oneCell('loraweights');
        let section = this.oneCell('loraconfinement');
        let names = MState.toList(base['loras']);
        let weights = MState.toList(base['loraweights']);
        while (weights.length < names.length) {
            weights.push('1');
        }
        let confs = MState.toList(base['lorasectionconfinement']);
        for (let name of MState.toList(cell)) {
            names.push(name);
            weights.push(weight != null ? weight : '1');
            if (section != null) {
                while (confs.length < names.length - 1) {
                    confs.push('0');
                }
                confs.push(section);
            }
        }
        base['loras'] = names;
        base['loraweights'] = weights;
        if (section != null) {
            base['lorasectionconfinement'] = confs;
        }
    }

    /** Pads a LoRA-parallel list out to the base LoRAs, then appends `value` once per axis LoRA in the cell. */
    appendLoraList(base, key, value, pad, extra) {
        let list = MState.toList(base[key]);
        let names = MState.toList(base['loras']);
        while (list.length < names.length) {
            list.push(pad);
        }
        for (let i = 0; i < extra; i++) {
            list.push(value);
        }
        base[key] = list;
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
            add.type = 'button';
            let commit = () => {
                // Prompt text carries its own commas, so a text value is one whole entry. `||` is the
                // grid-file separator, and that list is the whole axis rather than one value.
                let added = (axis.kind == 'text' ? [`${input.value}`] : `${input.value}`.split(','))
                    .map(v => v.trim()).filter(v => v != '');
                if (axis.kind == 'text') {
                    added = MGrid.splitPromptReplace(added);
                }
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
            // Enter adds the typed value, the same way the button does. Search fields are not this input.
            // IME uses Enter to confirm a candidate (isComposing, or keyCode 229); that must not insert it.
            input.addEventListener('keydown', event => {
                if (event.key != 'Enter') {
                    return;
                }
                if (event.isComposing || event.keyCode == 229) {
                    return;
                }
                event.preventDefault();
                commit();
            });
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
                    .filter(preset => MGrid.presetMatches(preset, term));
                if (matches.length == 0) {
                    list.appendChild(mUI.el('div', 'm-strip-empty', presets.length == 0
                        ? 'No presets yet.' : 'No presets match.'));
                    return;
                }
                // Cap with the same starred-first order as before, then group what fit. A starred preset
                // in a later folder still gets a slot; the header is only there so the short name is readable.
                let limit = typeof MPresets != 'undefined' && MPresets.PickerLimit ? MPresets.PickerLimit : 60;
                let shown = [...matches].sort(MGrid.comparePresets).slice(0, limit);
                for (let group of MGrid.groupPresets(shown)) {
                    list.appendChild(mUI.el('div', 'm-grid-folder', group.label));
                    for (let preset of group.presets) {
                        let label = MGrid.presetButtonLabel(preset.title);
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

    /** Folder in a preset title ('krea/Realism' -> 'krea'). A title with no slash is a root preset. */
    static presetFolder(title) {
        return MState.presetGroup(title);
    }

    /** Name under a folder header: everything after the first slash. A root title is unchanged. */
    static presetButtonLabel(title) {
        let text = `${title || ''}`;
        let slash = text.indexOf('/');
        if (slash < 0 || slash >= text.length - 1) {
            return text;
        }
        return text.substring(slash + 1);
    }

    /** True when the search is empty or hits the title, its folder, the short name, or the description. */
    static presetMatches(preset, term) {
        if (!term) {
            return true;
        }
        let title = `${preset.title || ''}`;
        let hay = `${title} ${MGrid.presetFolder(title)} ${preset.description || ''} ${MGrid.shortValue(title)}`;
        return hay.toLowerCase().includes(term);
    }

    /** Starred first, then title. The same order the preset list used before folder headers. */
    static comparePresets(a, b) {
        if (!!a.is_starred != !!b.is_starred) {
            return a.is_starred ? -1 : 1;
        }
        return `${a.title}`.localeCompare(`${b.title}`);
    }

    /** Named folders in order, then root titles under Other. Starred still lead inside each folder. */
    static groupPresets(presets) {
        let buckets = new Map();
        for (let preset of presets) {
            let folder = MGrid.presetFolder(preset.title);
            if (!buckets.has(folder)) {
                buckets.set(folder, []);
            }
            buckets.get(folder).push(preset);
        }
        let folders = [...buckets.keys()].filter(folder => folder != '');
        folders.sort((a, b) => a.localeCompare(b));
        if (buckets.has('')) {
            folders.push('');
        }
        let groups = [];
        for (let folder of folders) {
            let items = buckets.get(folder);
            items.sort(MGrid.comparePresets);
            groups.push({ folder: folder, label: folder == '' ? 'Other' : folder, presets: items });
        }
        return groups;
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
        // Preset values are the full title, folder included. Shortening them made krea/Realism and
        // krea-lf/Realism the same chip and the same summary line.
        if (axis.kind == 'preset') {
            return `${value}`;
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
