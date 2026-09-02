/**
 * /simple preset editor harness (fork). The Create tab could always SELECT a preset and never change one, so
 * this covers the editor that closes that gap (More > Presets, m_presets.js). Every check is aimed at a way
 * the round trip through AddNewPreset can silently corrupt a preset rather than fail:
 *
 * 1. preview_image is never sent. The list copy of it is a /ViewSpecial/Preset/<title> URL that AddNewPreset
 *    rejects outright, and omitting the field is the only thing that makes the server keep the image the
 *    preset already had. Sending it back would fail the save; sending it as empty would blank the image.
 * 2. An edit is an edit. is_edit plus `editing` set to the ORIGINAL title is what distinguishes "rename this
 *    preset" from "make a second one" - get it wrong and every edit forks a duplicate.
 * 3. A rename carries the active selection with it, or the preset stays switched on under a title that no
 *    longer exists and quietly stops applying to generations.
 * 4. Capture reads the base params, not the merged generation input: buildGenInput folds in whatever presets
 *    are already active and resolves the aspect ratio to pixels, so capturing it bakes another preset's
 *    values into this one.
 * 5. Deleting a preset that is currently active drops it from the active list too.
 * 6. Parameters this client has no control for still round-trip untouched.
 *
 * Runs the REAL shipped source: index.html with its server tokens substituted, the real m.css, and the real
 * m_*.js modules, with the Create panel built directly instead of booting (m_app.js is stubbed out, since
 * there is no server here). The preset routes are answered by an in-page fake that records every payload.
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling rather than
 * part of the CI gate. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-presets.mjs
 * Set SWARM_CHROMIUM to override the browser path. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const M = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m`;
const TAGDEX = `${REPO}/src/BuiltinExtensions/TagDex/Assets`;
const WIDTH = 390, HEIGHT = 844;

const TOAST = '<div class="center-toast toast-error-box" id="center_toast">'
    + '<div class="toast hide" id="error_toast_box"><div class="toast-body" id="error_toast_content"></div></div></div>';
const html = readFileSync(`${M}/index.html`, 'utf8')
    .replace('[HEADEXTRA]', '')
    .replace('[REMAPS]', '[]')
    .replaceAll('[TOAST]', TOAST)
    .replaceAll('[VARY]', '1');

const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_create.js', 'm_grid.js', 'm_presets.js',
    'm_images.js', 'm_models.js'];
const FILES = {
    '/js/util.js': `${REPO}/src/wwwroot/js/util.js`,
    '/css/site.css': `${REPO}/src/wwwroot/css/site.css`,
    '/css/themes/modern.css': `${REPO}/src/wwwroot/css/themes/modern.css`,
    '/css/themes/modern_dark.css': `${REPO}/src/wwwroot/css/themes/modern_dark.css`,
    '/ExtensionFile/TagDexExtension/Assets/tagdex_core.js': `${TAGDEX}/tagdex_core.js`,
    '/ExtensionFile/TagDexExtension/Assets/m_tagdex.js': `${TAGDEX}/m_tagdex.js`,
    '/ExtensionFile/TagDexExtension/Assets/m_tagdex.css': `${TAGDEX}/m_tagdex.css`,
};
for (const file of CLIENT) {
    FILES[`/ExtensionFile/MobileEnhancementsExtension/Assets/m/${file}`] = `${M}/${file}`;
}

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path == '/simple') {
        return route.fulfill({ contentType: 'text/html', body: html });
    }
    const file = FILES[path];
    if (file) {
        return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript', body: readFileSync(file, 'utf8') });
    }
    return route.fulfill({ contentType: 'application/javascript', body: '' });
});

await page.addInitScript(() => {
    window.showError = function (message) { window.__err = message; };
    window.getUserSetting = () => '';
    window.largeCountStringify = value => `${value}`;
    window.getTextSelRange = () => [0, 0];
    window.makeWSRequest = () => null;
    window.getSession = () => {};
    window.getImageOutPrefix = () => 'View/local';
    window.isValidMediaPath = () => true;
    window.permissions = { hasPermission: () => true };
    // Sheets stack: opening the editor over the manager leaves TWO .m-sheet elements in the document, and a
    // bare querySelector answers from the one underneath. Every check below reads the topmost sheet.
    window.__sheet = () => [...document.querySelectorAll('.m-sheet')].pop();
    window.__calls = [];
    // The preset store the fake server keeps. preview_image is the /ViewSpecial form the real GetMyUserData
    // sends for a preset whose image is a stored data URI - the exact value that must never be echoed back.
    window.__presets = [
        { title: 'flux/Portrait', description: 'Close crop', is_starred: false,
            preview_image: '/ViewSpecial/Preset/flux/Portrait?editid=3',
            param_map: { model: 'flux/base', steps: '20', cfgscale: '1', 'video_frames': '81' } },
        { title: 'ill/Anime', description: '', is_starred: true,
            preview_image: 'imgs/model_placeholder.jpg',
            param_map: { model: 'ill/anime', steps: '30' } }
    ];
    window.genericRequest = (route, args, callback, depth, errorCallback) => {
        window.__calls.push({ route, args: JSON.parse(JSON.stringify(args || {})) });
        if (route == 'GetMyUserData') {
            callback({ presets: JSON.parse(JSON.stringify(window.__presets)), starred_models: {} });
        }
        else if (route == 'AddNewPreset') {
            if (window.__failNext) {
                window.__failNext = false;
                callback({ preset_fail: 'A preset with that title already exists.' });
                return;
            }
            let existing = window.__presets.find(p => p.title == (args.is_edit ? args.editing : args.title));
            let saved = {
                title: args.title,
                description: args.description || '',
                is_starred: !!args.is_starred,
                // Mirrors the server: blank preview_image on an edit keeps the existing image.
                preview_image: args.preview_image || (existing ? existing.preview_image : 'imgs/model_placeholder.jpg'),
                param_map: JSON.parse(JSON.stringify(args.param_map || {}))
            };
            if (existing && args.is_edit) {
                window.__presets[window.__presets.indexOf(existing)] = saved;
            }
            else {
                window.__presets.push(saved);
            }
            callback({ success: true });
        }
        else if (route == 'DeletePreset') {
            window.__presets = window.__presets.filter(p => p.title != args.preset);
            callback({ success: true });
        }
        else if (route == 'DuplicatePreset') {
            let existing = window.__presets.find(p => p.title == args.preset);
            window.__presets.push({ ...existing, title: `${existing.title} (2)` });
            callback({ success: true });
        }
        else if (route == 'ListT2IParams') {
            callback({ list: [] });
        }
        else if (route == 'ListModels') {
            callback({ files: [], folders: [] });
        }
        else if (errorCallback) {
            callback({});
        }
    };
});
page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mCreate != 'undefined' && typeof mPresets != 'undefined');
await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mCreate.build(panel);
    // Stands in for ListT2IParams, which the picker reads to offer parameters.
    mState.paramMeta = {
        model: { name: 'Model' }, steps: { name: 'Steps', default: '20' }, cfgscale: { name: 'CFG Scale' },
        prompt: { name: 'Prompt' }, sampler: { name: 'Sampler', default: 'euler' }, images: { name: 'Image Count' }
    };
});

// ---- Registration ----
const registered = await page.evaluate(() => mUI.moreItems.map(item => item.label));
check('Presets is registered as a More-tab row', registered.includes('Presets'), registered.join(','));

// ---- The manager lists what the server has, starred first ----
await page.evaluate(() => mPresets.openManager());
await page.waitForFunction(() => __sheet().querySelectorAll('.m-preset-row-item').length == 2);
const listed = await page.evaluate(() => ({
    names: [...__sheet().querySelectorAll('.m-preset-row-name')].map(e => e.textContent),
    subs: [...__sheet().querySelectorAll('.m-preset-row-sub')].map(e => e.textContent),
    reloaded: window.__calls.filter(c => c.route == 'GetMyUserData').length
}));
check('the manager lists presets with the starred one first', listed.names.join('|') == '★ ill/Anime|flux/Portrait', listed.names.join('|'));
check('a preset with no description falls back to its parameter count', listed.subs[0] == '2 parameters', listed.subs.join('|'));
check('opening the manager re-fetches rather than trusting the boot copy', listed.reloaded >= 1, `${listed.reloaded} fetches`);

// ---- Editing an existing preset ----
await page.evaluate(() => [...__sheet().querySelectorAll('.m-preset-row-item')]
    .find(row => row.textContent.includes('flux/Portrait')).click());
await page.waitForFunction(() => __sheet().querySelector('.m-sheet-title').textContent == 'Edit preset');
const loaded = await page.evaluate(() => ({
    title: __sheet().querySelector('.m-preset-field').value,
    labels: [...__sheet().querySelectorAll('.m-preset-param-label')].map(e => e.textContent),
    ids: [...__sheet().querySelectorAll('.m-preset-param-label')].map(e => e.title),
    values: [...__sheet().querySelectorAll('.m-preset-params .m-preset-field')].map(e => e.value)
}));
check('the editor loads the preset title', loaded.title == 'flux/Portrait', loaded.title);
check('every parameter is listed, including ones this client has no control for',
    loaded.ids.join(',') == 'cfgscale,model,steps,video_frames', loaded.ids.join(','));
check('a known parameter shows its display name, an unknown one its raw id',
    loaded.labels.join(',') == 'CFG Scale,Model,Steps,video_frames', loaded.labels.join(','));
check('values load from the param map', loaded.values.join(',') == '1,flux/base,20,81', loaded.values.join(','));

// Rename it, change a value, star it, and mark it active first so the rename has something to carry.
await page.evaluate(() => {
    mState.activePresets = ['flux/Portrait'];
    let fields = __sheet().querySelectorAll('.m-preset-sheet > .m-preset-field');
    fields[0].value = 'flux/Portrait Tight';
    fields[1].value = 'Tighter crop';
    __sheet().querySelector('.m-preset-star-toggle').click();
    let stepsInput = [...__sheet().querySelectorAll('.m-preset-param-label')]
        .find(label => label.title == 'steps').parentElement.querySelector('.m-preset-field');
    stepsInput.value = '24';
    stepsInput.dispatchEvent(new Event('input'));
});
await page.evaluate(() => __sheet().querySelector('.m-edit-save-button').click());
await page.waitForFunction(() => window.__calls.some(c => c.route == 'AddNewPreset'));
const savePayload = await page.evaluate(() => window.__calls.find(c => c.route == 'AddNewPreset').args);
check('an edit is sent as an edit, naming the ORIGINAL title',
    savePayload.is_edit === true && savePayload.editing == 'flux/Portrait', JSON.stringify({ is_edit: savePayload.is_edit, editing: savePayload.editing }));
check('the new title, description and star ride along',
    savePayload.title == 'flux/Portrait Tight' && savePayload.description == 'Tighter crop' && savePayload.is_starred === true,
    JSON.stringify({ t: savePayload.title, d: savePayload.description, s: savePayload.is_starred }));
check('preview_image is never sent, so the server keeps the existing image',
    !('preview_image' in savePayload), JSON.stringify(Object.keys(savePayload)));
check('the edited value is saved and every other parameter survives untouched',
    savePayload.param_map.steps == '24' && savePayload.param_map.video_frames == '81'
    && savePayload.param_map.model == 'flux/base' && savePayload.param_map.cfgscale == '1',
    JSON.stringify(savePayload.param_map));
const afterRename = await page.evaluate(() => ({
    active: mState.activePresets.slice(),
    image: window.__presets.find(p => p.title == 'flux/Portrait Tight').preview_image,
    count: window.__presets.length
}));
check('a rename carries the active selection with it',
    afterRename.active.join(',') == 'flux/Portrait Tight', afterRename.active.join(','));
check('the rename edits in place rather than forking a duplicate', afterRename.count == 2, `${afterRename.count} presets`);
check('the preset keeps its preview image through the rename',
    afterRename.image == '/ViewSpecial/Preset/flux/Portrait?editid=3', afterRename.image);

// ---- Capture reads base params, not the merged generation input ----
await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mState.params = { prompt: 'a cat', steps: '12', aspectratio: '16:9', images: '4', exactbackendid: '2',
        loras: ['ill/foo', 'ill/bar'], loraweights: ['0.8', '1'] };
    // An active preset whose values must NOT end up in the capture.
    mState.activePresets = ['ill/Anime'];
});
// Settled first: the Create panel's size stepper writes sidelength back into params on its next render, so
// a capture taken in the same frame as the assignment above sees a moving target.
const captured = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return mPresets.captureCurrent();
});
check('capture takes the prompt and steps the user actually set',
    captured.prompt == 'a cat' && captured.steps == '12', JSON.stringify(captured));
check('capture does not fold in an active preset\'s values',
    captured.model != 'ill/anime' && captured.steps != '30', JSON.stringify(captured));
// sidelength is deliberately NOT asserted absent: it is a parameter the user sets on the Create tab with the
// size stepper, so capturing it is correct. What must not appear is width/height, which only exist once
// buildGenInput has resolved the ratio into pixels.
check('capture leaves the aspect ratio as the label, not resolved pixels',
    captured.aspectratio == '16:9' && !('width' in captured) && !('height' in captured), JSON.stringify(captured));
check('batch count, backend pin and prompt images are never captured',
    !('images' in captured) && !('exactbackendid' in captured) && !('promptimages' in captured), JSON.stringify(captured));
check('list parameters are captured comma-joined, as the server stores them',
    captured.loras == 'ill/foo,ill/bar' && captured.loraweights == '0.8,1', JSON.stringify(captured));

// ---- New preset from current settings ----
await page.evaluate(() => {
    window.__calls = [];
    mPresets.openEditor(null, () => {});
});
await page.waitForFunction(() => __sheet().querySelector('.m-sheet-title').textContent == 'New preset');
const newSeeded = await page.evaluate(() => ({
    title: __sheet().querySelector('.m-preset-field').value,
    ids: [...__sheet().querySelectorAll('.m-preset-param-label')].map(e => e.title)
}));
check('a new preset opens blank but pre-seeded from the Create tab',
    newSeeded.title == '' && newSeeded.ids.includes('prompt') && newSeeded.ids.includes('steps'), JSON.stringify(newSeeded));
await page.evaluate(() => __sheet().querySelector('.m-edit-save-button').click());
const blankTitle = await page.evaluate(() => ({
    calls: window.__calls.filter(c => c.route == 'AddNewPreset').length,
    open: !!(__sheet() && __sheet().querySelector('.m-edit-save-button'))
}));
check('saving with no title is refused without a server round trip and keeps the sheet open',
    blankTitle.calls == 0 && blankTitle.open, JSON.stringify(blankTitle));
await page.evaluate(() => {
    __sheet().querySelector('.m-preset-field').value = 'My New One';
    __sheet().querySelector('.m-edit-save-button').click();
});
await page.waitForFunction(() => window.__calls.some(c => c.route == 'AddNewPreset'));
const newPayload = await page.evaluate(() => window.__calls.find(c => c.route == 'AddNewPreset').args);
check('a new preset is NOT sent as an edit',
    newPayload.is_edit === false && !('editing' in newPayload), JSON.stringify({ is_edit: newPayload.is_edit, editing: newPayload.editing }));

// ---- A server rejection is surfaced, and the sheet stays open to fix ----
await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    window.__calls = [];
    window.__failNext = true;
    // The toast is a persistent element that keeps its last text, so the previous block's "Saved ..." would
    // still be readable here and the check would pass on a stale success.
    for (let toast of document.querySelectorAll('.m-toast')) {
        toast.remove();
    }
    mUI.toastBox = null;
    mPresets.openEditor(null, () => {});
    __sheet().querySelector('.m-preset-field').value = 'ill/Anime';
    __sheet().querySelector('.m-edit-save-button').click();
});
const rejected = await page.evaluate(() => {
    let save = __sheet() ? __sheet().querySelector('.m-edit-save-button') : null;
    return {
        toast: document.querySelector('.m-toast') ? document.querySelector('.m-toast').textContent : '',
        open: !!save,
        enabled: !!save && !save.disabled
    };
});
check('a preset_fail is shown to the user rather than read as success',
    rejected.toast == 'A preset with that title already exists.', rejected.toast);
check('a rejected save leaves the sheet open with Save usable again',
    rejected.open && rejected.enabled, JSON.stringify(rejected));

// ---- Adding a parameter ----
await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mState.params = {};
    mPresets.openEditor(null, () => {});
    __sheet().querySelector('.m-preset-param-actions .m-preset-small-button:last-child').click();
});
await page.waitForFunction(() => document.querySelectorAll('.m-sheet-title').length > 1);
const picker = await page.evaluate(() => [...__sheet().querySelectorAll('.m-preset-row-sub')].map(e => e.textContent));
check('the parameter picker offers what the server advertises', picker.includes('sampler'), picker.join(','));
await page.evaluate(() => [...__sheet().querySelectorAll('.m-preset-row-item')]
    .find(row => row.textContent.includes('sampler')).click());
// The picker closes on a 250ms transition, so until it is gone __sheet() still answers from it - and the
// editor underneath, which is what this check is about, would read as empty.
await page.waitForFunction(() => document.querySelectorAll('.m-sheet').length == 1);
const added = await page.evaluate(() => ({
    ids: [...__sheet().querySelectorAll('.m-preset-param-label')].map(e => e.title),
    values: [...__sheet().querySelectorAll('.m-preset-params .m-preset-field')].map(e => e.value)
}));
check('picking a parameter adds it seeded with the server default',
    added.ids.join(',') == 'sampler' && added.values.join(',') == 'euler', JSON.stringify(added));
const filtered = await page.evaluate(() => {
    mPresets.openParamPicker({ sampler: 'euler' }, () => {});
    return [...__sheet().querySelectorAll('.m-preset-row-sub')].map(e => e.textContent);
});
check('a parameter the preset already sets is not offered again', !filtered.includes('sampler'), filtered.join(','));

// ---- Deleting ----
await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mState.activePresets = ['ill/Anime'];
    mUI.confirm = (message, onYes) => { window.__confirm = message; onYes(); };
    mPresets.openEditor(mState.presets.find(p => p.title == 'ill/Anime'), () => {});
    __sheet().querySelector('.m-edit-remove-button').click();
});
await page.waitForFunction(() => !window.__presets.some(p => p.title == 'ill/Anime'));
const deleted = await page.evaluate(() => ({
    confirmed: window.__confirm,
    active: mState.activePresets.slice(),
    remaining: mState.presets.map(p => p.title)
}));
check('deleting asks first, naming the preset',
    `${deleted.confirmed}`.includes('ill/Anime'), `${deleted.confirmed}`);
check('a deleted preset is dropped from the active selection too',
    deleted.active.length == 0, deleted.active.join(','));
check('the local preset list follows the delete', !deleted.remaining.includes('ill/Anime'), deleted.remaining.join(','));

// ---- Fields are 16px, or iOS zooms the page on focus ----
const fontSizes = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mPresets.openEditor(null, () => {});
    return [...__sheet().querySelectorAll('.m-preset-field, .m-preset-search')]
        .map(e => getComputedStyle(e).fontSize);
});
check('every editor field is at least 16px', fontSizes.length > 0 && fontSizes.every(size => parseFloat(size) >= 16), fontSizes.join(','));

await browser.close();
const failed = results.filter(result => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
