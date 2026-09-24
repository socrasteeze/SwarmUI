/**
 * /simple Prompt Enhance harness (fork). Guards the Create-panel chrome that replaced Coach:
 *
 * 1. The prompt-header pill is Enhance (not Coach); Coach registers under More > Prompt Coach.
 * 2. applyStatusToButton disables the pill with a reason when no profile resolves; enables it when one does
 *    (unhealthy endpoints still enable, matching desktop fail-open).
 * 3. handleFrame streams chunks into the preview, enables Apply on a non-empty result, never enables Apply
 *    on conflict/passthrough/empty result, and applyResult writes the prompt + provenance into mState.
 * 4. Tapping the pill opens a bottom sheet (review flow) even while the pill reads as disabled, so the
 *    profile override inside the sheet stays reachable.
 *
 * Runs the REAL shipped /simple sources with Playwright, same pattern as verify-simple-coach.mjs.
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-enhance.mjs
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

const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_coach.js', 'm_enhance.js', 'm_create.js',
    'm_grid.js', 'm_presets.js', 'm_images.js', 'm_models.js'];
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
    window.__enhanceStatus = {
        pack_version: 'test',
        profiles: [{ id: 'anima', display: 'Anima', target_model: 'Anima' }],
        endpoints: [{ id: 'writer', kind: 'ollama', model: 'test', enabled: true, healthy: true }],
        resolved: { profile: null, reason: 'No profile for this model', strengths: ['faithful', 'expand', 'full'] }
    };
    window.genericRequest = (route, args, callback) => {
        if (route == 'ListPromptEnhanceStatus') {
            callback(JSON.parse(JSON.stringify(window.__enhanceStatus)));
        }
        else if (route == 'GetMyUserData') {
            callback({ presets: [], starred_models: {} });
        }
        else if (route == 'ListT2IParams') {
            callback({ list: [] });
        }
        else if (route == 'ListModels') {
            callback({ files: [], folders: [] });
        }
        else {
            callback({});
        }
    };
});
page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mCreate != 'undefined' && typeof mEnhance != 'undefined' && typeof mCoach != 'undefined');
await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mCreate.build(panel);
});

const chrome = await page.evaluate(() => {
    let enhance = document.querySelector('.m-enhance-pill');
    let coach = document.querySelector('.m-coach-pill');
    let more = (mUI.moreItems || []).some(item => item.label == 'Prompt Coach');
    return {
        enhanceOnHead: !!(enhance && enhance.parentElement.classList.contains('m-prompt-head')),
        coachGone: !coach,
        moreCoach: more,
        sheets: document.querySelectorAll('.m-sheet').length
    };
});
check('Enhance pill sits on the prompt heading row', chrome.enhanceOnHead && chrome.sheets == 0, JSON.stringify(chrome));
check('Coach pill is gone from the prompt heading', chrome.coachGone, JSON.stringify(chrome));
check('Prompt Coach is registered under More', chrome.moreCoach, JSON.stringify(chrome));

// Status: no profile -> disabled label/title; with profile -> enabled (even if unhealthy).
const disabled = await page.evaluate(() => {
    mEnhance.applyStatusToButton({
        resolved: { profile: null, reason: 'No writer profile available for the current model.' },
        endpoints: []
    });
    return { enabled: mEnhance.buttonEnabled, text: mEnhance.pillEl.textContent, title: mEnhance.pillEl.title,
        disabledClass: mEnhance.pillEl.classList.contains('m-enhance-pill-disabled') };
});
check('no resolved profile disables the Enhance pill with a reason',
    !disabled.enabled && disabled.disabledClass && disabled.title.includes('No writer profile'), JSON.stringify(disabled));

const enabledUnhealthy = await page.evaluate(() => {
    mEnhance.applyStatusToButton({
        resolved: { profile: 'anima', reason: null },
        endpoints: [{ id: 'writer', healthy: false }]
    });
    return { enabled: mEnhance.buttonEnabled, text: mEnhance.pillEl.textContent, title: mEnhance.pillEl.title,
        disabledClass: mEnhance.pillEl.classList.contains('m-enhance-pill-disabled') };
});
check('resolved profile with unhealthy endpoint still enables Enhance (fail-open)',
    enabledUnhealthy.enabled && !enabledUnhealthy.disabledClass && enabledUnhealthy.title.includes('pass through'),
    JSON.stringify(enabledUnhealthy));

const enabledHealthy = await page.evaluate(() => {
    mEnhance.applyStatusToButton({
        resolved: { profile: 'anima', reason: null },
        endpoints: [{ id: 'writer', healthy: true }]
    });
    return { enabled: mEnhance.buttonEnabled, title: mEnhance.pillEl.title };
});
check('resolved profile with healthy endpoint enables Enhance',
    enabledHealthy.enabled && enabledHealthy.title.includes('Rewrite'), JSON.stringify(enabledHealthy));

// Frame handling / apply against a synthetic open sheet (no real websocket).
const frames = await page.evaluate(() => {
    // Build a sheet DOM the same shape open() would, without starting a WS.
    let content = mUI.el('div', 'm-enhance-sheet');
    let status = mUI.el('div', 'm-enhance-status', '');
    let preview = document.createElement('textarea');
    preview.className = 'm-enhance-preview';
    let notes = mUI.el('div', 'm-enhance-notes');
    notes.style.display = 'none';
    let conflict = mUI.el('div', 'm-enhance-conflict');
    conflict.style.display = 'none';
    let passthrough = mUI.el('div', 'm-enhance-passthrough');
    passthrough.style.display = 'none';
    let applyBtn = mUI.el('button', 'm-enhance-apply m-enhance-apply-disabled', 'Apply');
    document.body.appendChild(content);
    content.appendChild(status);
    content.appendChild(preview);
    content.appendChild(notes);
    content.appendChild(conflict);
    content.appendChild(passthrough);
    content.appendChild(applyBtn);
    mEnhance.sheet = { content, status, preview, notes, conflict, passthrough, applyBtn };
    mEnhance.running = true;
    mEnhance.applyEnabled = false;
    mEnhance.lastResult = null;

    mEnhance.handleFrame({ status: 'running', profile: 'anima', writer_model: 'w', endpoint: 'writer' });
    mEnhance.handleFrame({ chunk: 'hello ' });
    mEnhance.handleFrame({ chunk: 'world' });
    let mid = { preview: preview.value, apply: mEnhance.applyEnabled, status: status.textContent };

    mEnhance.handleFrame({
        result: 'enhanced prompt text',
        notes: 'note line',
        original: 'raw idea',
        profile: 'anima',
        pack_version: '1',
        writer_model: 'w',
        endpoint: 'writer',
        cached: false,
        strength: 'full'
    });
    let afterResult = {
        preview: preview.value,
        apply: mEnhance.applyEnabled,
        notes: notes.textContent,
        notesShown: notes.style.display != 'none'
    };

    mState.params['prompt'] = 'raw idea';
    mCreate.promptBox.value = 'raw idea';
    mEnhance.applyResult(mEnhance.lastResult);
    let applied = {
        prompt: mState.params['prompt'],
        box: mCreate.promptBox.value,
        provenance: JSON.parse(mState.params['promptenhanceprovenance'] || 'null')
    };

    // Empty result -> passthrough, no Apply.
    mEnhance.sheet = { content, status, preview, notes, conflict, passthrough, applyBtn };
    mEnhance.applyEnabled = true;
    mEnhance.handleFrame({ result: '   ' });
    let empty = { apply: mEnhance.applyEnabled, passthrough: passthrough.style.display != 'none' };

    // Conflict -> no Apply.
    conflict.style.display = 'none';
    mEnhance.applyEnabled = true;
    mEnhance.handleFrame({ conflict: 'too vague' });
    let conflicted = { apply: mEnhance.applyEnabled, shown: conflict.style.display != 'none', text: conflict.textContent };

    content.remove();
    mEnhance.sheet = null;
    return { mid, afterResult, applied, empty, conflicted };
});
check('chunks accumulate in the preview before a result',
    frames.mid.preview == 'hello world' && !frames.mid.apply, JSON.stringify(frames.mid));
check('a result frame enables Apply and shows notes',
    frames.afterResult.apply && frames.afterResult.preview == 'enhanced prompt text' && frames.afterResult.notesShown,
    JSON.stringify(frames.afterResult));
check('Apply writes prompt + provenance',
    frames.applied.prompt == 'enhanced prompt text' && frames.applied.box == 'enhanced prompt text'
    && frames.applied.provenance && frames.applied.provenance.original == 'raw idea',
    JSON.stringify(frames.applied));
check('empty result does not enable Apply', !frames.empty.apply && frames.empty.passthrough, JSON.stringify(frames.empty));
check('conflict never enables Apply', !frames.conflicted.apply && frames.conflicted.shown, JSON.stringify(frames.conflicted));

// Pill opens a sheet even while disabled (profile override lives inside).
const opened = await page.evaluate(() => {
    mEnhance.applyStatusToButton({
        resolved: { profile: null, reason: 'No writer profile available for the current model.' },
        endpoints: []
    });
    mEnhance.running = false;
    mEnhance.sheet = null;
    // makeWSRequest already stubbed to null; open() still builds the sheet.
    mEnhance.open();
    let sheet = document.querySelector('.m-enhance-sheet');
    let profileSelect = sheet && sheet.querySelector('.m-enhance-select');
    return {
        sheets: document.querySelectorAll('.m-sheet').length,
        hasSheet: !!sheet,
        hasProfileSelect: !!profileSelect,
        running: mEnhance.running
    };
});
check('tapping Enhance opens the review sheet even when disabled',
    opened.hasSheet && opened.sheets >= 1 && opened.hasProfileSelect, JSON.stringify(opened));

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
