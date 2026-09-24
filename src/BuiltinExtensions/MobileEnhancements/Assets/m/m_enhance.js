/** MobileEnhancements standalone client - Prompt Enhance for /simple.
 * Rewrites the typed idea via the same ListPromptEnhanceStatus / EnhancePrompt API the desktop
 * promptenhance.js uses, presented as a slim pill beside the Prompt heading and a bottom sheet.
 * Coach (and its Tags tools) remains reachable from More > Prompt Coach.
 */
class MEnhance {

    constructor() {
        /** The Enhance pill in the Create prompt header. */
        this.pillEl = null;
        /** Whether a resolved profile is available (unhealthy endpoints still leave this true). */
        this.buttonEnabled = false;
        /** Title / reason text mirrored onto the pill. */
        this.buttonReason = 'Loading Prompt Enhance status...';
        /** Manual profile override id, or '' for automatic. Persisted like desktop. */
        this.profileOverride = this.pref('profile_override', '');
        /** Enhance Strength: faithful / expand / full. */
        this.strength = this.pref('strength', 'full');
        /** Profiles list from the last successful status reply (for the sheet select). */
        this.profiles = [];
        /** Allowed strengths from the last status reply. */
        this.allowedStrengths = ['faithful', 'expand', 'full'];
        /** In-flight EnhancePrompt websocket, or null. */
        this.socket = null;
        /** True while a review enhance request is in flight. */
        this.running = false;
        /** True once the in-flight request reached a terminal frame or was closed deliberately. */
        this.settled = false;
        /** Most recent terminal result frame, or null. */
        this.lastResult = null;
        /** Whether Apply is currently allowed. */
        this.applyEnabled = false;
        /** Live sheet DOM bits while a sheet is open; null when closed. */
        this.sheet = null;
        /** Debounce / sequencing for ListPromptEnhanceStatus, matching desktop. */
        this.statusTimer = null;
        this.lastStatusCall = 0;
        this.statusRequestSeq = 0;
        /** Prompt text most recently applied, so provenance clears when the user edits away from it. */
        this.appliedEnhancedText = null;
        this.clearProvenanceListener = null;
        this.pillListenerBound = false;
    }

    pref(key, fallback) {
        let stored = localStorage.getItem(`promptenhance_${key}`);
        return stored == null ? fallback : stored;
    }

    setPref(key, value) {
        localStorage.setItem(`promptenhance_${key}`, value);
    }

    /** Effective checkpoint the same way Coach / Create resolve it. */
    effectiveModel() {
        try {
            return (mState.buildGenInput()['model'] || '') + '';
        }
        catch (e) {
            return (mState.params['model'] || '') + '';
        }
    }

    /** Current prompt text from the Create box when present, else from state. */
    currentPrompt() {
        if (typeof mCreate != 'undefined' && mCreate.promptBox) {
            return mCreate.promptBox.value || '';
        }
        return mState.params['prompt'] || '';
    }

    /** Builds the slim pill that replaces Coach beside the Prompt heading. */
    buildPill() {
        let pill = mUI.el('button', 'm-enhance-pill');
        pill.type = 'button';
        pill.addEventListener('click', () => this.open());
        this.pillEl = pill;
        this.renderPill();
        if (!this.pillListenerBound) {
            this.pillListenerBound = true;
            mState.onChange(() => this.scheduleStatusRefresh());
        }
        this.scheduleStatusRefresh();
        return pill;
    }

    renderPill() {
        if (!this.pillEl) {
            return;
        }
        this.pillEl.textContent = this.buttonEnabled ? 'Enhance \u203A' : 'Enhance \u00B7 No profile \u203A';
        this.pillEl.title = this.buttonReason;
        this.pillEl.classList.toggle('m-enhance-pill-disabled', !this.buttonEnabled);
    }

    setButtonEnabled(enabled, reason) {
        this.buttonEnabled = enabled;
        this.buttonReason = reason || '';
        this.renderPill();
    }

    scheduleStatusRefresh() {
        let now = Date.now();
        let wait = Math.max(0, 1000 - (now - this.lastStatusCall));
        if (this.statusTimer) {
            clearTimeout(this.statusTimer);
        }
        this.statusTimer = setTimeout(() => {
            this.statusTimer = null;
            this.lastStatusCall = Date.now();
            this.refreshStatus();
        }, wait);
    }

    refreshStatus() {
        let model = this.effectiveModel();
        this.statusRequestSeq += 1;
        let requestSeq = this.statusRequestSeq;
        genericRequest('ListPromptEnhanceStatus', { 'model': model, 'profile_override': this.profileOverride }, data => {
            if (requestSeq != this.statusRequestSeq) {
                return;
            }
            this.applyStatusToButton(data);
            this.profiles = data.profiles || [];
            this.allowedStrengths = (data.resolved && data.resolved.strengths) || ['faithful', 'expand', 'full'];
            if (this.sheet && this.sheet.content && this.sheet.content.isConnected) {
                this.fillProfileSelect(this.sheet.profileSelect);
                this.applyStrengthOptions(this.sheet.strengthSelect);
            }
        }, 0, error => {
            if (requestSeq != this.statusRequestSeq) {
                return;
            }
            console.warn(`Prompt Enhance: status check failed: ${error}`);
            this.setButtonEnabled(false, `${error}`);
        });
    }

    applyStatusToButton(data) {
        if (!data.resolved || !data.resolved.profile) {
            this.setButtonEnabled(false, (data.resolved && data.resolved.reason) || 'No writer profile available for the current model.');
            return;
        }
        let anyHealthy = (data.endpoints || []).some(endpoint => endpoint.healthy);
        let reason = anyHealthy ? 'Rewrite this prompt with a local writer LLM for the currently loaded model.'
            : 'No Prompt Enhance writer endpoint is currently reachable - the prompt will pass through unchanged.';
        this.setButtonEnabled(true, reason);
    }

    fillProfileSelect(select) {
        if (!select) {
            return;
        }
        let previous = select.value;
        select.innerHTML = '';
        let auto = document.createElement('option');
        auto.value = '';
        auto.textContent = 'Automatic';
        select.appendChild(auto);
        for (let i = 0; i < this.profiles.length; i++) {
            let option = document.createElement('option');
            option.value = this.profiles[i].id;
            option.textContent = this.profiles[i].display;
            select.appendChild(option);
        }
        let want = previous != null && previous !== '' ? previous : this.profileOverride;
        select.value = [...select.options].some(o => o.value == want) ? want : '';
    }

    applyStrengthOptions(select) {
        if (!select) {
            return;
        }
        let allowed = this.allowedStrengths || ['faithful', 'expand', 'full'];
        for (let i = 0; i < select.options.length; i++) {
            select.options[i].disabled = !allowed.includes(select.options[i].value);
        }
        select.value = this.strength;
    }

    /** Opens the enhance sheet and starts a request. Always reachable so a missing auto-profile can be fixed
     * via the profile override dropdown inside the sheet (same contract as desktop). */
    open() {
        // Backdrop / grip dismiss leaves this.sheet pointing at a detached tree with running still true.
        // Clear that before the re-entry guard so a second tap can open a fresh sheet.
        if (this.sheet && this.sheet.content && !this.sheet.content.isConnected) {
            this.sheet = null;
            if (this.socket && this.running) {
                this.settled = true;
                try { this.socket.close(); } catch (e) { /* ignore */ }
            }
            this.running = false;
        }
        if (this.running) {
            return;
        }
        let content = mUI.el('div', 'm-enhance-sheet');
        content.appendChild(mUI.el('div', 'm-enhance-title', 'Prompt Enhance'));
        let status = mUI.el('div', 'm-enhance-status', 'Starting...');
        content.appendChild(status);

        let profileRow = mUI.el('div', 'm-enhance-row');
        profileRow.appendChild(mUI.el('label', 'm-enhance-label', 'Profile'));
        let profileSelect = document.createElement('select');
        profileSelect.className = 'm-enhance-select';
        this.fillProfileSelect(profileSelect);
        profileRow.appendChild(profileSelect);
        content.appendChild(profileRow);

        let strengthRow = mUI.el('div', 'm-enhance-row');
        strengthRow.appendChild(mUI.el('label', 'm-enhance-label', 'Strength'));
        let strengthSelect = document.createElement('select');
        strengthSelect.className = 'm-enhance-select';
        for (let entry of [['faithful', 'Faithful'], ['expand', 'Expand'], ['full', 'Full scene']]) {
            let option = document.createElement('option');
            option.value = entry[0];
            option.textContent = entry[1];
            strengthSelect.appendChild(option);
        }
        strengthSelect.value = this.strength;
        this.applyStrengthOptions(strengthSelect);
        strengthRow.appendChild(strengthSelect);
        content.appendChild(strengthRow);

        let preview = document.createElement('textarea');
        preview.className = 'm-enhance-preview';
        preview.rows = 6;
        preview.readOnly = true;
        content.appendChild(preview);

        let notes = mUI.el('div', 'm-enhance-notes');
        notes.style.display = 'none';
        content.appendChild(notes);
        let conflict = mUI.el('div', 'm-enhance-conflict');
        conflict.style.display = 'none';
        content.appendChild(conflict);
        let passthrough = mUI.el('div', 'm-enhance-passthrough');
        passthrough.style.display = 'none';
        content.appendChild(passthrough);

        let actions = mUI.el('div', 'm-enhance-actions');
        let applyBtn = mUI.el('button', 'm-enhance-apply m-enhance-apply-disabled', 'Apply');
        applyBtn.type = 'button';
        let keepBtn = mUI.el('button', 'm-enhance-secondary', 'Keep original');
        keepBtn.type = 'button';
        let closeBtn = mUI.el('button', 'm-enhance-secondary', 'Close');
        closeBtn.type = 'button';
        actions.appendChild(applyBtn);
        actions.appendChild(keepBtn);
        actions.appendChild(closeBtn);
        content.appendChild(actions);

        this.sheet = {
            content, status, preview, notes, conflict, passthrough, applyBtn,
            profileSelect, strengthSelect
        };
        this.lastResult = null;
        this.applyEnabled = false;
        this.running = true;
        this.settled = false;

        let closeSheet = mUI.openSheet(content);
        let disconnected = () => {
            this.sheet = null;
            if (this.socket && this.running) {
                this.settled = true;
                try { this.socket.close(); } catch (e) { /* ignore */ }
            }
            this.running = false;
        };
        keepBtn.addEventListener('click', () => {
            this.clearProvenance();
            disconnected();
            closeSheet();
        });
        closeBtn.addEventListener('click', () => {
            disconnected();
            closeSheet();
        });
        applyBtn.addEventListener('click', () => {
            if (!this.applyEnabled || !this.lastResult) {
                return;
            }
            this.applyResult(this.lastResult);
            disconnected();
            closeSheet();
            mUI.note('Prompt enhanced.');
        });
        profileSelect.addEventListener('change', () => {
            this.profileOverride = profileSelect.value;
            this.setPref('profile_override', this.profileOverride);
            this.refreshStatus();
            if (this.running && this.socket) {
                this.settled = true;
                try { this.socket.close(); } catch (e) { /* ignore */ }
                this.running = false;
            }
            disconnected();
            closeSheet();
            this.open();
        });
        strengthSelect.addEventListener('change', () => {
            this.strength = strengthSelect.value;
            this.setPref('strength', this.strength);
            if (this.running && this.socket) {
                this.settled = true;
                try { this.socket.close(); } catch (e) { /* ignore */ }
                this.running = false;
            }
            disconnected();
            closeSheet();
            this.open();
        });

        let model = this.effectiveModel();
        let prompt = this.currentPrompt();
        this.socket = makeWSRequest('EnhancePrompt', {
            'prompt': prompt,
            'model': model,
            'profile_override': this.profileOverride,
            'endpoint_override': '',
            'strength': this.strength,
            'video_task': '',
            'video_duration': 0
        }, data => {
            if (!this.sheet || !this.sheet.content.isConnected) {
                return;
            }
            if (data.result != null || data.conflict != null || data.needs_input != null || data.passthrough != null) {
                this.settled = true;
            }
            this.handleFrame(data);
        }, 0, error => {
            this.settled = true;
            this.running = false;
            if (this.sheet && this.sheet.content.isConnected) {
                this.sheet.status.textContent = '';
            }
            showError(error);
        });
        if (this.socket) {
            this.socket.addEventListener('close', () => {
                if (!this.settled) {
                    this.settled = true;
                    this.running = false;
                    showError('The Prompt Enhance connection closed with no result. Check the server logs.');
                }
            });
        }
        else {
            // makeWSRequest returned null (no session / transport unavailable). Leave the sheet open so the
            // user can still change profile/strength, but clear running so a later tap can retry.
            this.running = false;
            this.settled = true;
            if (this.sheet && this.sheet.content.isConnected) {
                this.sheet.status.textContent = 'Could not start Prompt Enhance - try again.';
            }
        }
    }

    setApplyEnabled(enabled) {
        this.applyEnabled = enabled;
        if (!this.sheet) {
            return;
        }
        this.sheet.applyBtn.classList.toggle('m-enhance-apply-disabled', !enabled);
    }

    handleFrame(data) {
        if (!this.sheet) {
            return;
        }
        let s = this.sheet;
        if (data.status == 'running') {
            s.status.textContent = `${data.profile} \u00B7 ${data.writer_model} \u00B7 ${data.endpoint}`;
            return;
        }
        if (data.chunk != null) {
            s.preview.value += data.chunk;
            return;
        }
        if (data.result != null) {
            this.running = false;
            if ((data.result + '').trim() == '') {
                s.passthrough.style.display = '';
                s.passthrough.textContent = 'Not enhanced: The writer returned an empty reply';
                this.setApplyEnabled(false);
                return;
            }
            this.lastResult = data;
            s.preview.value = data.result;
            if (data.notes) {
                s.notes.style.display = '';
                s.notes.textContent = data.notes;
            }
            if (data.strength_note) {
                s.notes.style.display = '';
                s.notes.textContent = s.notes.textContent ? `${s.notes.textContent}\n${data.strength_note}` : data.strength_note;
            }
            s.status.textContent = `${data.profile} \u00B7 ${data.writer_model} \u00B7 ${data.endpoint}${data.cached ? ' (cached)' : ''}`;
            this.setApplyEnabled(true);
            return;
        }
        if (data.conflict != null) {
            this.running = false;
            s.preview.value = '';
            s.conflict.style.display = '';
            s.conflict.textContent = data.conflict;
            this.setApplyEnabled(false);
            return;
        }
        if (data.needs_input != null) {
            this.running = false;
            s.preview.value = '';
            s.conflict.style.display = '';
            s.conflict.textContent = `${data.needs_input}\nprofile miss - not applied`;
            this.setApplyEnabled(false);
            return;
        }
        if (data.passthrough != null) {
            this.running = false;
            s.passthrough.style.display = '';
            s.passthrough.textContent = `Not enhanced: ${data.reason}`;
            this.setApplyEnabled(false);
        }
    }

    applyResult(data) {
        mState.params['prompt'] = data.result;
        if (typeof mCreate != 'undefined' && mCreate.promptBox) {
            mCreate.promptBox.value = data.result;
            if (typeof mCreate.autoGrow == 'function') {
                mCreate.autoGrow(mCreate.promptBox);
            }
        }
        mState.save();
        this.recordProvenance({
            'original': data.original,
            'profile': data.profile,
            'pack_version': data.pack_version,
            'writer_model': data.writer_model,
            'endpoint': data.endpoint,
            'cached': data.cached,
            'strength': data.strength
        });
        this.armProvenanceClearOnEdit(data.result);
        this.appliedEnhancedText = data.result;
    }

    recordProvenance(info) {
        try {
            mState.params['promptenhanceprovenance'] = JSON.stringify(info);
            mState.save();
        }
        catch (e) {
            console.warn('Prompt Enhance: failed to record provenance', e);
        }
    }

    clearProvenance() {
        if ('promptenhanceprovenance' in mState.params) {
            delete mState.params['promptenhanceprovenance'];
            mState.save();
        }
        this.appliedEnhancedText = null;
        this.disarmProvenanceClearOnEdit();
    }

    armProvenanceClearOnEdit(appliedText) {
        this.disarmProvenanceClearOnEdit();
        if (typeof mCreate == 'undefined' || !mCreate.promptBox) {
            return;
        }
        let box = mCreate.promptBox;
        let listener = () => {
            if (box.value != appliedText) {
                this.clearProvenance();
            }
        };
        this.clearProvenanceListener = listener;
        box.addEventListener('input', listener);
    }

    disarmProvenanceClearOnEdit() {
        if (this.clearProvenanceListener && typeof mCreate != 'undefined' && mCreate.promptBox) {
            mCreate.promptBox.removeEventListener('input', this.clearProvenanceListener);
        }
        this.clearProvenanceListener = null;
    }
}

let mEnhance = new MEnhance();
