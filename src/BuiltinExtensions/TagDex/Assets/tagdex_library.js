/** Character-library browser shared by the Genpage TagDex tab. */
class TagDexLibraryClass {

    constructor() {
        /** Search debounce. */
        this.timer = null;
    }

    /** Installs the library panel when the TagDex tab exists. */
    init() {
        let search = document.getElementById('tagdex_library_search');
        if (!search) {
            return;
        }
        document.getElementById('tagdex_library_refresh').addEventListener('click', () => this.load());
        document.getElementById('tagdex_library_add').addEventListener('click', () => this.editCharacter(null));
        document.getElementById('tagdex_library_review').addEventListener('click', () => tagDexLibraryEditor.review(false, () => this.load()));
        search.addEventListener('input', () => {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.load(), 250);
        });
        this.load();
    }

    /** Loads a bounded character page. */
    load() {
        let q = document.getElementById('tagdex_library_search').value;
        this.status('Loading...');
        this.loadAllCharacters(q, data => {
            let results = document.getElementById('tagdex_library_results');
            results.innerHTML = '';
            for (let record of data.results || []) {
                results.appendChild(this.characterCard(record));
            }
            this.status((data.results || []).length == 0 ? 'No library characters found.' : `${data.total} characters`);
        }, error => this.status(error));
    }

    /** Loads every bounded character page without asking the server for an unbounded response. */
    loadAllCharacters(q, callback, error, offset = 0, rows = []) {
        genericRequest('TagDexLibraryCharacters', { q: q, offset: offset, limit: 250 }, data => {
            rows.push(...(data.results || []));
            if (rows.length < (data.total || 0) && (data.results || []).length > 0) {
                this.loadAllCharacters(q, callback, error, rows.length, rows);
                return;
            }
            callback({ ...data, results: rows });
        }, 0, error);
    }

    /** Builds one character and lazy variant list. */
    characterCard(record) {
        let card = document.createElement('article');
        card.className = 'tagdex-library-card';
        let title = document.createElement('button');
        title.className = 'basic-button tagdex-library-character';
        title.textContent = record.data.series ? `${record.data.name} · ${record.data.series}` : record.data.name;
        let variants = document.createElement('div');
        variants.className = 'tagdex-library-variants';
        title.addEventListener('click', () => {
            if (variants.childElementCount > 0) {
                variants.hidden = !variants.hidden;
                return;
            }
            genericRequest('TagDexLibraryCharacter', { id: record.id }, data => {
                for (let variant of data.variants || []) {
                    variants.appendChild(this.variantRow(variant));
                }
                if ((data.variants || []).length == 0) {
                    variants.textContent = 'No variants yet.';
                }
            }, 0, error => this.status(error));
        });
        let edit = document.createElement('button');
        edit.className = 'basic-button';
        edit.textContent = 'Edit';
        edit.dataset.requiredpermission = 'tagdex_manage';
        edit.addEventListener('click', () => this.editCharacter(record));
        let addVariant = document.createElement('button');
        addVariant.className = 'basic-button';
        addVariant.textContent = 'Add Variant';
        addVariant.dataset.requiredpermission = 'tagdex_manage';
        addVariant.addEventListener('click', () => this.editVariant(record, null));
        card.append(title, edit, addVariant);
        card.appendChild(variants);
        return card;
    }

    /** Builds one actionable variant row. */
    variantRow(record) {
        let row = document.createElement('div');
        row.className = 'tagdex-library-variant';
        let name = document.createElement('span');
        name.textContent = record.data.name;
        let state = document.createElement('span');
        state.className = 'tagdex-library-state';
        let apply = document.createElement('button');
        apply.className = 'basic-button';
        apply.textContent = 'Apply';
        apply.addEventListener('click', () => this.resolve(record, state, true));
        let check = document.createElement('button');
        check.className = 'basic-button';
        check.textContent = 'Check';
        check.addEventListener('click', () => this.resolve(record, state, false));
        let gallery = document.createElement('button');
        gallery.className = 'basic-button';
        gallery.textContent = 'Gallery';
        gallery.addEventListener('click', () => this.openGallery(record, row));
        let edit = document.createElement('button');
        edit.className = 'basic-button';
        edit.textContent = 'Edit';
        edit.dataset.requiredpermission = 'tagdex_manage';
        edit.addEventListener('click', () => this.editVariant(null, record));
        let clone = document.createElement('button');
        clone.className = 'basic-button';
        clone.textContent = 'Clone';
        clone.addEventListener('click', () => tagDexLibraryEditor.variant(null, record, false, () => this.load(), true));
        row.append(name, state, check, apply, gallery, edit, clone);
        return row;
    }

    /** Resolves a recipe and optionally applies the whole stack atomically. */
    resolve(record, state, apply) {
        state.textContent = 'Checking...';
        genericRequest('TagDexLibraryResolve', { variantId: record.id, revision: record.revision, model: document.getElementById('input_model')?.value || '' }, data => {
            let missing = (data.loras || []).filter(lora => lora.status == 'not_downloaded');
            let unverified = (data.loras || []).filter(lora => lora.status == 'unverified');
            let incompatible = (data.loras || []).filter(lora => lora.status == 'incompatible');
            if (data.checkpoint_status != 'ready') {
                state.textContent = data.checkpoint_status == 'incompatible' ? 'Checkpoint Incompatible' : 'Checkpoint Missing';
            }
            else {
                state.textContent = incompatible.length > 0 ? `${incompatible.length} Incompatible`
                    : (unverified.length > 0 ? `${unverified.length} Unverified`
                    : (missing.length == 0 ? 'Ready' : `${missing.length} Not Downloaded`));
            }
            this.downloadControls(record, state, missing);
            if (!apply) {
                return;
            }
            if (!data.ready) {
                this.status('Resolve every model conflict before applying this variant.');
                return;
            }
            try {
                this.applyRecipe(record.data.recipe, data.loras);
                this.status(`${record.data.name} applied.`);
            }
            catch (error) {
                this.status(error.message);
            }
        }, 0, error => {
            state.textContent = 'Unavailable';
            this.status(error);
        });
    }

    /** Renders one explicit download action per unresolved archive object. */
    downloadControls(record, state, missing) {
        let old = state.parentElement.querySelector('.tagdex-library-downloads');
        if (old) {
            old.remove();
        }
        if (missing.length == 0) {
            return;
        }
        let holder = document.createElement('span');
        holder.className = 'tagdex-library-downloads';
        for (let lora of missing) {
            let button = document.createElement('button');
            button.className = 'basic-button';
            button.textContent = 'Download';
            button.title = `${lora.name} ${lora.version || ''}`.trim();
            let socket = null;
            button.addEventListener('click', () => {
                if (socket) {
                    socket.send('{"signal":"cancel"}');
                    return;
                }
                button.disabled = true;
                socket = makeWSRequest('TagDexLibraryAcquire', { archiveSha256: lora.archive_sha256, name: lora.name, version: lora.version || '' }, data => {
                    if (data.current_percent != null) {
                        button.textContent = `${Math.round(data.current_percent * 100)}%`;
                    }
                    if (data.success) {
                        socket = null;
                        this.resolve(record, state, false);
                    }
                }, 0, error => {
                    button.disabled = false;
                    button.textContent = 'Retry';
                    socket = null;
                    this.status(error);
                });
                button.disabled = false;
                button.textContent = 'Cancel';
            });
            holder.appendChild(button);
        }
        state.parentElement.appendChild(holder);
    }

    /** Opens every image in a variant gallery with a reference action. */
    openGallery(record, row) {
        genericRequest('TagDexLibraryVariant', { id: record.id }, data => {
            let old = row.querySelector('.tagdex-library-gallery');
            if (old) {
                old.remove();
            }
            let gallery = document.createElement('div');
            gallery.className = 'tagdex-library-gallery';
            for (let image of data.images || []) {
                let item = document.createElement('span');
                let button = document.createElement('button');
                button.className = 'tagdex-library-image';
                button.title = 'Use Reference';
                genericRequest('TagDexLibraryImage', { sha: image.data.thumb_sha256, mime: image.data.mime }, loaded => {
                    let preview = document.createElement('img');
                    preview.src = loaded.image;
                    preview.alt = image.data.caption || record.data.name;
                    button.appendChild(preview);
                });
                button.addEventListener('click', () => genericRequest('TagDexLibraryImage', { sha: image.data.blob_sha256, mime: image.data.mime }, loaded => {
                    imagePromptAddImageData(loaded.image, 'image', loaded.image, `${record.data.name}.png`);
                    this.status('Reference added.');
                }));
                let cover = document.createElement('button');
                cover.className = 'basic-button';
                cover.textContent = 'Set Cover';
                cover.addEventListener('click', () => {
                    let updated = JSON.parse(JSON.stringify(record.data));
                    updated.cover_image_id = image.id;
                    genericRequest('TagDexLibrarySave', { action: 'update_variant', id: record.id, body: { base_revision: record.revision, data: updated } }, result => {
                        record = result.record;
                        this.status('Cover updated.');
                    }, 0, error => this.status(error));
                });
                item.append(button, cover);
                gallery.appendChild(item);
            }
            let upload = document.createElement('input');
            upload.type = 'file';
            upload.accept = 'image/png,image/jpeg,image/webp';
            upload.setAttribute('aria-label', 'Upload Image');
            upload.addEventListener('change', () => {
                let file = upload.files[0];
                if (!file) {
                    return;
                }
                let reader = new FileReader();
                reader.onload = () => genericRequest('TagDexLibrarySave', { action: 'upload_image', id: record.id, body: {
                    image: reader.result, caption: '', recipe_revision: null, recipe_snapshot: null
                } }, () => this.openGallery(record, row), 0, error => this.status(error));
                reader.readAsDataURL(file);
            });
            gallery.appendChild(upload);
            let generate = document.createElement('button');
            generate.className = 'basic-button';
            generate.textContent = 'Generate Reference';
            generate.dataset.requiredpermission = 'tagdex_manage';
            generate.addEventListener('click', () => this.generateReference(record, row, gallery, generate));
            gallery.appendChild(generate);
            if ((data.images || []).length == 0) {
                let empty = document.createElement('span');
                empty.textContent = 'No gallery images yet.';
                gallery.prepend(empty);
            }
            row.appendChild(gallery);
        }, 0, error => this.status(error));
    }

    /** Starts and polls the authoritative local-AnimaDex reference job. */
    generateReference(record, row, gallery, button) {
        button.disabled = true;
        button.textContent = 'Starting';
        genericRequest('TagDexLibraryStartGenerate', { variantId: record.id, revision: record.revision }, data => {
            let jobId = data.job_id;
            let polls = 0;
            let poll = () => {
                if (!gallery.isConnected || polls++ > 600) {
                    return;
                }
                genericRequest('TagDexLibraryJob', { jobId: jobId }, job => {
                    let status = job.status || 'running';
                    button.textContent = status == 'running' || status == 'queued' ? 'Generating' : status;
                    if (status == 'completed' || status == 'done' || status == 'succeeded') {
                        this.openGallery(record, row);
                    }
                    else if (status == 'failed' || status == 'error' || status == 'cancelled') {
                        button.disabled = false;
                        button.textContent = 'Retry';
                        this.status(job.error || 'Reference generation failed.');
                    }
                    else {
                        setTimeout(poll, 1000);
                    }
                }, 0, error => {
                    button.disabled = false;
                    button.textContent = 'Retry';
                    this.status(error);
                });
            };
            poll();
        }, 0, error => {
            button.disabled = false;
            button.textContent = 'Retry';
            this.status(error);
        });
    }

    /** Creates or updates a character with immediate server persistence. */
    editCharacter(record) {
        tagDexLibraryEditor.character(record, false, () => this.load());
    }

    /** Creates or updates a variant and its ordered LoRA stack. */
    editVariant(character, record) {
        tagDexLibraryEditor.variant(character, record, false, () => this.load());
    }

    /** Applies prompt, checkpoint, and LoRA stack while preserving unrelated parameters. */
    applyRecipe(recipe, resolved) {
        let normalize = name => typeof cleanModelName == 'function' ? cleanModelName(name) : `${name || ''}`.replace(/\.safetensors$/i, '');
        let existingNames = [...(document.getElementById('input_loras')?.selectedOptions || [])].map(option => normalize(option.value));
        let existingWeights = (`${document.getElementById('input_loraweights')?.value || ''}`).split(',').map(value => value.trim());
        let names = existingNames.slice();
        let weights = existingWeights.slice(0, names.length);
        for (let lora of resolved) {
            let logicalName = normalize(lora.logical_name);
            let index = names.indexOf(logicalName);
            let weight = `${lora.weight}`;
            if (index >= 0 && weights[index] != weight) {
                throw new Error(`Weight conflict for ${lora.name}.`);
            }
            if (index < 0) {
                names.push(logicalName);
                weights.push(weight);
            }
        }
        let getType = id => gen_param_types.find(param => param.id == id);
        let set = (id, value) => {
            let type = getType(id);
            if (type) {
                setDirectParamValue(type, value);
            }
        };
        let append = (current, addition) => {
            current = `${current || ''}`.trim();
            addition = `${addition || ''}`.trim();
            if (!addition || current == addition || current.endsWith(`, ${addition}`)) {
                return current || addition;
            }
            return current ? `${current}, ${addition}` : addition;
        };
        set('prompt', append(document.getElementById('input_prompt')?.value, recipe.prompt));
        set('negativeprompt', append(document.getElementById('input_negativeprompt')?.value, recipe.negative_prompt));
        if (recipe.checkpoint) {
            set('model', recipe.checkpoint);
        }
        set('loras', names);
        set('loraweights', weights);
    }

    /** Updates the panel status. */
    status(message) {
        document.getElementById('tagdex_library_status').textContent = message || '';
    }
}

tagDexLibrary = new TagDexLibraryClass();
if (typeof sessionReadyCallbacks != 'undefined') {
    sessionReadyCallbacks.push(() => tagDexLibrary.init());
}
