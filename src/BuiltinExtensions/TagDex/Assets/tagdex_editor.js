/** Shared editor for the user's own TagDex characters (Genpage dialog and /simple sheet).
 *
 * A custom character is a name, a series, the character's own tags, and any number of attached LoRAs, each with a
 * weight and its own extra tags. The server stores them in the `custom_character` dataset and turns each LoRA into a
 * `<lora:NAME:WEIGHT>` tag, so the resulting card behaves exactly like a dataset card.
 */
class TagDexCharacterEditorClass {

    /** Most LoRA name suggestions shown under a name field. */
    static MaxSuggestions = 20;

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

    /** Creates a compact action button. */
    action(label, callback) {
        let button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', callback);
        return button;
    }

    /** The LoRA names known to this page, for suggestions. Genpage keeps them in `coreModelMap`; /simple keeps
     * `[name, classId]` pairs in `mState.models`. */
    loraNames(simple) {
        if (simple && typeof mState != 'undefined') {
            return ((mState.models || {})['LoRA'] || []).map(entry => entry[0]);
        }
        if (typeof coreModelMap != 'undefined' && coreModelMap && coreModelMap['LoRA']) {
            return coreModelMap['LoRA'];
        }
        return [];
    }

    /** Returns up to `limit` names containing `text`, case-insensitively. `lowered` is index-parallel to `names`. */
    suggest(names, lowered, text, limit) {
        let needle = text.trim().toLowerCase();
        let out = [];
        if (needle.length == 0) {
            return out;
        }
        for (let i = 0; i < names.length && out.length < limit; i++) {
            if (lowered[i].includes(needle)) {
                out.push(names[i]);
            }
        }
        return out;
    }

    /** Builds one attached-LoRA row: name (with suggestions), weight, remove, and the LoRA's own tags. */
    loraRow(lora, names, lowered, onRemove) {
        let row = document.createElement('div');
        row.className = 'tagdex-editor-lora';
        let head = document.createElement('div');
        head.className = 'tagdex-editor-lora-head';
        let name = document.createElement('input');
        name.className = 'tagdex-editor-lora-name';
        name.value = lora.name || '';
        name.placeholder = 'LoRA name';
        name.autocomplete = 'off';
        name.setAttribute('aria-label', 'LoRA name');
        let weight = document.createElement('input');
        weight.className = 'tagdex-editor-lora-weight';
        weight.type = 'number';
        weight.min = '-2';
        weight.max = '2';
        weight.step = '0.05';
        weight.value = lora.weight ?? 1;
        weight.setAttribute('aria-label', 'Weight');
        let remove = this.action('×', onRemove);
        remove.className = 'tagdex-editor-lora-remove';
        remove.setAttribute('aria-label', 'Remove LoRA');
        head.append(name, weight, remove);
        let suggestions = document.createElement('div');
        suggestions.className = 'tagdex-editor-suggest';
        suggestions.hidden = true;
        let tags = document.createElement('input');
        tags.className = 'tagdex-editor-lora-tags';
        tags.value = lora.tags || '';
        tags.placeholder = 'Tags for this LoRA (trigger words)';
        tags.autocomplete = 'off';
        tags.setAttribute('aria-label', 'LoRA tags');
        name.addEventListener('input', () => {
            let matches = this.suggest(names, lowered, name.value, TagDexCharacterEditorClass.MaxSuggestions);
            suggestions.replaceChildren();
            for (let i = 0; i < matches.length; i++) {
                let pick = this.action(matches[i].replace(/\.safetensors$/i, ''), () => {
                    name.value = matches[i].replace(/\.safetensors$/i, '');
                    suggestions.hidden = true;
                });
                pick.className = 'tagdex-editor-suggest-item';
                // Keeps the input focused through the tap so the list does not vanish under the finger.
                pick.addEventListener('mousedown', event => event.preventDefault());
                suggestions.appendChild(pick);
            }
            suggestions.hidden = matches.length == 0;
        });
        name.addEventListener('blur', () => setTimeout(() => suggestions.hidden = true, 150));
        row.append(head, suggestions, tags);
        row.readOut = () => ({ name: name.value.trim(), weight: Number(weight.value == '' ? 1 : weight.value), tags: this.escapePromptParens(tags.value) });
        return row;
    }

    /** Opens the add/edit form. `custom` is the stored record (`name`, `series`, `tags`, `loras`) when editing, or
     * null to add. `done` is called with `{ action: 'saved' | 'deleted', name }` once the server has accepted. */
    edit(custom, simple, done) {
        let editing = custom != null;
        let names = this.loraNames(simple);
        let lowered = names.map(n => n.toLowerCase());
        let form = document.createElement('form');
        form.className = 'tagdex-editor-form';
        let name = document.createElement('input');
        name.required = true;
        name.maxLength = 100;
        name.value = custom?.name || '';
        // Without this iOS offers "AutoFill Contact" on a field labelled Name.
        name.autocomplete = 'off';
        let series = document.createElement('input');
        series.maxLength = 200;
        series.value = custom?.series || '';
        series.autocomplete = 'off';
        let tags = document.createElement('textarea');
        tags.value = custom?.tags || '';
        tags.placeholder = '1girl, silver hair, red eyes, ...';
        tags.maxLength = 4000;
        form.append(this.field('Name', name), this.field('Series', series), this.field('Tags', tags));
        let stack = document.createElement('section');
        stack.className = 'tagdex-editor-stack';
        let stackTitle = document.createElement('h4');
        stackTitle.textContent = 'LoRAs';
        let rows = document.createElement('div');
        rows.className = 'tagdex-editor-lora-list';
        let loraRows = [];
        let addRow = lora => {
            let row = this.loraRow(lora, names, lowered, () => {
                loraRows.splice(loraRows.indexOf(row), 1);
                row.remove();
            });
            loraRows.push(row);
            rows.appendChild(row);
            return row;
        };
        let existing = custom?.loras || [];
        for (let i = 0; i < existing.length; i++) {
            addRow(existing[i]);
        }
        let add = this.action('+ Add LoRA', () => addRow({ name: '', weight: 1, tags: '' }).querySelector('.tagdex-editor-lora-name').focus());
        add.className = 'tagdex-editor-add';
        stack.append(stackTitle, rows, add);
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
        if (editing) {
            let remove = this.action('Delete', () => {
                if (!confirm(`Delete ${custom.name}? This also removes its reference image.`)) {
                    return;
                }
                genericRequest('TagDexDeleteCustomCharacter', { name: custom.name }, () => {
                    opened.close();
                    done({ action: 'deleted', name: custom.name });
                }, 0, error => formError.textContent = error);
            });
            remove.className = 'tagdex-editor-delete';
            actions.appendChild(remove);
        }
        form.appendChild(actions);
        let opened = this.open(editing ? 'Edit Character' : 'Add Character', form, simple);
        form.addEventListener('submit', event => {
            event.preventDefault();
            formError.textContent = '';
            let body = {
                original: custom?.name || '',
                name: name.value.trim(),
                series: series.value.trim(),
                // Booru tags like "aria (robot)" must reach the text encoder as "aria \(robot\)", or the parens are
                // read as emphasis and the tag no longer matches.
                tags: this.escapePromptParens(tags.value),
                loras: loraRows.map(row => row.readOut())
            };
            save.disabled = true;
            // Sent flat: a JObject API parameter is bound to the whole request payload, not to a field of its name.
            genericRequest('TagDexSaveCustomCharacter', body, data => {
                opened.close();
                done({ action: 'saved', name: data.name });
            }, 0, error => {
                save.disabled = false;
                formError.textContent = error;
            });
        });
        return opened;
    }

    /** Escapes literal parentheses in prompt text: "aria (robot)" -> "aria \(robot\)". Kept as-is: weight groups
     * "(tag:1.2)" (anything nested inside them is still escaped), parens that are already escaped, and anything
     * inside <...> prompt tags such as <lora:...> or <segment:...>. Unbalanced parens are escaped. */
    escapePromptParens(text) {
        let chars = [...`${text || ''}`];
        let escape = new Set();
        let open = [];
        let pairs = [];
        let angle = 0;
        for (let i = 0; i < chars.length; i++) {
            let c = chars[i];
            if (c == '\\') {
                i++;
                continue;
            }
            if (c == '<') {
                angle++;
            }
            else if (c == '>' && angle > 0) {
                angle--;
            }
            else if (angle == 0 && c == '(') {
                open.push(i);
            }
            else if (angle == 0 && c == ')') {
                if (open.length > 0) {
                    pairs.push([open.pop(), i]);
                }
                else {
                    escape.add(i);
                }
            }
        }
        for (let i = 0; i < open.length; i++) {
            escape.add(open[i]);
        }
        let weight = /:\s*[+-]?(\d+(\.\d*)?|\.\d+)\s*$/;
        for (let i = 0; i < pairs.length; i++) {
            let [start, end] = pairs[i];
            if (!weight.test(chars.slice(start + 1, end).join(''))) {
                escape.add(start);
                escape.add(end);
            }
        }
        return chars.map((c, i) => escape.has(i) ? `\\${c}` : c).join('');
    }
}

tagDexCharacterEditor = new TagDexCharacterEditorClass();
