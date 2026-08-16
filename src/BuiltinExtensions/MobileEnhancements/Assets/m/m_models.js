/** MobileEnhancements standalone client - thin Models tab.
 * Browse checkpoints and LoRAs via ListModels; tap a checkpoint to set it as the generation model, tap a
 * LoRA to add it to the active set. No editing/downloading here - that stays in the full UI. */
class MModels {

    constructor() {
        /** Current subtype ('Stable-Diffusion' or 'LoRA'). */
        this.subtype = 'Stable-Diffusion';
        /** Current folder path within the subtype. */
        this.folder = '';
    }

    /** Builds the Models panel once. */
    build(panel) {
        this.panel = panel;
        let toggle = mUI.el('div', 'm-seg-group m-models-toggle');
        for (let [label, sub] of [['Checkpoints', 'Stable-Diffusion'], ['LoRAs', 'LoRA']]) {
            let btn = mUI.el('button', 'm-seg-button', label);
            btn.dataset.subtype = sub;
            btn.addEventListener('click', () => {
                this.subtype = sub;
                this.folder = '';
                this.refresh();
            });
            toggle.appendChild(btn);
        }
        panel.appendChild(toggle);
        this.toggle = toggle;
        this.folderChips = mUI.el('div', 'm-folder-chips');
        panel.appendChild(this.folderChips);
        this.grid = mUI.el('div', 'm-model-grid');
        panel.appendChild(this.grid);
    }

    /** Every activation: fetch fresh (models change rarely; the call is cheap at depth 1). */
    onShow() {
        this.refresh();
    }

    /** Fetches and renders the current folder. */
    refresh() {
        for (let btn of this.toggle.querySelectorAll('.m-seg-button')) {
            btn.classList.toggle('m-selected', btn.dataset.subtype == this.subtype);
        }
        this.grid.innerHTML = '';
        this.grid.appendChild(mUI.el('div', 'm-strip-empty', 'Loading...'));
        genericRequest('ListModels', { 'path': this.folder, 'depth': 1, 'subtype': this.subtype, 'sortBy': 'Name', 'allowRemote': true, 'sortReverse': false, 'dataImages': false }, data => {
            this.renderFolders(data.folders || []);
            this.grid.innerHTML = '';
            // Starred first, same as the Create-tab pickers and the genpage's own browsers. This list is one
            // folder deep rather than capped, so it is ordering for its own sake here, not rescuing rows from
            // a truncated list - but a favourite that sorts to the top in one place and the middle in another
            // is just two different apps.
            for (let model of mState.starredFirst(data.files || [], this.subtype)) {
                this.grid.appendChild(this.buildCard(model));
            }
            if ((data.files || []).length == 0) {
                this.grid.appendChild(mUI.el('div', 'm-strip-empty', 'No models here.'));
            }
        }, 0, err => {
            mUI.warn(`Could not list models: ${err}`);
        });
    }

    /** Folder chips with a back chip when nested. */
    renderFolders(folders) {
        this.folderChips.innerHTML = '';
        if (this.folder != '') {
            let up = mUI.el('button', 'm-folder-chip m-folder-up', '←');
            up.addEventListener('click', () => {
                this.folder = this.folder.includes('/') ? this.folder.substring(0, this.folder.lastIndexOf('/')) : '';
                this.refresh();
            });
            this.folderChips.appendChild(up);
            this.folderChips.appendChild(mUI.el('span', 'm-folder-current', this.folder));
        }
        for (let folder of folders) {
            let chip = mUI.el('button', 'm-folder-chip', folder);
            chip.addEventListener('click', () => {
                this.folder = this.folder == '' ? folder : `${this.folder}/${folder}`;
                this.refresh();
            });
            this.folderChips.appendChild(chip);
        }
    }

    /** One model card: preview, file name, metadata title, trigger phrase; tap = select (checkpoint) or
     * add (LoRA). Named by file rather than metadata title - see mUI.modelName for why. */
    buildCard(model) {
        let card = mUI.el('div', 'm-model-card');
        let thumb = mUI.modelThumb(model, null);
        if (thumb) {
            card.appendChild(thumb);
        }
        let star = mUI.starBadge(this.subtype, model.name);
        if (star) {
            // On the card the star is a corner badge over the thumbnail rather than a row item - a card with
            // no preview image has nothing to overlay, so it sits in the corner of the card itself.
            star.classList.add('m-model-star-badge');
            card.appendChild(star);
        }
        card.appendChild(mUI.modelText(model, () => mCreate.insertTriggerTag()));
        if (this.subtype == 'Stable-Diffusion' && mState.params['model'] == model.name) {
            card.classList.add('m-selected');
        }
        card.addEventListener('click', () => {
            if (this.subtype == 'Stable-Diffusion') {
                mState.params['model'] = model.name;
                mState.changed();
                mUI.note(`Model set: ${mUI.modelName(model.name)}`);
                for (let other of this.grid.querySelectorAll('.m-model-card')) {
                    other.classList.remove('m-selected');
                }
                card.classList.add('m-selected');
            }
            else {
                let cur = mState.getLoras();
                if (!cur.some(l => l.name == model.name)) {
                    cur.push({ 'name': model.name, 'weight': model.lora_default_weight || 1 });
                    mState.setLoras(cur);
                }
                mUI.note(`LoRA added: ${mUI.modelName(model.name)}`);
            }
        });
        return card;
    }
}

mModels = new MModels();
