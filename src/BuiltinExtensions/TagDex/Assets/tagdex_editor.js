/** Shared native editor for Genpage and /simple custom-library records. */
class TagDexLibraryEditorClass {

    /** Creates one labelled field. */
    field(label, control) {
        let wrap = document.createElement('label');
        wrap.className = 'tagdex-editor-field';
        let text = document.createElement('span');
        text.textContent = label;
        wrap.append(text, control);
        return wrap;
    }

    /** Opens content as a Genpage modal or /simple sheet. */
    open(title, content, simple) {
        let root = document.createElement('div');
        root.className = 'tagdex-editor';
        let heading = document.createElement('h3');
        heading.textContent = title;
        root.append(heading, content);
        if (simple && typeof mUI != 'undefined') {
            return { root: root, close: mUI.openSheet(root) };
        }
        let dialog = document.createElement('dialog');
        dialog.className = 'tagdex-editor-dialog';
        dialog.appendChild(root);
        document.body.appendChild(dialog);
        dialog.addEventListener('close', () => dialog.remove(), { once: true });
        dialog.showModal();
        return { root: root, close: () => dialog.close() };
    }

    /** Opens a character add/edit form. */
    character(record, simple, saved) {
        let form = document.createElement('form');
        form.className = 'tagdex-editor-form';
        let name = document.createElement('input');
        name.required = true;
        name.value = record?.data.name || '';
        // Without this iOS offers "AutoFill Contact" on a field labelled Name.
        name.autocomplete = 'off';
        let series = document.createElement('input');
        series.value = record?.data.series || '';
        series.autocomplete = 'off';
        let archived = document.createElement('input');
        archived.type = 'checkbox';
        archived.checked = record?.data.archived || false;
        form.append(this.field('Name', name), this.field('Series', series));
        // Archiving hides an existing character from lists and blocks applying it, without deleting it. A new
        // character has nothing to hide yet, so the box only appears when editing.
        if (record) {
            form.append(this.field('Archived (hidden from lists, cannot be applied)', archived));
        }
        let actions = document.createElement('div');
        actions.className = 'tagdex-editor-actions';
        let save = document.createElement('button');
        save.type = 'submit';
        save.textContent = 'Save';
        let cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        actions.append(save, cancel);
        form.appendChild(actions);
        let opened = this.open(record ? 'Edit Character' : 'Add Character', form, simple);
        cancel.addEventListener('click', opened.close);
        form.addEventListener('submit', event => {
            event.preventDefault();
            let body = { data: { name: name.value.trim(), series: series.value.trim(), catalogue_ref: record?.data.catalogue_ref || null, archived: archived.checked } };
            if (record) {
                body.base_revision = record.revision;
            }
            genericRequest('TagDexLibrarySave', { action: record ? 'update_character' : 'create_character', id: record?.id || '', body: body }, data => {
                opened.close();
                if (record || !data.record) {
                    saved(data.record);
                    return;
                }
                // New characters start favorited, so they show under the Characters tab's favorites filter.
                // A failed favorite still counts as a saved character.
                let favorite = { target_kind: 'character', target_id: data.record.id, favorited: true };
                genericRequest('TagDexLibrarySave', { action: 'favorite', id: '', body: favorite },
                    () => saved(data.record), 0, () => saved(data.record));
            });
        });
    }

    /** Opens a variant editor with ordered archive-backed LoRA rows. */
    variant(character, record, simple, saved, clone = false) {
        let recipe = record?.data.recipe || { prompt: '', negative_prompt: '', base_family: '', checkpoint: '', loras: [] };
        let loras = recipe.loras.map(lora => ({ ...lora }));
        let form = document.createElement('form');
        form.className = 'tagdex-editor-form';
        let name = document.createElement('input');
        name.required = true;
        name.value = clone ? `${record.data.name} Copy` : (record?.data.name || '');
        let promptBox = document.createElement('textarea');
        promptBox.value = recipe.prompt || '';
        let negative = document.createElement('textarea');
        negative.value = recipe.negative_prompt || '';
        let family = document.createElement('input');
        family.value = recipe.base_family || '';
        let checkpoint = document.createElement('input');
        checkpoint.value = recipe.checkpoint || '';
        form.append(this.field('Name', name), this.field('Prompt', promptBox), this.field('Negative Prompt', negative),
            this.field('Base Family', family), this.field('Checkpoint', checkpoint));
        let stack = document.createElement('section');
        stack.className = 'tagdex-editor-stack';
        let stackTitle = document.createElement('h4');
        stackTitle.textContent = 'LoRA Stack';
        let rows = document.createElement('div');
        let draw = () => {
            rows.replaceChildren();
            for (let i = 0; i < loras.length; i++) {
                let lora = loras[i];
                let row = document.createElement('div');
                row.className = 'tagdex-editor-lora';
                let label = document.createElement('span');
                label.textContent = `${lora.name}${lora.version ? ` · ${lora.version}` : ''}`;
                let weight = document.createElement('input');
                weight.type = 'number';
                weight.min = '-2';
                weight.max = '2';
                weight.step = '0.05';
                weight.value = lora.weight ?? 1;
                weight.setAttribute('aria-label', 'Weight');
                weight.addEventListener('input', () => lora.weight = Number(weight.value));
                let up = this.action('Up', () => { if (i > 0) { [loras[i - 1], loras[i]] = [loras[i], loras[i - 1]]; draw(); } });
                let down = this.action('Down', () => { if (i + 1 < loras.length) { [loras[i + 1], loras[i]] = [loras[i], loras[i + 1]]; draw(); } });
                let remove = this.action('Remove', () => { loras.splice(i, 1); draw(); });
                row.append(label, weight, up, down, remove);
                rows.appendChild(row);
            }
        };
        draw();
        for (let lora of loras) {
            genericRequest('TagDexLibraryArchive', { sha: lora.archive_sha256 }, detail => {
                lora.base_family = (detail.model || {}).base_family || '';
            });
        }
        let search = document.createElement('input');
        search.type = 'search';
        search.placeholder = 'Search archive';
        search.setAttribute('aria-label', 'Archive Search');
        let results = document.createElement('div');
        results.className = 'tagdex-editor-results';
        let timer = null;
        search.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => genericRequest('TagDexLibraryArchive', { q: search.value, offset: 0, limit: 25 }, data => {
                results.replaceChildren();
                for (let model of data.results || []) {
                    let select = this.action('Add', () => genericRequest('TagDexLibraryArchive', { sha: model.archive_sha256 }, detail => {
                        let selected = detail.model || model;
                        if (!loras.some(item => item.archive_sha256 == selected.archive_sha256)) {
                            if (!family.value.trim() && selected.base_family) {
                                family.value = selected.base_family;
                            }
                            loras.push({ archive_sha256: selected.archive_sha256, weights_sha256: selected.weights_sha256 || null,
                                name: selected.name, version: selected.version || '', weight: selected.recommended_weight ?? 1,
                                base_family: selected.base_family || '', source: 'archive' });
                            draw();
                        }
                    }));
                    let row = document.createElement('div');
                    row.className = 'tagdex-editor-result';
                    let text = document.createElement('span');
                    text.textContent = `${model.name}${model.version ? ` · ${model.version}` : ''}`;
                    row.append(text, select);
                    results.appendChild(row);
                }
            }), 250);
        });
        stack.append(stackTitle, search, results, rows);
        form.appendChild(stack);
        let formError = document.createElement('div');
        formError.className = 'tagdex-editor-error';
        formError.setAttribute('role', 'alert');
        form.appendChild(formError);
        let actions = document.createElement('div');
        actions.className = 'tagdex-editor-actions';
        let save = document.createElement('button');
        save.type = 'submit';
        save.textContent = 'Save';
        let cancel = this.action('Cancel', () => opened.close());
        actions.append(save, cancel);
        form.appendChild(actions);
        let opened = this.open(clone ? 'Clone Variant' : (record ? 'Edit Variant' : 'Add Variant'), form, simple);
        form.addEventListener('submit', event => {
            event.preventDefault();
            let canonical = value => {
                let clean = `${value || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (['illustrious', 'illustriousxl', 'noob', 'noobai', 'pony', 'sdxl'].includes(clean) || clean.startsWith('stablediffusionxl')) {
                    return 'sdxl';
                }
                return clean;
            };
            let expectedFamily = canonical(family.value);
            if (loras.some(lora => lora.base_family && expectedFamily && canonical(lora.base_family) != expectedFamily)) {
                formError.textContent = 'The LoRA stack contains incompatible model families.';
                return;
            }
            formError.textContent = '';
            let characterId = record?.data.character_id || character.id;
            let data = { character_id: characterId, name: name.value.trim(), recipe: { prompt: promptBox.value,
                negative_prompt: negative.value, base_family: family.value.trim(), checkpoint: checkpoint.value.trim(), loras: loras },
                cover_image_id: clone ? null : (record?.data.cover_image_id || null), archived: false };
            let updating = record && !clone;
            let body = { data: data };
            if (updating) {
                body.base_revision = record.revision;
            }
            genericRequest('TagDexLibrarySave', { action: updating ? 'update_variant' : 'create_variant', id: updating ? record.id : characterId, body: body }, response => {
                opened.close();
                saved(response.record);
            });
        });
    }

    /** Creates a compact action button. */
    action(label, callback) {
        let button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', callback);
        return button;
    }

    /** Opens conflict review and resolves by an explicit retained revision. */
    review(simple, changed) {
        genericRequest('TagDexLibraryReview', { view: 'conflicts', offset: 0, limit: 250 }, data => {
            let content = document.createElement('div');
            content.className = 'tagdex-editor-conflicts';
            for (let conflict of data.results || []) {
                let block = document.createElement('section');
                let title = document.createElement('h4');
                title.textContent = conflict.kind;
                block.appendChild(title);
                for (let version of conflict.versions || []) {
                    let choose = this.action('Keep Version', () => genericRequest('TagDexLibrarySave', { action: 'resolve_conflict', id: conflict.id,
                        body: { heads: conflict.versions.map(item => item.revision), chosen_revision: version.revision } }, () => changed()));
                    let preview = document.createElement('pre');
                    preview.textContent = JSON.stringify(version.data, null, 2);
                    block.append(preview, choose);
                }
                content.appendChild(block);
            }
            if ((data.results || []).length == 0) {
                content.textContent = 'No conflicts.';
            }
            this.open('Conflict Review', content, simple);
        });
    }
}

tagDexLibraryEditor = new TagDexLibraryEditorClass();
