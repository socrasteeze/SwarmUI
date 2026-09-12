/**
 * Plain-Node regression harness for promptenhance.js - no Playwright, no jsdom, no browser at all.
 *
 * Mirrors the mechanics of src/BuiltinExtensions/MobileEnhancements/verify/verify-genpage-loras.mjs: every
 * method under test is pulled out of the real source file by brace-matching (not retyped or reimplemented),
 * then run against a minimal stand-in for the handful of DOM properties and global helpers that specific
 * method actually touches (a fake element exposes .value/.innerText/.style/.classList/.title; global stubs
 * cover document.getElementById and triggerChangeFor). That harness used a real browser (via Playwright)
 * because it was testing jQuery/select2 integration; nothing here touches jQuery, select2, or real layout,
 * so a plain Node object model is enough to exercise the actual logic in each method.
 *
 * Covers the six behaviors the panel contract requires:
 *   1. streaming chunks accumulate in order into the preview (handleFrame, repeated 'chunk' frames)
 *   2. a 'result' frame enables Apply (handleFrame -> setApplyEnabled)
 *   3. a 'conflict' frame never enables Apply (handleFrame -> showConflict -> setApplyEnabled(false))
 *   4. a 'passthrough' frame shows the marker (handleFrame -> showPassthrough)
 *   5. apply() writes the prompt textbox and the provenance JSON (apply -> recordProvenance)
 *   6. a status response with resolved.profile null disables the button with the reason in its title
 *      (applyStatusToButton -> setButtonEnabled)
 *
 * Extended for a later fix pass: an empty/whitespace-only result is treated like passthrough rather than
 * enabling Apply (handleFrame); "notes" render in their own block rather than the preview (handleFrame); and
 * an unhealthy-but-resolved status no longer disables the button, only explains health in its title
 * (applyStatusToButton).
 *
 * Run with: node src/BuiltinExtensions/PromptEnhance/verify/verify-promptenhance.mjs
 * Exits non-zero if any check fails.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SOURCE_PATH = `${REPO}/src/BuiltinExtensions/PromptEnhance/Assets/promptenhance.js`;
const source = readFileSync(SOURCE_PATH, 'utf8');

// `buildHost`'s `eval` runs lexically inside this module, so any free variable an extracted method reads
// (recordProvenance reads `document` and `triggerChangeFor` as globals, exactly like the real page does) must
// be declared at this same top level to be in scope - a `let` re-declared inside a test's own block would
// shadow these and never be seen by code eval'd from inside buildHost(). Tests that need different fake
// behavior reassign these (no `let`) rather than redeclaring them.
let document = { getElementById: () => null };
let triggerChangeFor = () => {};
// Read by runAutoEnhance (getRequiredElementById('current_model').value) and by the generate-click tests
// (makeWSRequest, MouseEvent) - reassigned per test the same way document/triggerChangeFor are above.
let getRequiredElementById = () => ({ value: '' });
let makeWSRequest = () => null;
let MouseEvent = function(type, init) {
    this.type = type;
    Object.assign(this, init || {});
};
// Read by pref()/setPref() (mode and profile-override persistence). A plain in-memory stand-in for the
// browser's localStorage, keyed the same way.
let localStorage = {
    store: {},
    getItem(key) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null; },
    setItem(key, value) { this.store[key] = String(value); }
};

/** Pulls one class method (by name) out of `src` by brace-matching, starting from its "\n    name(" signature
 * line through the end of its body (inclusive). Returns text usable as an object-literal shorthand method,
 * eg "name(args) {\n ... \n}". Throws if the method or a balanced closing brace cannot be found. */
function extractMethod(src, name) {
    let sigIdx = src.indexOf(`\n    ${name}(`);
    if (sigIdx < 0) {
        throw new Error(`method ${name} not found in source`);
    }
    let i = src.indexOf('{', sigIdx);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] == '{') {
            depth++;
        }
        else if (src[j] == '}') {
            depth--;
            if (depth == 0) {
                return src.slice(sigIdx + 1, j + 1);
            }
        }
    }
    throw new Error(`unbalanced braces extracting method ${name}`);
}

/** Builds an object out of a set of extracted methods, so they can call each other via `this.otherMethod()`
 * exactly as they do in the real class - eval runs in this function's scope, so the assembled methods still
 * close over whatever fake globals (document, triggerChangeFor) this file has declared at the point of call. */
function buildHost(methodNames, extraProps) {
    let pieces = [];
    for (let i = 0; i < methodNames.length; i++) {
        pieces.push(extractMethod(source, methodNames[i]));
    }
    let host = Object.assign({}, extraProps);
    eval(`Object.assign(host, {${pieces.join(',')}});`);
    return host;
}

/** A fake classList backed by a Set, exposing the same add/remove/contains surface the real one does. */
function makeFakeClassList(initial) {
    let set = new Set(initial || []);
    return {
        add(c) { set.add(c); },
        remove(c) { set.delete(c); },
        contains(c) { return set.has(c); }
    };
}

/** A fake DOM element carrying only the properties the methods under test actually read or write. */
function makeFakeElement() {
    return {
        value: '',
        innerText: '',
        title: '',
        style: { display: '' },
        classList: makeFakeClassList(),
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatched: [],
        dispatchEvent(evt) { this.dispatched.push(evt); }
    };
}

/** A fake click event carrying only what onGenerateClick reads/calls: 'altKey', and counters for whether
 * stopPropagation/preventDefault were invoked. */
function makeFakeClickEvent(altKey) {
    return {
        altKey: altKey || false,
        stoppedCount: 0,
        preventedCount: 0,
        stopPropagation() { this.stoppedCount++; },
        preventDefault() { this.preventedCount++; }
    };
}

/** Builds a host exercising the generate-click interceptor and the auto-enhance path behind it
 * (onGenerateClick -> runAutoEnhance -> applyResult/showConflict/showPassthrough -> dispatchGenerateClick),
 * with sensible fakes for every property those methods touch. `overrides` replaces individual defaults. */
function buildAutoEnhanceHost(overrides) {
    let defaults = {
        mode: 'auto',
        buttonEnabled: true,
        reentryGuard: false,
        autoRunning: false,
        profileOverride: '',
        appliedEnhancedText: null,
        lastResult: null,
        applyEnabled: false,
        generateButtonOriginalText: null,
        clearProvenanceListener: null,
        promptBox: makeFakeElement(),
        generateButton: makeFakeElement(),
        panel: { classList: makeFakeClassList() },
        previewArea: makeFakeElement(),
        notesBlock: makeFakeElement(),
        conflictBlock: makeFakeElement(),
        passthroughBlock: makeFakeElement(),
        applyButton: makeFakeElement(),
        statusLine: makeFakeElement()
    };
    return buildHost(
        ['onGenerateClick', 'runAutoEnhance', 'setGenerateButtonBusy', 'dispatchGenerateClick', 'applyResult',
            'recordProvenance', 'armProvenanceClearOnEdit', 'resetPanel', 'showPanel', 'showConflict',
            'showPassthrough', 'setApplyEnabled', 'setStatus'],
        Object.assign(defaults, overrides));
}

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

// ====================================================================================================
// Part 1: streaming chunks accumulate in order into the preview
// ====================================================================================================
{
    let host = buildHost(['handleFrame', 'setStatus', 'setApplyEnabled', 'showConflict', 'showPassthrough'], {
        previewArea: makeFakeElement(),
        statusLine: makeFakeElement(),
        conflictBlock: makeFakeElement(),
        passthroughBlock: makeFakeElement(),
        applyButton: makeFakeElement()
    });
    host.handleFrame({ status: 'running', profile: 'anima', writer_model: 'qwen3:8b', endpoint: 'laptop' });
    let chunks = ['a ', 'cat ', 'sitting ', 'on ', 'a ', 'wall'];
    for (let i = 0; i < chunks.length; i++) {
        host.handleFrame({ chunk: chunks[i] });
    }
    check('chunks accumulate into the preview, in the order they arrived', host.previewArea.value == chunks.join(''), `preview="${host.previewArea.value}"`);
    check('a leading "running" status frame does not touch the preview', !host.previewArea.value.includes('running'), `preview="${host.previewArea.value}"`);
}

// ====================================================================================================
// Part 2: a 'result' frame enables Apply
// ====================================================================================================
{
    let host = buildHost(['handleFrame', 'setStatus', 'setApplyEnabled', 'showConflict', 'showPassthrough'], {
        previewArea: makeFakeElement(),
        statusLine: makeFakeElement(),
        conflictBlock: makeFakeElement(),
        passthroughBlock: makeFakeElement(),
        applyButton: makeFakeElement(),
        applyEnabled: false,
        lastResult: null
    });
    host.applyButton.classList.add('prompt-enhance-disabled');
    host.handleFrame({
        result: 'a photograph of a cat sitting on a garden wall, soft morning light',
        original: 'cat on a wall', profile: 'anima', pack_version: '1.0.0', writer_model: 'qwen3:8b', endpoint: 'laptop', cached: false
    });
    check('a result frame is written into the preview verbatim', host.previewArea.value == 'a photograph of a cat sitting on a garden wall, soft morning light', `preview="${host.previewArea.value}"`);
    check('a result frame enables Apply', host.applyEnabled === true, `applyEnabled=${host.applyEnabled}`);
    check('...and clears the disabled class from the Apply button', !host.applyButton.classList.contains('prompt-enhance-disabled'), `classes still has prompt-enhance-disabled=${host.applyButton.classList.contains('prompt-enhance-disabled')}`);
    check('the result frame is retained for apply() to use later', host.lastResult != null && host.lastResult.profile == 'anima', JSON.stringify(host.lastResult));

    // An empty result string is not a success: it must be treated like passthrough, never enabling Apply.
    let emptyHost = buildHost(['handleFrame', 'setStatus', 'setApplyEnabled', 'showConflict', 'showPassthrough'], {
        previewArea: makeFakeElement(),
        statusLine: makeFakeElement(),
        conflictBlock: makeFakeElement(),
        passthroughBlock: makeFakeElement(),
        applyButton: makeFakeElement(),
        applyEnabled: false,
        lastResult: null
    });
    emptyHost.handleFrame({ result: '   ', profile: 'anima', pack_version: '1.0.0', writer_model: 'qwen3:8b', endpoint: 'laptop', cached: false });
    check('an empty (whitespace-only) result never enables Apply', emptyHost.applyEnabled === false, `applyEnabled=${emptyHost.applyEnabled}`);
    check('...and shows the passthrough marker instead', emptyHost.passthroughBlock.innerText.includes('empty reply'), `passthroughBlock="${emptyHost.passthroughBlock.innerText}"`);

    // "notes" (the split-out NOTES: lines) render in their own muted block, never inside the preview.
    let notesHost = buildHost(['handleFrame', 'setStatus', 'setApplyEnabled', 'showConflict', 'showPassthrough'], {
        previewArea: makeFakeElement(),
        statusLine: makeFakeElement(),
        notesBlock: makeFakeElement(),
        conflictBlock: makeFakeElement(),
        passthroughBlock: makeFakeElement(),
        applyButton: makeFakeElement(),
        applyEnabled: false,
        lastResult: null
    });
    notesHost.handleFrame({ result: 'a cat sitting on a wall', notes: 'NOTES: assumed a house cat', profile: 'anima', pack_version: '1.0.0', writer_model: 'qwen3:8b', endpoint: 'laptop', cached: false });
    check('notes render in their own block', notesHost.notesBlock.innerText == 'NOTES: assumed a house cat', `notesBlock="${notesHost.notesBlock.innerText}"`);
    check('...and are never mixed into the preview text', notesHost.previewArea.value == 'a cat sitting on a wall', `preview="${notesHost.previewArea.value}"`);
}

// ====================================================================================================
// Part 3: a 'conflict' frame never enables Apply (and neither does 'needs_input')
// ====================================================================================================
{
    let host = buildHost(['handleFrame', 'setStatus', 'setApplyEnabled', 'showConflict', 'showPassthrough'], {
        previewArea: makeFakeElement(),
        statusLine: makeFakeElement(),
        conflictBlock: makeFakeElement(),
        passthroughBlock: makeFakeElement(),
        applyButton: makeFakeElement(),
        applyEnabled: false,
        lastResult: null
    });
    // Non-vacuous: prove Apply really can be turned on by this same handleFrame, before proving conflict keeps it off.
    host.handleFrame({ result: 'placeholder', profile: 'p', pack_version: 'v', writer_model: 'm', endpoint: 'e', cached: false });
    check('(setup) Apply is enabled before the conflict frame arrives', host.applyEnabled === true, `applyEnabled=${host.applyEnabled}`);
    host.handleFrame({ conflict: 'CONFLICT: two mutually exclusive characters were requested in one image' });
    check('a conflict frame disables Apply', host.applyEnabled === false, `applyEnabled=${host.applyEnabled}`);
    check('...and renders the conflict line into the red block', host.conflictBlock.innerText.includes('CONFLICT: two mutually exclusive characters'), `conflictBlock="${host.conflictBlock.innerText}"`);
    check('...and the conflict block is shown (display is not "none")', host.conflictBlock.style.display != 'none', `display="${host.conflictBlock.style.display}"`);
    check('...and clears the streamed preview so a stale draft cannot be mistaken for a real result', host.previewArea.value == '', `preview="${host.previewArea.value}"`);

    // needs_input: same hard stop, plus the "profile miss" annotation.
    let host2 = buildHost(['handleFrame', 'setStatus', 'setApplyEnabled', 'showConflict', 'showPassthrough'], {
        previewArea: makeFakeElement(),
        statusLine: makeFakeElement(),
        conflictBlock: makeFakeElement(),
        passthroughBlock: makeFakeElement(),
        applyButton: makeFakeElement(),
        applyEnabled: false,
        lastResult: null
    });
    host2.handleFrame({ needs_input: 'NEEDS INPUT: which character should be in frame?' });
    check('a needs_input frame also never enables Apply', host2.applyEnabled === false, `applyEnabled=${host2.applyEnabled}`);
    check('...and appends the "profile miss - not applied" annotation', host2.conflictBlock.innerText.includes('profile miss - not applied'), `conflictBlock="${host2.conflictBlock.innerText}"`);
}

// ====================================================================================================
// Part 4: a 'passthrough' frame shows the marker (and never enables Apply)
// ====================================================================================================
{
    let host = buildHost(['handleFrame', 'setStatus', 'setApplyEnabled', 'showConflict', 'showPassthrough'], {
        previewArea: makeFakeElement(),
        statusLine: makeFakeElement(),
        conflictBlock: makeFakeElement(),
        passthroughBlock: makeFakeElement(),
        applyButton: makeFakeElement(),
        applyEnabled: false,
        lastResult: null
    });
    host.handleFrame({ passthrough: true, reason: 'writer endpoint unreachable' });
    check('a passthrough frame shows the "Not enhanced: <reason>" marker', host.passthroughBlock.innerText == 'Not enhanced: writer endpoint unreachable', `marker="${host.passthroughBlock.innerText}"`);
    check('...and the marker is shown (display is not "none")', host.passthroughBlock.style.display != 'none', `display="${host.passthroughBlock.style.display}"`);
    check('...and passthrough never enables Apply', host.applyEnabled === false, `applyEnabled=${host.applyEnabled}`);
}

// ====================================================================================================
// Part 5: apply() writes the prompt textbox and the provenance JSON into the hidden param element
// ====================================================================================================
{
    let triggerChangeForCalls = [];
    let fakeElementsById = {
        'input_promptenhanceprovenance': makeFakeElement()
    };
    triggerChangeFor = (elem) => { triggerChangeForCalls.push(elem); };
    document = { getElementById: (id) => fakeElementsById[id] || null };

    let host = buildHost(['apply', 'applyResult', 'recordProvenance', 'armProvenanceClearOnEdit', 'close'], {
        applyEnabled: true,
        appliedEnhancedText: null,
        lastResult: {
            result: 'a photograph of a cat sitting on a garden wall, soft morning light',
            original: 'cat on a wall',
            profile: 'anima',
            pack_version: '1.0.0',
            writer_model: 'qwen3:8b',
            endpoint: 'laptop',
            cached: true
        },
        promptBox: makeFakeElement(),
        panel: { classList: makeFakeClassList(['prompt-enhance-panel-open']) },
        socket: null,
        running: false
    });
    host.apply();

    check('apply() writes the result into the prompt textbox', host.promptBox.value == 'a photograph of a cat sitting on a garden wall, soft morning light', `promptBox.value="${host.promptBox.value}"`);
    check('apply() fires a change/input notification on the textbox (via triggerChangeFor)', triggerChangeForCalls.includes(host.promptBox), `calls=${triggerChangeForCalls.length}`);

    let provenanceElem = fakeElementsById['input_promptenhanceprovenance'];
    let provenance = provenanceElem.value ? JSON.parse(provenanceElem.value) : null;
    check('apply() records provenance as JSON in the hidden param element', provenance != null, `value="${provenanceElem.value}"`);
    check('...with the original prompt, profile, pack version, writer model, endpoint and cached flag', provenance
        && provenance.original == 'cat on a wall'
        && provenance.profile == 'anima'
        && provenance.pack_version == '1.0.0'
        && provenance.writer_model == 'qwen3:8b'
        && provenance.endpoint == 'laptop'
        && provenance.cached === true,
        JSON.stringify(provenance));
    check('...and triggers a change notification on the provenance element too', triggerChangeForCalls.includes(provenanceElem), `calls=${triggerChangeForCalls.length}`);
    check('apply() closes the panel afterward', !host.panel.classList.contains('prompt-enhance-panel-open'), `open=${host.panel.classList.contains('prompt-enhance-panel-open')}`);
    check('apply() remembers the applied text, so a later generate click is not re-enhanced against it', host.appliedEnhancedText == 'a photograph of a cat sitting on a garden wall, soft morning light', `appliedEnhancedText="${host.appliedEnhancedText}"`);

    // Contrast: apply() must be a no-op when Apply is not enabled (eg still mid-stream, or after a conflict).
    let triggerChangeForCalls2 = [];
    let host2 = buildHost(['apply', 'applyResult', 'recordProvenance', 'armProvenanceClearOnEdit', 'close'], {
        applyEnabled: false,
        appliedEnhancedText: null,
        lastResult: { result: 'should not be used' },
        promptBox: makeFakeElement(),
        panel: { classList: makeFakeClassList(['prompt-enhance-panel-open']) },
        socket: null,
        running: false
    });
    // Re-bind the fake globals for this scope (document/triggerChangeFor are read by recordProvenance only,
    // which apply() must not reach when disabled).
    triggerChangeFor = (elem) => { triggerChangeForCalls2.push(elem); };
    host2.apply();
    check('apply() does nothing when Apply is not enabled', host2.promptBox.value == '' && triggerChangeForCalls2.length == 0, `promptBox.value="${host2.promptBox.value}", calls=${triggerChangeForCalls2.length}`);
}

// ====================================================================================================
// Part 6: a status response with resolved.profile null disables the button with the reason in its title
// ====================================================================================================
{
    let host = buildHost(['applyStatusToButton', 'setButtonEnabled'], {
        button: makeFakeElement(),
        buttonEnabled: true
    });
    host.button.classList.remove('prompt-enhance-disabled'); // start enabled, to prove this call is what disables it
    host.applyStatusToButton({
        pack_version: '1.0.0',
        profiles: [],
        endpoints: [{ id: 'laptop', url: 'http://127.0.0.1:11434', kind: 'ollama', model: 'qwen3:8b', enabled: true, healthy: true }],
        resolved: { profile: null, reason: "No writer profile for model class 'stable-diffusion-xl-v1'" }
    });
    check('resolved.profile == null disables the button', host.buttonEnabled === false, `buttonEnabled=${host.buttonEnabled}`);
    check('...and sets the reason as the button title', host.button.title == "No writer profile for model class 'stable-diffusion-xl-v1'", `title="${host.button.title}"`);
    check('...and applies the disabled class', host.button.classList.contains('prompt-enhance-disabled'), `classes has disabled=${host.button.classList.contains('prompt-enhance-disabled')}`);

    // Contrast: a resolved profile with a healthy endpoint enables the button (proves the check above is non-vacuous).
    let host2 = buildHost(['applyStatusToButton', 'setButtonEnabled'], {
        button: makeFakeElement(),
        buttonEnabled: false
    });
    host2.applyStatusToButton({
        pack_version: '1.0.0',
        profiles: [{ id: 'anima', display: 'Anima', target_model: 'Anima' }],
        endpoints: [{ id: 'laptop', url: 'http://127.0.0.1:11434', kind: 'ollama', model: 'qwen3:8b', enabled: true, healthy: true }],
        resolved: { profile: 'anima', reason: '' }
    });
    check('(contrast) a resolved profile with a healthy endpoint enables the button', host2.buttonEnabled === true, `buttonEnabled=${host2.buttonEnabled}`);

    // A resolved profile but no healthy endpoint must NOT disable the button: the server fails open (a cache
    // hit still answers, or the passthrough marker if it does not), so disabling here would just be a second,
    // redundant gate on the same contract. Health is instead surfaced in the button's title.
    let host3 = buildHost(['applyStatusToButton', 'setButtonEnabled'], {
        button: makeFakeElement(),
        buttonEnabled: false
    });
    host3.applyStatusToButton({
        pack_version: '1.0.0',
        profiles: [{ id: 'anima', display: 'Anima', target_model: 'Anima' }],
        endpoints: [{ id: 'laptop', kind: 'ollama', model: 'qwen3:8b', enabled: true, healthy: false }],
        resolved: { profile: 'anima', reason: '' }
    });
    check('a resolved profile with no healthy endpoint still enables the button (fail-open + cache contract)', host3.buttonEnabled === true, `buttonEnabled=${host3.buttonEnabled}`);
    check('...and the title explains the endpoint is not reachable', host3.button.title.includes('pass through unchanged'), `title="${host3.button.title}"`);
}

// ====================================================================================================
// Part 7: mode 'off' hides the Enhance button; the mode select itself is never hidden
// ====================================================================================================
{
    let host = buildHost(['setMode', 'applyModeToButtonVisibility', 'setPref'], {
        mode: 'review',
        button: makeFakeElement()
    });
    host.setMode('off');
    check('mode "off" hides the Enhance button', host.button.style.display == 'none', `display="${host.button.style.display}"`);
    check('...and the mode is persisted (localStorage, prefixed like interrogate.js\'s prefs)', localStorage.getItem('promptenhance_mode') == 'off', `stored="${localStorage.getItem('promptenhance_mode')}"`);
    host.setMode('auto');
    check('switching back to "auto" shows the button again', host.button.style.display == '', `display="${host.button.style.display}"`);
}

// ====================================================================================================
// Part 8: mode 'auto' intercepts the generate click exactly once and re-dispatches on result
// ====================================================================================================
{
    let promptBox = makeFakeElement();
    promptBox.value = 'a cat';
    let host = buildAutoEnhanceHost({ promptBox: promptBox });
    let reentryDuringDispatch = null;
    host.generateButton.innerText = 'Generate';
    host.generateButton.dispatchEvent = function(evt) {
        reentryDuringDispatch = host.reentryGuard;
        this.dispatched.push(evt);
    };
    let capturedInData = null;
    let capturedOnFrame = null;
    makeWSRequest = (url, inData, onFrame) => {
        capturedInData = inData;
        capturedOnFrame = onFrame;
        return { fake: true };
    };
    getRequiredElementById = () => ({ value: 'some_model.safetensors' });

    let event = makeFakeClickEvent(false);
    host.onGenerateClick(event);
    check('the click is intercepted exactly once (stopPropagation and preventDefault each called once)', event.stoppedCount == 1 && event.preventedCount == 1, `stopped=${event.stoppedCount} prevented=${event.preventedCount}`);
    check('exactly one EnhancePrompt request is sent, carrying the current prompt', capturedInData != null && capturedInData.prompt == 'a cat', `inData=${JSON.stringify(capturedInData)}`);
    check('the generate button is not re-clicked while the request is still in flight', host.generateButton.dispatched.length == 0, `dispatched=${host.generateButton.dispatched.length}`);
    check('the generate button shows an "Enhancing..." busy state while it runs', host.generateButton.innerText == 'Enhancing...', `innerText="${host.generateButton.innerText}"`);

    capturedOnFrame({ result: 'a photograph of a cat', original: 'a cat', profile: 'anima', pack_version: '1.0.0', writer_model: 'm', endpoint: 'writer', cached: false });
    check('on result: the prompt box is written with the enhanced text (the existing apply path)', host.promptBox.value == 'a photograph of a cat', `promptBox.value="${host.promptBox.value}"`);
    check('on result: the generate click is re-dispatched exactly once', host.generateButton.dispatched.length == 1, `dispatched=${host.generateButton.dispatched.length}`);
    check('...under the re-entry guard (true during the synthetic dispatch)', reentryDuringDispatch === true, `reentryGuard during dispatch=${reentryDuringDispatch}`);
    check('...and the guard is back off once the synthetic dispatch returns', host.reentryGuard === false, `reentryGuard=${host.reentryGuard}`);
    check('the busy state is cleared again once the result arrives', host.generateButton.innerText == 'Generate', `innerText="${host.generateButton.innerText}"`);

    let secondClick = makeFakeClickEvent(false);
    host.onGenerateClick(secondClick);
    check('a second click on the now-applied prompt is left completely untouched - never re-enhanced against its own output', secondClick.stoppedCount == 0 && secondClick.preventedCount == 0 && host.generateButton.dispatched.length == 1, `stopped=${secondClick.stoppedCount}, dispatched=${host.generateButton.dispatched.length}`);
}

// ====================================================================================================
// Part 9: a conflict in auto mode blocks generation entirely
// ====================================================================================================
{
    let promptBox = makeFakeElement();
    promptBox.value = 'two mutually exclusive subjects';
    let host = buildAutoEnhanceHost({ promptBox: promptBox });
    let capturedOnFrame = null;
    makeWSRequest = (url, inData, onFrame) => {
        capturedOnFrame = onFrame;
        return { fake: true };
    };
    getRequiredElementById = () => ({ value: 'some_model.safetensors' });

    host.onGenerateClick(makeFakeClickEvent(false));
    capturedOnFrame({ conflict: 'CONFLICT: too many subjects for one image.' });
    check('a conflict in auto mode never re-dispatches the generate click - generation is blocked', host.generateButton.dispatched.length == 0, `dispatched=${host.generateButton.dispatched.length}`);
    check('...and shows the existing red block with the conflict line', host.conflictBlock.innerText == 'CONFLICT: too many subjects for one image.', `conflictBlock="${host.conflictBlock.innerText}"`);
    check('...with the panel actually shown so the user sees it', host.panel.classList.contains('prompt-enhance-panel-open'), `open=${host.panel.classList.contains('prompt-enhance-panel-open')}`);
    check('the original prompt is left untouched (nothing was applied)', host.promptBox.value == 'two mutually exclusive subjects', `promptBox.value="${host.promptBox.value}"`);
}

// ====================================================================================================
// Part 10: passthrough (and a transport error) in auto mode generates anyway, fail-open
// ====================================================================================================
{
    let promptBox = makeFakeElement();
    promptBox.value = 'a cat';
    let host = buildAutoEnhanceHost({ promptBox: promptBox });
    let capturedOnFrame = null;
    makeWSRequest = (url, inData, onFrame) => {
        capturedOnFrame = onFrame;
        return { fake: true };
    };
    getRequiredElementById = () => ({ value: 'some_model.safetensors' });

    host.onGenerateClick(makeFakeClickEvent(false));
    capturedOnFrame({ passthrough: true, reason: 'No writer endpoint is reachable' });
    check('a passthrough in auto mode still generates, with the original prompt untouched', host.generateButton.dispatched.length == 1 && host.promptBox.value == 'a cat', `dispatched=${host.generateButton.dispatched.length}, promptBox.value="${host.promptBox.value}"`);
    check('...and shows the existing "Not enhanced" marker', host.passthroughBlock.innerText == 'Not enhanced: No writer endpoint is reachable', `passthroughBlock="${host.passthroughBlock.innerText}"`);

    let promptBox2 = makeFakeElement();
    promptBox2.value = 'a dog';
    let host2 = buildAutoEnhanceHost({ promptBox: promptBox2 });
    makeWSRequest = (url, inData, onFrame, depth, onError) => {
        onError('connection refused');
        return { fake: true };
    };
    host2.onGenerateClick(makeFakeClickEvent(false));
    check('a transport error in auto mode also fails open: generates anyway with the original prompt', host2.generateButton.dispatched.length == 1 && host2.promptBox.value == 'a dog', `dispatched=${host2.generateButton.dispatched.length}, promptBox.value="${host2.promptBox.value}"`);
    check('...and shows the "Not enhanced" marker carrying the error text', host2.passthroughBlock.innerText == 'Not enhanced: connection refused', `passthroughBlock="${host2.passthroughBlock.innerText}"`);
}

// ====================================================================================================
// Part 11: the profile-override dropdown enables the button when automatic resolution returned null
// ====================================================================================================
{
    let host = buildHost(['applyStatusToButton', 'setButtonEnabled'], {
        button: makeFakeElement(),
        buttonEnabled: true
    });
    // Automatic resolution finds nothing - eg one of the plain-SDXL or qwen-image checkpoints outside any
    // folder/class map.
    host.applyStatusToButton({
        profiles: [{ id: 'illustriousxl', display: 'IllustriousXL', target_model: 'IllustriousXL' }],
        endpoints: [{ id: 'writer', kind: 'ollama', model: 'm', enabled: true, healthy: true }],
        resolved: { profile: null, reason: "No writer profile for model class 'stable-diffusion-xl-v1'" }
    });
    check('(setup) automatic resolution finding nothing disables the button', host.buttonEnabled === false, `buttonEnabled=${host.buttonEnabled}`);
    // The user picks a profile in the panel's override <select>; the resulting status re-check (now carrying
    // profile_override) resolves and re-enables the button - the escape hatch for unmapped models.
    host.applyStatusToButton({
        profiles: [{ id: 'illustriousxl', display: 'IllustriousXL', target_model: 'IllustriousXL' }],
        endpoints: [{ id: 'writer', kind: 'ollama', model: 'm', enabled: true, healthy: true }],
        resolved: { profile: 'illustriousxl', reason: null }
    });
    check('selecting a profile override re-enables the button that automatic resolution had disabled', host.buttonEnabled === true, `buttonEnabled=${host.buttonEnabled}`);
}

// ====================================================================================================
// Part 12: the profile-override <select> is filled with 'Automatic' plus every registered profile, once
// ====================================================================================================
{
    document = { createElement: () => ({}) };
    let select = { children: [], dataset: {}, appendChild(opt) { this.children.push(opt); } };
    let host = buildHost(['populateProfileOptions'], {
        profileSelect: select,
        profileOverride: ''
    });
    host.populateProfileOptions([{ id: 'anima', display: 'Anima', target_model: 'Anima' }, { id: 'illustriousxl', display: 'IllustriousXL', target_model: 'IllustriousXL' }]);
    check('the "Automatic" default option is added first', select.children[0].value == '' && select.children[0].innerText == 'Automatic', JSON.stringify(select.children[0]));
    check('every registered profile is added as an option', select.children.length == 3 && select.children[1].value == 'anima' && select.children[2].value == 'illustriousxl', `count=${select.children.length}`);
    host.populateProfileOptions([{ id: 'anima', display: 'Anima', target_model: 'Anima' }]);
    check('a repeated call does not re-add options (the registry does not change at runtime)', select.children.length == 3, `count=${select.children.length}`);
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
