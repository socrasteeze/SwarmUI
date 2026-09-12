/** Prompt Enhance - rewrites the user's typed idea into a prompt shaped for the currently loaded image model,
 * using a local writer LLM ("writer host") reached from the hub over HTTP. See docs/PromptEnhance-Design.md.
 *
 * One button is attached beside the prompt textbox, following the same attach pattern PromptPlusButton uses
 * on 'alt_text_add_button' (grab the existing wrapper, insert a sibling span, wire a click handler) - except
 * this button does not exist in any .cshtml, so it is built and inserted here instead of merely looked up.
 *
 * The result panel is rooted at document.body, not appended under '.alt_prompt_region'. That region gets a
 * 'transform' applied to it while the mobile on-screen keyboard is open (see '.mobile-keyboard-pin
 * #alt_prompt_region' in genpage.css), and a transformed ancestor becomes the containing block for any
 * 'position: fixed' descendant - which would resolve the panel's fixed positioning against the prompt region
 * instead of the viewport. PromptTabCompleteClass's popover in prompttools.js documents the same trap and
 * roots at document.body for the same reason.
 *
 * A tri-state mode control ('off'/'review'/'auto') sits beside the button. In 'auto' mode, a single
 * capture-phase click listener on 'alt_generate_button' - the one element every generate path clicks through
 * ('generate_button', Ctrl+Enter, Enter-in-prompt-box, tool overrides) - intercepts the click, runs one
 * EnhancePrompt request, applies the result, then re-dispatches the click under a re-entry guard so the
 * interceptor passes its own synthetic click straight through instead of looping. "Generate Forever" calls
 * 'mainGenHandler.doGenerate()' directly and never touches that button, so it is not and cannot be
 * intercepted here - it always generates un-enhanced regardless of mode.
 */
class PromptEnhanceHelperClass {

    constructor() {
        /** The main prompt textarea this feature reads from and writes back into. */
        this.promptBox = null;
        /** The 'Enhance' button. */
        this.button = null;
        /** Whether the button is currently allowed to open the panel (a resolved profile and a healthy endpoint). */
        this.buttonEnabled = false;
        /** The result panel, appended directly to document.body. */
        this.panel = null;
        /** Status line element inside the panel (profile display, writer model, endpoint id). */
        this.statusLine = null;
        /** Read-only preview textarea, filled token-by-token as chunks stream in. */
        this.previewArea = null;
        /** Muted block showing the writer's NOTES: lines (if any), rendered under the preview. */
        this.notesBlock = null;
        /** Red block used for both the 'conflict' and 'needs_input' hard-stop cases. */
        this.conflictBlock = null;
        /** Marker block used for the 'passthrough' (fail-open, not enhanced) case. */
        this.passthroughBlock = null;
        /** The Apply button. */
        this.applyButton = null;
        /** Whether Apply is currently allowed to do anything (a 'result' frame arrived and nothing overrode it). */
        this.applyEnabled = false;
        /** The most recent terminal 'result' frame from the server, or null. */
        this.lastResult = null;
        /** The in-flight WebSocket, or null. */
        this.socket = null;
        /** True while a request is in flight. */
        this.running = false;
        /** True once the in-flight request has reached a terminal frame (or been deliberately closed), so
         * the socket's 'close' listener can tell a normal finish apart from a dropped connection. */
        this.settled = false;
        /** Pending debounce timer id for refreshStatus(), or null. */
        this.statusTimer = null;
        /** Timestamp (ms) of the last refreshStatus() call actually made, for the one-call-per-second debounce. */
        this.lastStatusCall = 0;
        /** Monotonically increasing sequence number, incremented once per dispatched ListPromptEnhanceStatus
         * request. Two requests can be in flight at once (eg a model change and a profile-override change both
         * landing inside the debounce window), and whichever happens to resolve last would otherwise win even
         * if it was dispatched first - a stale reply clobbering a newer one's button state. Each request's
         * callbacks capture the sequence value current at dispatch time and compare it against this field when
         * they run, so only the most-recently-dispatched request is ever allowed to touch the button. */
        this.statusRequestSeq = 0;
        /** Pending 'input' listener on the prompt box that clears provenance once its value diverges from the
         * applied prompt, or null when none is armed. */
        this.clearProvenanceListener = null;
        /** Tri-state mode: 'off' (no enhancement, button hidden), 'review' (default - today's behavior, the
         * button opens the panel for the user to review), or 'auto' (generate enhances silently first). Persisted
         * per user the same way interrogate.js persists its prefs. */
        this.mode = this.pref('mode', 'review');
        /** The mode <select> beside the Enhance button. */
        this.modeSelect = null;
        /** Manual profile override id, or '' for automatic resolution. Persisted per user. Sent as
         * 'profile_override' on every status check and every EnhancePrompt request. */
        this.profileOverride = this.pref('profile_override', '');
        /** The profile-override <select> inside the panel. */
        this.profileSelect = null;
        /** The prompt text this feature most recently wrote into the prompt box (via manual Apply or the
         * auto-enhance path), so a second generate click is never re-enhanced against its own output. Cleared
         * alongside provenance whenever the prompt box's value diverges from it. */
        this.appliedEnhancedText = null;
        /** The 'alt_generate_button' element - the single funnel every generate path clicks through. */
        this.generateButton = null;
        /** True only for the instant this feature re-dispatches its own synthetic click on
         * 'generateButton', so the capture-phase interceptor below lets that one click pass straight through
         * instead of intercepting its own re-entry. */
        this.reentryGuard = false;
        /** True while an auto-enhance request (triggered by intercepting a generate click) is in flight. */
        this.autoRunning = false;
        /** The generate button's own text, saved while 'Enhancing...' is shown over it, or null when not busy. */
        this.generateButtonOriginalText = null;
    }

    /** Reads a stored preference, falling back to a default. */
    pref(key, fallback) {
        let stored = localStorage.getItem(`promptenhance_${key}`);
        return stored == null ? fallback : stored;
    }

    /** Stores a preference so the next page load starts where this one left off. */
    setPref(key, value) {
        localStorage.setItem(`promptenhance_${key}`, value);
    }

    /** Builds the button and panel, and wires the enabled-state hooks. Called once at script load. */
    install() {
        this.promptBox = getRequiredElementById('alt_prompt_textbox');
        this.generateButton = getRequiredElementById('alt_generate_button');
        this.buildButton();
        this.buildPanel();
        this.generateButton.addEventListener('click', e => this.onGenerateClick(e), true);
        getRequiredElementById('current_model').addEventListener('change', () => this.scheduleStatusRefresh());
        featureSetChangedCallbacks.push(() => this.scheduleStatusRefresh());
        this.scheduleStatusRefresh();
    }

    /** Builds the mode control and the Enhance entry, and puts them in the Generate caret menu
     * ('#popover_generate_center'). They used to sit loose in '.alt_prompt_main_line', which left the button
     * vertically unaligned with the '+' button, the token count and the Generate row on the classic layout.
     * If that popover is absent (a page that has the prompt row but not the caret menu), falls back to the
     * old placement beside the '+' button so the feature stays reachable. */
    buildButton() {
        let modeRow = createDiv(null, 'prompt-enhance-mode-row');
        let modeLabel = createSpan(null, 'prompt-enhance-mode-label translate', 'Enhance:');
        this.modeSelect = document.createElement('select');
        this.modeSelect.className = 'auto-dropdown prompt-enhance-mode-select';
        for (let entry of [['off', 'Off'], ['review', 'Review'], ['auto', 'Auto']]) {
            let option = document.createElement('option');
            option.value = entry[0];
            option.innerText = entry[1];
            this.modeSelect.appendChild(option);
        }
        this.modeSelect.value = this.mode;
        this.modeSelect.addEventListener('change', () => this.setMode(this.modeSelect.value));
        modeRow.appendChild(modeLabel);
        modeRow.appendChild(this.modeSelect);
        let popover = document.getElementById('popover_generate_center');
        if (popover) {
            // 'sui_popover_model_button' both styles the entry like the menu's other rows and marks it as a
            // row that dismisses the menu when clicked (see doPopHideCleanup in ui_improvements.js). The mode
            // row deliberately does not carry that class, so changing the mode leaves the menu open.
            this.button = createDiv(null, 'sui_popover_model_button prompt-enhance-popover-button prompt-enhance-disabled translate', 'Enhance Prompt');
            popover.appendChild(this.button);
            popover.appendChild(modeRow);
        }
        else {
            let addWrapper = getRequiredElementById('alt_text_add_button').parentElement;
            let wrapper = createSpan(null, 'prompt-enhance-button-wrapper');
            this.button = createSpan(null, 'basic-button prompt-enhance-button prompt-enhance-disabled translate', 'Enhance');
            wrapper.appendChild(modeRow);
            wrapper.appendChild(this.button);
            addWrapper.insertAdjacentElement('afterend', wrapper);
        }
        this.button.title = 'Loading Prompt Enhance status...';
        // Always opens the panel, even while the button reads as disabled - a model with no automatic
        // resolution still needs the panel reachable, since the manual profile-override dropdown that can
        // fix that lives inside it (see the panel's own profile <select>).
        this.button.addEventListener('click', () => this.open());
        this.applyModeToButtonVisibility();
    }

    /** Sets the enhancement mode, persists it, and shows/hides the Enhance button accordingly. */
    setMode(mode) {
        this.mode = mode;
        this.setPref('mode', mode);
        this.applyModeToButtonVisibility();
    }

    /** Hides the Enhance button entirely in 'off' mode; shows it otherwise. The mode <select> itself is
     * never hidden, so the user can always switch back. */
    applyModeToButtonVisibility() {
        this.button.style.display = this.mode == 'off' ? 'none' : '';
    }

    /** Builds the result panel and appends it to document.body. */
    buildPanel() {
        let panel = createDiv(null, 'prompt-enhance-panel');
        panel.innerHTML = `
            <div class="prompt-enhance-panel-inner">
                <div class="prompt-enhance-status"></div>
                <div class="prompt-enhance-profile-row">
                    <label class="prompt-enhance-profile-label translate">Profile</label>
                    <select class="auto-dropdown prompt-enhance-profile-select"></select>
                </div>
                <textarea class="prompt-enhance-preview" rows="6" readonly></textarea>
                <div class="prompt-enhance-notes" style="display:none"></div>
                <div class="prompt-enhance-conflict" style="display:none"></div>
                <div class="prompt-enhance-passthrough" style="display:none"></div>
                <div class="prompt-enhance-buttons">
                    <span class="basic-button prompt-enhance-apply prompt-enhance-disabled translate">Apply</span>
                    <span class="basic-button prompt-enhance-keep translate">Keep original</span>
                    <span class="basic-button prompt-enhance-close translate">Close</span>
                </div>
            </div>`;
        document.body.appendChild(panel);
        this.panel = panel;
        this.statusLine = panel.querySelector('.prompt-enhance-status');
        this.profileSelect = panel.querySelector('.prompt-enhance-profile-select');
        this.previewArea = panel.querySelector('.prompt-enhance-preview');
        this.notesBlock = panel.querySelector('.prompt-enhance-notes');
        this.conflictBlock = panel.querySelector('.prompt-enhance-conflict');
        this.passthroughBlock = panel.querySelector('.prompt-enhance-passthrough');
        this.applyButton = panel.querySelector('.prompt-enhance-apply');
        let keepButton = panel.querySelector('.prompt-enhance-keep');
        let closeButton = panel.querySelector('.prompt-enhance-close');
        this.applyButton.addEventListener('click', () => this.apply());
        keepButton.addEventListener('click', () => {
            // Keeping the original prompt discards this enhancement - nothing to attribute provenance to.
            this.clearProvenance();
            this.close();
        });
        closeButton.addEventListener('click', () => this.close());
        this.passthroughBlock.addEventListener('click', () => this.close());
        this.profileSelect.addEventListener('change', () => {
            this.profileOverride = this.profileSelect.value;
            this.setPref('profile_override', this.profileOverride);
            this.refreshStatus();
            if (this.panel.classList.contains('prompt-enhance-panel-open')) {
                // Re-send with the newly forced override rather than leaving a stale rewrite (or a stale
                // 'not enhanced' marker from before the override was picked) on screen.
                this.close();
                this.open();
            }
        });
    }

    /** Fills the profile-override <select> with every registered profile plus an 'Automatic' default, once -
     * the profile registry does not change at runtime, so repeated status refreshes must not keep re-adding
     * the same options. Restores the persisted override as the selected value. */
    populateProfileOptions(profiles) {
        if (this.profileSelect.dataset.populated == 'true') {
            return;
        }
        let auto = document.createElement('option');
        auto.value = '';
        auto.innerText = 'Automatic';
        this.profileSelect.appendChild(auto);
        for (let i = 0; i < profiles.length; i++) {
            let option = document.createElement('option');
            option.value = profiles[i].id;
            option.innerText = profiles[i].display;
            this.profileSelect.appendChild(option);
        }
        this.profileSelect.value = this.profileOverride;
        this.profileSelect.dataset.populated = 'true';
    }

    /** Writes a line into the status area. */
    setStatus(text) {
        this.statusLine.innerText = text;
    }

    /** Enables or disables the Apply button. */
    setApplyEnabled(enabled) {
        this.applyEnabled = enabled;
        if (enabled) {
            this.applyButton.classList.remove('prompt-enhance-disabled');
        }
        else {
            this.applyButton.classList.add('prompt-enhance-disabled');
        }
    }

    /** Enables or disables the Enhance button, and sets its title to explain why when disabled. */
    setButtonEnabled(enabled, reason) {
        this.buttonEnabled = enabled;
        this.button.title = reason;
        if (enabled) {
            this.button.classList.remove('prompt-enhance-disabled');
        }
        else {
            this.button.classList.add('prompt-enhance-disabled');
        }
    }

    /** Resets the panel to its empty starting state. */
    resetPanel() {
        this.previewArea.value = '';
        this.notesBlock.style.display = 'none';
        this.notesBlock.innerText = '';
        this.conflictBlock.style.display = 'none';
        this.conflictBlock.innerText = '';
        this.passthroughBlock.style.display = 'none';
        this.passthroughBlock.innerText = '';
        this.setApplyEnabled(false);
        this.lastResult = null;
        this.setStatus('');
    }

    /** Shows the panel. */
    showPanel() {
        this.panel.classList.add('prompt-enhance-panel-open');
    }

    /** Hides the panel and closes any in-flight socket. */
    close() {
        this.panel.classList.remove('prompt-enhance-panel-open');
        if (this.socket && this.running) {
            // Set before close() so the 'close' listener registered in open() does not mistake this
            // deliberate mid-stream close for a dropped connection and raise a spurious error.
            this.settled = true;
            this.socket.close();
        }
        this.running = false;
    }

    /** Renders the red hard-stop block for a 'conflict' or 'needs_input' terminal frame. No Apply. */
    showConflict(line, isNeedsInput) {
        this.previewArea.value = '';
        this.conflictBlock.style.display = '';
        this.conflictBlock.innerText = isNeedsInput ? `${line}\nprofile miss - not applied` : line;
        this.setApplyEnabled(false);
    }

    /** Renders the fail-open marker for a 'passthrough' terminal frame. No Apply; closes on acknowledgement. */
    showPassthrough(reason) {
        this.passthroughBlock.style.display = '';
        this.passthroughBlock.innerText = `Not enhanced: ${reason}`;
        this.setApplyEnabled(false);
    }

    /** Handles one frame from the EnhancePrompt websocket. Split out of open() so it can be tested directly
     * against the exact JSON shapes the server contract defines, without a real socket. */
    handleFrame(data) {
        if (data.status == 'running') {
            this.setStatus(`${data.profile} · ${data.writer_model} · ${data.endpoint}`);
            return;
        }
        if (data.chunk != null) {
            this.previewArea.value += data.chunk;
            return;
        }
        if (data.result != null) {
            this.running = false;
            if (data.result.trim() == '') {
                // An empty result is not a success - never enable Apply on it, treat it like passthrough.
                this.showPassthrough('The writer returned an empty reply');
                return;
            }
            this.lastResult = data;
            this.previewArea.value = data.result;
            if (data.notes) {
                this.notesBlock.style.display = '';
                this.notesBlock.innerText = data.notes;
            }
            this.setStatus(`${data.profile} · ${data.writer_model} · ${data.endpoint}${data.cached ? ' (cached)' : ''}`);
            this.setApplyEnabled(true);
            return;
        }
        if (data.conflict != null) {
            this.running = false;
            this.showConflict(data.conflict, false);
            return;
        }
        if (data.needs_input != null) {
            this.running = false;
            this.showConflict(data.needs_input, true);
            return;
        }
        if (data.passthrough != null) {
            this.running = false;
            this.showPassthrough(data.reason);
            return;
        }
    }

    /** Opens the panel and starts an EnhancePrompt request for the current prompt box and selected model. */
    open() {
        if (this.running || this.autoRunning) {
            return;
        }
        let model = getRequiredElementById('current_model').value;
        let prompt = this.promptBox.value;
        this.resetPanel();
        this.showPanel();
        this.running = true;
        this.setStatus('Starting...');
        this.settled = false;
        this.socket = makeWSRequest('EnhancePrompt', { 'prompt': prompt, 'model': model, 'profile_override': this.profileOverride, 'endpoint_override': '' }, data => {
            if (data.result != null || data.conflict != null || data.needs_input != null || data.passthrough != null) {
                this.settled = true;
            }
            this.handleFrame(data);
        }, 0, error => {
            this.settled = true;
            this.running = false;
            this.setStatus('');
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
    }

    /** Applies the last result: writes the prompt box, then records provenance in the hidden T2I param. */
    apply() {
        if (!this.applyEnabled || !this.lastResult) {
            return;
        }
        this.applyResult(this.lastResult);
        this.close();
    }

    /** The shared write-prompt-and-record-provenance step behind both manual Apply and the silent auto-enhance
     * path: writes the result into the prompt box, records provenance in the hidden T2I param, arms the
     * clear-on-edit listener, and remembers the applied text so a later generate click is never re-enhanced
     * against its own output. */
    applyResult(data) {
        this.promptBox.value = data.result;
        triggerChangeFor(this.promptBox);
        this.recordProvenance({
            'original': data.original,
            'profile': data.profile,
            'pack_version': data.pack_version,
            'writer_model': data.writer_model,
            'endpoint': data.endpoint,
            'cached': data.cached
        });
        this.armProvenanceClearOnEdit(data.result);
        this.appliedEnhancedText = data.result;
    }

    /** Records provenance into the hidden 'Prompt Enhance Provenance' T2I param (id 'promptenhanceprovenance').
     * <p>That param is registered VisibleNormally: false, but genInputs() (params.js) still builds an
     * 'input_<id>' element for every registered param regardless of visibility - it is just routed into the
     * hidden inputs area rather than the visible one. getGenInput() then picks it up automatically off
     * 'gen_param_types' like any other param, with no further wiring needed here. So the mechanism is simply:
     * write the element's value and trigger the normal change event, exactly as any other param box does.</p>
     */
    recordProvenance(data) {
        let elem = document.getElementById('input_promptenhanceprovenance');
        if (!elem) {
            console.warn('Prompt Enhance: hidden provenance param element not found, skipping provenance record.');
            return;
        }
        elem.value = JSON.stringify(data);
        triggerChangeFor(elem);
    }

    /** Clears the hidden provenance param, eg because the applied prompt was edited or discarded, so it never
     * sticks to a later, unrelated generation. */
    clearProvenance() {
        this.appliedEnhancedText = null;
        let elem = document.getElementById('input_promptenhanceprovenance');
        if (!elem) {
            return;
        }
        elem.value = '';
        triggerChangeFor(elem);
    }

    /** Arms a one-shot listener on the prompt box that clears the recorded provenance as soon as its value no
     * longer matches the just-applied prompt, so provenance never survives an edit into a different prompt. */
    armProvenanceClearOnEdit(appliedPrompt) {
        if (this.clearProvenanceListener) {
            this.promptBox.removeEventListener('input', this.clearProvenanceListener);
        }
        let listener = () => {
            if (this.promptBox.value != appliedPrompt) {
                this.clearProvenance();
                this.promptBox.removeEventListener('input', listener);
                this.clearProvenanceListener = null;
            }
        };
        this.clearProvenanceListener = listener;
        this.promptBox.addEventListener('input', listener);
    }

    /** Debounces refreshStatus() to at most one call per second. */
    scheduleStatusRefresh() {
        if (this.statusTimer) {
            return;
        }
        let elapsed = Date.now() - this.lastStatusCall;
        let wait = elapsed >= 1000 ? 0 : (1000 - elapsed);
        this.statusTimer = setTimeout(() => {
            this.statusTimer = null;
            this.lastStatusCall = Date.now();
            this.refreshStatus();
        }, wait);
    }

    /** Fetches current status for the selected model and updates the button's enabled state.
     * <p>Guarded against out-of-order replies: this dispatch's sequence number is captured in the closure, and
     * both callbacks return early if it is no longer the current one, so a reply from an older, superseded
     * request can never overwrite a newer request's button state - whichever resolves last is otherwise not
     * necessarily whichever was dispatched last.</p>
     */
    refreshStatus() {
        let model = getRequiredElementById('current_model').value;
        this.statusRequestSeq += 1;
        let requestSeq = this.statusRequestSeq;
        genericRequest('ListPromptEnhanceStatus', { 'model': model, 'profile_override': this.profileOverride }, data => {
            if (requestSeq != this.statusRequestSeq) {
                return;
            }
            this.applyStatusToButton(data);
            this.populateProfileOptions(data.profiles || []);
        }, 0, error => {
            if (requestSeq != this.statusRequestSeq) {
                return;
            }
            console.warn(`Prompt Enhance: status check failed: ${error}`);
            this.setButtonEnabled(false, `${error}`);
        });
    }

    /** Decides whether the button should be enabled from a ListPromptEnhanceStatus response, and sets it.
     * <p>Only a missing profile disables the button. An unhealthy/unreachable writer endpoint does not - the
     * server fails open (cache hit, or a passthrough marker) either way, so disabling here would just be a
     * second, redundant gate on the same fail-open contract. Endpoint health is instead surfaced in the
     * button's own title text.</p>
     */
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

    /** Capture-phase interceptor on 'alt_generate_button' - the single funnel every generate path clicks
     * through ('generate_button', Ctrl+Enter, Enter-in-prompt-box, and the tool-override buttons all call
     * '.click()' on this same element). Runs at most once per real user click; the re-entry guard lets this
     * feature's own re-dispatched click pass straight through instead of looping back into itself. Only
     * 'auto' mode with a resolved profile and a prompt that is not already the applied-enhanced text
     * intercepts anything - 'off' and 'review' leave every generate click completely untouched. */
    onGenerateClick(e) {
        if (this.reentryGuard) {
            return;
        }
        if (this.autoRunning) {
            // A request is already in flight for this click - swallow the extra click rather than queue a
            // second overlapping enhance-then-generate.
            e.stopPropagation();
            e.preventDefault();
            return;
        }
        if (this.mode != 'auto' || !this.buttonEnabled) {
            return;
        }
        let prompt = this.promptBox.value;
        if (prompt.trim() == '' || prompt == this.appliedEnhancedText) {
            return;
        }
        e.stopPropagation();
        e.preventDefault();
        this.runAutoEnhance(prompt, e.altKey);
    }

    /** Runs one EnhancePrompt request ahead of generating, for the 'auto' mode interceptor above.
     * <p>On a successful result: applies it (prompt box + provenance, same as manual Apply) and re-dispatches
     * the generate click. On conflict/needs_input: shows the existing red block and does not generate at
     * all. On passthrough/error/an empty result: shows the existing 'Not enhanced' marker and generates
     * anyway with the original, un-enhanced prompt (fail open).</p>
     */
    runAutoEnhance(prompt, altKey) {
        let model = getRequiredElementById('current_model').value;
        this.autoRunning = true;
        this.setGenerateButtonBusy(true);
        let failOpen = reason => {
            this.autoRunning = false;
            this.setGenerateButtonBusy(false);
            this.resetPanel();
            this.showPanel();
            this.showPassthrough(reason);
            this.dispatchGenerateClick(altKey);
        };
        let socket = makeWSRequest('EnhancePrompt', { 'prompt': prompt, 'model': model, 'profile_override': this.profileOverride, 'endpoint_override': '' }, data => {
            if (data.status != null || data.chunk != null) {
                return;
            }
            if (data.result != null) {
                if (data.result.trim() == '') {
                    // An empty result is not a success - fail open exactly like a passthrough.
                    failOpen('The writer returned an empty reply');
                    return;
                }
                this.autoRunning = false;
                this.setGenerateButtonBusy(false);
                this.applyResult(data);
                this.dispatchGenerateClick(altKey);
                return;
            }
            if (data.conflict != null || data.needs_input != null) {
                this.autoRunning = false;
                this.setGenerateButtonBusy(false);
                this.resetPanel();
                this.showPanel();
                this.showConflict(data.conflict != null ? data.conflict : data.needs_input, data.needs_input != null);
                return;
            }
            if (data.passthrough != null) {
                failOpen(data.reason);
            }
        }, 0, error => failOpen(`${error}`));
        if (!socket) {
            failOpen('Failed to open the Prompt Enhance connection.');
        }
    }

    /** Shows/clears the 'Enhancing...' state on the generate button while an auto-enhance request runs, so
     * the UI is not silently frozen during the writer host's cold-start latency. */
    setGenerateButtonBusy(busy) {
        if (busy) {
            this.generateButtonOriginalText = this.generateButton.innerText;
            this.generateButton.innerText = 'Enhancing...';
            this.generateButton.classList.add('prompt-enhance-generating');
        }
        else {
            if (this.generateButtonOriginalText != null) {
                this.generateButton.innerText = this.generateButtonOriginalText;
                this.generateButtonOriginalText = null;
            }
            this.generateButton.classList.remove('prompt-enhance-generating');
        }
    }

    /** Re-dispatches a click on the generate button under the re-entry guard, so the capture-phase
     * interceptor above passes it straight through to the real generate handler instead of intercepting it
     * again. Preserves 'altKey' so an alt-click ("interrupt and regenerate") is not silently downgraded to a
     * plain generate. */
    dispatchGenerateClick(altKey) {
        this.reentryGuard = true;
        this.generateButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: altKey }));
        this.reentryGuard = false;
    }
}

let promptEnhanceHelper = new PromptEnhanceHelperClass();
promptEnhanceHelper.install();
