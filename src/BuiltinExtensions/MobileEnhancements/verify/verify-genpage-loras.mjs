/**
 * Lazy-multiselect regression harness (fork) for the genpage LoRA dropdown perf work in commit 87924ad9
 * (2026-09-06 sweep; see AGENTS.md Fork Delta and docs/MobilePWA-Optimization-Plan.md). That commit had
 * zero automated coverage of its own lazy-adapter code, and four defects in it were only found by hand
 * during the sweep - every one of them shipped through a full gate pass unnoticed. This harness exists so
 * that never happens again silently.
 *
 * Covers: site.js's buildLazyMultiselectAjaxSource (paging, search, and the live-list getter that must
 * survive coreModelMap being REPLACED wholesale by updateAllModels()); makeMultiselectInput's lazy branch
 * rendering an out-of-page pre-selected value as a chip; loras.js's LoraHelper.rebuildParams(); and
 * presets.js's clearPresetView() and params.js's refreshParameterValues() both needing to treat a lazy
 * <select> as "carries no <option> list" rather than either silently dropping the selection or bulk-filling
 * it (which would re-pay the exact multi-second DOM cost the lazy path exists to avoid).
 *
 * Approach: like verify-mobile-perf.mjs (whose "Part 4" already covers makeMultiselectInput and
 * fillLazyMultiselectOnOpen this way), every function under test is extracted from its real source file by
 * brace-matching - not retyped or reimplemented - and run against real jQuery/select2 with the surrounding
 * genpage machinery (session, other params, the model browser, presets UI) stubbed to the minimum each
 * function actually touches. This is chosen over verify-genpage-clipboard.mjs's live-server approach because
 * rebuildParams(), clearPresetView() and refreshParameterValues() are reachable from a live Text2Image page
 * only through a long chain of user gestures each needing a fully-populated LoRA library, a preset, and a
 * model refresh round-trip - none of which is what's actually being asserted here. Extracting the exact
 * functions and driving them directly tests the real regression (the lazy-<select>-has-no-options interaction)
 * without that scaffolding, and is what these four defects actually were: pure logic bugs in how each
 * function reasoned about an empty <select>, not anything a live page adds.
 *
 * Every check below is proven to fail against the pre-fix code (see the "run harness against reverted fix"
 * transcript recorded in HANDOFF.md / the task report for this file - items 4, 5, 6 and 7 were verified by
 * temporarily reverting each corresponding fix in the working tree, re-running this file, and restoring the
 * file byte-for-byte afterward).
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling rather
 * than part of the CI gate. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-genpage-loras.mjs
 * Set SWARM_CHROMIUM to override the browser path. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SITE_JS = `${REPO}/src/wwwroot/js/site.js`;
const PARAMS_JS = `${REPO}/src/wwwroot/js/genpage/gentab/params.js`;
const LORAS_JS = `${REPO}/src/wwwroot/js/genpage/gentab/loras.js`;
const PRESETS_JS = `${REPO}/src/wwwroot/js/genpage/gentab/presets.js`;
const UTIL_JS = `${REPO}/src/wwwroot/js/util.js`;
const JQUERY_JS = `${REPO}/src/wwwroot/js/lib/jquery.min.js`;
const SELECT2_JS = `${REPO}/src/wwwroot/js/lib/select2.min.js`;

/** Pull a top-level `function name(...) {...}` out of a file by brace-matching. */
function extractFunction(src, name) {
    const sigIdx = src.indexOf(`\nfunction ${name}(`);
    if (sigIdx < 0) {
        throw new Error(`function ${name} not found`);
    }
    let i = src.indexOf('{', sigIdx);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] == '{') { depth++; }
        else if (src[j] == '}') {
            depth--;
            if (depth == 0) {
                return src.slice(sigIdx + 1, j + 1);
            }
        }
    }
    throw new Error(`unbalanced braces in ${name}`);
}

/** Pull a whole method out of a class body by brace-matching from its signature. */
function extractMethod(src, name) {
    const sigIdx = src.indexOf(`\n    ${name}(`);
    if (sigIdx < 0) {
        throw new Error(`method ${name} not found`);
    }
    let i = src.indexOf('{', sigIdx);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] == '{') { depth++; }
        else if (src[j] == '}') {
            depth--;
            if (depth == 0) {
                return src.slice(sigIdx + 1, j + 1);
            }
        }
    }
    throw new Error(`unbalanced braces in ${name}`);
}

const siteSrc = readFileSync(SITE_JS, 'utf8');
const paramsSrc = readFileSync(PARAMS_JS, 'utf8');
const lorasSrc = readFileSync(LORAS_JS, 'utf8');
const presetsSrc = readFileSync(PRESETS_JS, 'utf8');
const utilSrc = readFileSync(UTIL_JS, 'utf8');

// The real page size buildLazyMultiselectAjaxSource paginates by - read out of the source rather than
// hardcoded, so a future change to the constant doesn't quietly desync this harness from what it's checking.
const pageSizeMatch = siteSrc.match(/\nlet lazyMultiselectPageSize = (\d+);/);
if (!pageSizeMatch) {
    throw new Error('lazyMultiselectPageSize declaration not found in site.js');
}
const PAGE_SIZE = parseInt(pageSizeMatch[1]);

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});

// ====================================================================================================
// Part 1/2/4: buildLazyMultiselectAjaxSource (site.js) - paging, search, and the live-list getter
// ====================================================================================================

const ajaxPage = await browser.newPage();
await ajaxPage.setContent('<!doctype html><html><body></body></html>');

const ajaxOut = await ajaxPage.evaluate(({ buildSrc, pageSize }) => {
    let lazyMultiselectPageSize = pageSize;
    eval(buildSrc);

    /** transport() calls its success callback synchronously (it's a local-array filter, not a real
     * network request; see the docstring on buildLazyMultiselectAjaxSource) so this can just capture it. */
    function query(src, term, page) {
        let out = null;
        src.transport({ data: { q: term, page } }, (data) => { out = data; });
        return out;
    }

    // ---- Paging: exact page size, correct offset, and `more` flips false on the last page ----
    let list = Array.from({ length: pageSize * 2 + 30 }, (_, i) => `lora_${String(i).padStart(4, '0')}`);
    let p1 = query({ transport: buildLazyMultiselectAjaxSource(list).transport }, '', 1);
    let p2 = query({ transport: buildLazyMultiselectAjaxSource(list).transport }, '', 2);
    let p3 = query({ transport: buildLazyMultiselectAjaxSource(list).transport }, '', 3);

    // ---- Search: case-insensitive substring, same as select2's old default matcher ----
    let searchList = ['Foo Bar Baz', 'QUUX', 'nothing here', 'FooBAR', 'unrelated entry'];
    let searchSrc = buildLazyMultiselectAjaxSource(searchList);
    let hitLower = query(searchSrc, 'bar', 1);
    let hitUpper = query(searchSrc, 'BAR', 1);
    let miss = query(searchSrc, 'zzz-nomatch-zzz', 1);

    // ---- Live-list getter: the function form re-resolves per query, so a REPLACED backing list (as
    // updateAllModels() replaces coreModelMap wholesale, not by mutating it in place) is picked up with no
    // re-init. Built as its own local `coreModelMap`-shaped variable so the assertion is exactly the
    // documented contract, not an artefact of how the real global happens to be structured today. ----
    let coreModelMap = { LoRA: ['old1', 'old2'] };
    let getListValues = () => coreModelMap['LoRA'];
    let liveSrc = buildLazyMultiselectAjaxSource(getListValues);
    let beforeReplace = query(liveSrc, '', 1);
    coreModelMap = { LoRA: ['new1', 'new2', 'new3'] }; // REPLACED wholesale, not mutated in place
    let afterReplace = query(liveSrc, '', 1);

    // Contrast case, proving the check above is non-vacuous: an ajax source built over the ARRAY (captured
    // once, the bug buildLazyMultiselectAjaxSource's function-form exists to avoid) really does go stale
    // after the same kind of replace.
    let capturedSrc = buildLazyMultiselectAjaxSource(getListValues());
    let capturedBefore = query(capturedSrc, '', 1);
    coreModelMap = { LoRA: ['newer1'] };
    let capturedAfter = query(capturedSrc, '', 1);

    return {
        p1: { count: p1.results.length, first: p1.results[0]?.id, last: p1.results[p1.results.length - 1]?.id, more: p1.pagination.more },
        p2: { count: p2.results.length, first: p2.results[0]?.id, more: p2.pagination.more },
        p3: { count: p3.results.length, first: p3.results[0]?.id, more: p3.pagination.more },
        listLength: list.length,
        hitLower: hitLower.results.map(r => r.id),
        hitUpper: hitUpper.results.map(r => r.id),
        miss: { count: miss.results.length, more: miss.pagination.more },
        beforeReplace: beforeReplace.results.map(r => r.id),
        afterReplace: afterReplace.results.map(r => r.id),
        capturedBefore: capturedBefore.results.map(r => r.id),
        capturedAfter: capturedAfter.results.map(r => r.id)
    };
}, { buildSrc: extractFunction(siteSrc, 'buildLazyMultiselectAjaxSource'), pageSize: PAGE_SIZE });

check(`page 1 returns exactly ${PAGE_SIZE} results with more:true`, ajaxOut.p1.count === PAGE_SIZE && ajaxOut.p1.more === true, JSON.stringify(ajaxOut.p1));
check(`page 1 starts at the first entry`, ajaxOut.p1.first === 'lora_0000', `first=${ajaxOut.p1.first}`);
check(`page 2 starts at the correct offset (index ${PAGE_SIZE})`, ajaxOut.p2.first === `lora_${String(PAGE_SIZE).padStart(4, '0')}` && ajaxOut.p2.count === PAGE_SIZE && ajaxOut.p2.more === true, JSON.stringify(ajaxOut.p2));
check(`the final page returns the remainder and sets more:false`, ajaxOut.p3.count === (ajaxOut.listLength - PAGE_SIZE * 2) && ajaxOut.p3.more === false, JSON.stringify(ajaxOut.p3));
check('search matches case-insensitively (lowercase term)', JSON.stringify(ajaxOut.hitLower.sort()) === JSON.stringify(['FooBAR', 'Foo Bar Baz'].sort()), JSON.stringify(ajaxOut.hitLower));
check('search matches case-insensitively (uppercase term)', JSON.stringify(ajaxOut.hitUpper.sort()) === JSON.stringify(['FooBAR', 'Foo Bar Baz'].sort()), JSON.stringify(ajaxOut.hitUpper));
check('a term matching nothing returns an empty result set, not a throw', ajaxOut.miss.count === 0 && ajaxOut.miss.more === false, JSON.stringify(ajaxOut.miss));
check('live getter sees the list before any replace', JSON.stringify(ajaxOut.beforeReplace) === JSON.stringify(['old1', 'old2']), JSON.stringify(ajaxOut.beforeReplace));
check('after the backing list is REPLACED, the adapter serves the new list', JSON.stringify(ajaxOut.afterReplace) === JSON.stringify(['new1', 'new2', 'new3']), JSON.stringify(ajaxOut.afterReplace));
check('(contrast) a captured-array source sees the list before replace too', JSON.stringify(ajaxOut.capturedBefore) === JSON.stringify(['new1', 'new2', 'new3']), JSON.stringify(ajaxOut.capturedBefore));
check('(contrast) ...but a captured-array source goes stale after the same replace - proves the check above is real', JSON.stringify(ajaxOut.capturedAfter) === JSON.stringify(['new1', 'new2', 'new3']) && JSON.stringify(ajaxOut.capturedAfter) !== JSON.stringify(['newer1']), JSON.stringify(ajaxOut.capturedAfter));

// ====================================================================================================
// Part 3: an out-of-page pre-selected value still renders as a select2 chip
// ====================================================================================================

const chipPage = await browser.newPage();
await chipPage.setContent('<!doctype html><html><body><div id="host"></div></body></html>');
await chipPage.addScriptTag({ content: readFileSync(JQUERY_JS, 'utf8') });
await chipPage.addScriptTag({ content: readFileSync(SELECT2_JS, 'utf8') });

const chipOut = await chipPage.evaluate(({ makeMulti, buildSrc, pageSizeDecl, threshold }) => {
    // Minimal stand-ins for the page helpers makeMultiselectInput leans on (same set verify-mobile-perf.mjs
    // uses for the same function), so the real function runs unmodified.
    function escapeHtml(t) { return `${t}`.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
    function escapeHtmlNoBr(t) { return escapeHtml(t); }
    function translateableHtml(t) { return t; }
    function getToggleHtml() { return ''; }
    function getPopoverElemsFor() { return ['', '']; }
    let multiselectLazyThreshold = threshold;
    let lazyMultiselectPageSize = pageSizeDecl;
    eval(makeMulti);
    eval(buildSrc);

    let big = Array.from({ length: pageSizeDecl * 6 }, (_, i) => `some/folder/loraName_${i}.safetensors`);
    // Index chosen to sit on page 5 (1-based) of a pageSizeDecl-sized paginator - i.e. never on page 1.
    let outOfPageIndex = pageSizeDecl * 4 + 3;
    let defaultVal = big[outOfPageIndex];

    let host = document.getElementById('host');
    host.innerHTML = makeMultiselectInput('', 'chip_sel', 'loras', 'LoRAs', '', big, defaultVal, 'Select...');
    let elem = document.getElementById('chip_sel');
    let optionPresent = !!elem.querySelector(`option[value="${CSS.escape(defaultVal)}"]`);
    let preSelected = [...elem.selectedOptions].map(o => o.value);

    $(elem).select2({ theme: 'bootstrap-5', width: 'style', closeOnSelect: false, ajax: buildLazyMultiselectAjaxSource(() => big), minimumInputLength: 0 });
    let chips = [...document.querySelectorAll('#chip_sel + span .select2-selection__choice')].map(c => c.getAttribute('title') || c.textContent.trim());

    return { outOfPageIndex, defaultVal, optionPresent, preSelected, chips, lazyFlag: !!elem.dataset.lazyOptions };
}, { makeMulti: extractFunction(siteSrc, 'makeMultiselectInput'), buildSrc: extractFunction(siteSrc, 'buildLazyMultiselectAjaxSource'), pageSizeDecl: PAGE_SIZE, threshold: 10 });

check('the control actually went lazy for this test (check is non-vacuous)', chipOut.lazyFlag, `lazyOptions=${chipOut.lazyFlag}`);
check(`the pre-selected value (index ${chipOut.outOfPageIndex}, not on page 1) has a real <option>`, chipOut.optionPresent, `value=${chipOut.defaultVal}`);
check('...and is selected before select2 even initializes', JSON.stringify(chipOut.preSelected) === JSON.stringify([chipOut.defaultVal]), JSON.stringify(chipOut.preSelected));
check('...and select2 renders it as a chip', chipOut.chips.some(c => c.includes(chipOut.defaultVal)), JSON.stringify(chipOut.chips));

// ====================================================================================================
// Part 5: loras.js LoraHelper.rebuildParams() - selecting a LoRA when the select has no <option>s must
// still end with it in this.selected. This is the regression where clicking a LoRA in the model browser
// did nothing at all: the lazy <select> starts genuinely empty, .val() has nothing to select, and the
// "hack reorder selected to match the select2 input" step then reads back an empty options list and wipes
// this.selected clean.
// ====================================================================================================

const loraPage = await browser.newPage();
await loraPage.setContent(`<!doctype html><html><body>
    <select id="input_loras" multiple></select>
    <input id="input_loraweights" value="">
    <input id="input_lorasectionconfinement" value="">
</body></html>`);
await loraPage.addScriptTag({ content: readFileSync(JQUERY_JS, 'utf8') });

const loraOut = await loraPage.evaluate(({ arraysEqualSrc, triggerChangeForSrc, getSelSrc, rebuildSrc }) => {
    eval(arraysEqualSrc);
    eval(triggerChangeForSrc);
    let host = {
        selected: [{ name: 'folder/myLora', weight: 1, confinement: 0 }],
        rendered: {},
        loraWeightPref: {},
        loraConfinementPref: {},
        dedup: false,
        getLorasInput() { return document.getElementById('input_loras'); },
        getLoraWeightsInput() { return document.getElementById('input_loraweights'); },
        getLoraConfinementInput() { return document.getElementById('input_lorasectionconfinement'); }
    };
    eval(`Object.assign(host, {${getSelSrc},${rebuildSrc}});`);

    let optionsBefore = document.getElementById('input_loras').options.length;
    host.rebuildParams();
    let loraInput = document.getElementById('input_loras');
    return {
        optionsBefore,
        optionsAfter: loraInput.options.length,
        selectedAfter: host.selected.map(l => l.name),
        selectValAfter: $(loraInput).val(),
        weightsAfter: document.getElementById('input_loraweights').value
    };
}, {
    arraysEqualSrc: extractFunction(utilSrc, 'arraysEqual'),
    triggerChangeForSrc: extractFunction(siteSrc, 'triggerChangeFor'),
    getSelSrc: extractMethod(lorasSrc, 'getLoraParamSelections'),
    rebuildSrc: extractMethod(lorasSrc, 'rebuildParams')
});

check('the LoRAs <select> starts with no <option>s (check is non-vacuous)', loraOut.optionsBefore === 0, `${loraOut.optionsBefore} options before`);
check('rebuildParams() appends the missing <option> before selecting it', loraOut.optionsAfter === 1, `${loraOut.optionsAfter} options after`);
check('...and the select actually reports it selected', JSON.stringify(loraOut.selectValAfter) === JSON.stringify(['folder/myLora']), JSON.stringify(loraOut.selectValAfter));
check('a LoRA selected while the select had no options still ends up in this.selected', JSON.stringify(loraOut.selectedAfter) === JSON.stringify(['folder/myLora']), JSON.stringify(loraOut.selectedAfter));
check('the weights param is kept in sync', loraOut.weightsAfter === '1', `weights="${loraOut.weightsAfter}"`);

// ====================================================================================================
// Part 6: presets.js clearPresetView() - the live LoRA selection must be carried into the preset modal's
// copy even though that <select> is also lazy and starts genuinely empty.
// ====================================================================================================

const presetPage = await browser.newPage();
await presetPage.setContent(`<!doctype html><html><body>
    <input type="checkbox" id="preset_advanced_options_checkbox">
    <input id="new_preset_name" value="">
    <input id="preset_description" value="">
    <input id="new_preset_modal_error" value="">
    <select id="input_loras" multiple>
        <option value="folder/liveLoraA" selected>a</option>
        <option value="folder/liveLoraB" selected>b</option>
    </select>
    <select id="preset_input_loras" multiple></select>
    <input type="checkbox" id="preset_input_loras_toggle">
</body></html>`);
await presetPage.addScriptTag({ content: readFileSync(JQUERY_JS, 'utf8') });

const presetOut = await presetPage.evaluate(({ getReqSrc, triggerChangeForSrc, clearViewSrc }) => {
    eval(getReqSrc);
    eval(triggerChangeForSrc);
    let preset_to_edit = 'not-yet-cleared';
    let gen_param_types = [{ id: 'loras', type: 'list' }];
    let presetHelpers = { imageElem: document.createElement('input'), enableImageElem: document.createElement('input') };
    presetHelpers.enableImageElem.type = 'checkbox';
    let preset_toggle_advanced = () => {};
    let clearMediaFileInput = () => {};
    let doToggleEnable = () => {};
    eval(clearViewSrc);

    let presetElemBefore = document.getElementById('preset_input_loras').options.length;
    clearPresetView();
    let presetElem = document.getElementById('preset_input_loras');
    return {
        presetOptionsBefore: presetElemBefore,
        presetOptionsAfter: presetElem.options.length,
        presetSelectedAfter: $(presetElem).val(),
        presetToEditCleared: preset_to_edit === null
    };
}, {
    getReqSrc: extractFunction(utilSrc, 'getRequiredElementById'),
    triggerChangeForSrc: extractFunction(siteSrc, 'triggerChangeFor'),
    clearViewSrc: extractFunction(presetsSrc, 'clearPresetView')
});

check('the preset copy of the LoRAs select starts genuinely empty (check is non-vacuous)', presetOut.presetOptionsBefore === 0, `${presetOut.presetOptionsBefore} options before`);
check('clearPresetView() appends the live selection into the (lazy, empty) preset copy', presetOut.presetOptionsAfter === 2, `${presetOut.presetOptionsAfter} options after`);
check('...and the preset copy actually shows both as selected', JSON.stringify((presetOut.presetSelectedAfter || []).slice().sort()) === JSON.stringify(['folder/liveLoraA', 'folder/liveLoraB']), JSON.stringify(presetOut.presetSelectedAfter));
check('preset_to_edit is cleared as part of the same call (sanity: the real function ran)', presetOut.presetToEditCleared, `preset_to_edit cleared=${presetOut.presetToEditCleared}`);

// ====================================================================================================
// Part 7: params.js refreshParameterValues() must not bulk-append the whole refreshed value list into a
// lazy <select> - the entire point of the lazy path is that its <option> list is never materialized ahead
// of time (see makeMultiselectInput / buildLazyMultiselectAjaxSource in site.js).
// ====================================================================================================

const refreshPage = await browser.newPage();
await refreshPage.setContent(`<!doctype html><html><body>
    <select id="input_loras" multiple data-lazy-options="true">
        <option value="folder/preselected" selected>preselected</option>
    </select>
</body></html>`);
await refreshPage.addScriptTag({ content: readFileSync(JQUERY_JS, 'utf8') });

const refreshOut = await refreshPage.evaluate(async ({ refreshSrc }) => {
    let gen_param_types = [{ id: 'loras', type: 'list', values: null, value_names: null }];
    let refreshParamsExtra = [];
    let calledback = false;
    function genericRequest(url, inData, callback) {
        callback({
            list: [{ id: 'loras', values: ['folder/preselected', 'folder/other1', 'folder/other2', 'folder/other3'], value_names: null }],
            models: {},
            wildcards: []
        });
    }
    function loadUserData() {}
    function updateAllModels() {}
    let wildcardHelpers = { newWildcardList: () => {} };
    function hideUnsupportableParams() {}
    eval(refreshSrc);

    let optionsBefore = document.getElementById('input_loras').options.length;
    await new Promise(resolveOuter => {
        refreshParameterValues(true, null, () => { calledback = true; resolveOuter(); });
    });
    let elem = document.getElementById('input_loras');
    return {
        optionsBefore,
        optionsAfter: elem.options.length,
        stillLazy: !!elem.dataset.lazyOptions,
        calledback
    };
}, { refreshSrc: extractFunction(paramsSrc, 'refreshParameterValues') });

check('refreshParameterValues() actually ran its callback (check is non-vacuous)', refreshOut.calledback, `calledback=${refreshOut.calledback}`);
check('the lazy select is untouched by the refresh - no bulk append of the whole list', refreshOut.optionsAfter === refreshOut.optionsBefore, `${refreshOut.optionsBefore} -> ${refreshOut.optionsAfter} options (list had 4 values)`);
check('the lazy flag survives the refresh (still deferred, not silently filled)', refreshOut.stillLazy, `lazyOptions=${refreshOut.stillLazy}`);

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
