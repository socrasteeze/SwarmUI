/**
 * /simple Models-tab Load CivitAI preview harness (fork). The button saves a preview through
 * SaveModelPreviewImage and must not call EditModelMetadata:
 *
 * 1. Local cards with edit_model_metadata show Load CivitAI preview when they still need an image.
 *    Remote cards, no-permission, a real preview, and a description that already links to CivitAI do not.
 * 2. The button stops propagation so it does not also select/add the model.
 * 3. No hash and no description URL -> GetModelHash, then ForwardMetadataRequest by-hash.
 * 4. No CivitAI match surfaces a warn toast and does not call SaveModelPreviewImage or EditModelMetadata.
 * 5. A successful fetch sends the first still-image URL (skipping a leading video) and nothing else.
 * 6. Description URL short-circuits the hash path (same guess Classic uses).
 * 7. The Create-tab cache row updates preview_image only.
 *
 * Runs the REAL shipped source with a scripted fake server. Requires playwright + chromium. Run from repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-models-civitai.mjs
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

const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_coach.js', 'm_enhance.js',
    'm_create.js', 'm_grid.js', 'm_presets.js', 'm_images.js', 'm_models.js'];
const FILES = {
    '/js/util.js': `${REPO}/src/wwwroot/js/util.js`,
    '/js/site.js': `${REPO}/src/wwwroot/js/site.js`,
    '/js/translator.js': `${REPO}/src/wwwroot/js/translator.js`,
    '/js/permissions.js': `${REPO}/src/wwwroot/js/permissions.js`,
    '/css/site.css': `${REPO}/src/wwwroot/css/site.css`,
    '/css/themes/modern.css': `${REPO}/src/wwwroot/css/themes/modern.css`,
    '/css/themes/modern_dark.css': `${REPO}/src/wwwroot/css/themes/modern_dark.css`,
    '/css/bootstrap.min.css': `${REPO}/src/wwwroot/css/bootstrap.min.css`,
    '/js/lib/jquery.min.js': `${REPO}/src/wwwroot/js/lib/jquery.min.js`,
    '/js/lib/bootstrap.min.js': `${REPO}/src/wwwroot/js/lib/bootstrap.min.js`,
    '/ExtensionFile/MobileEnhancementsExtension/Assets/mobile_core.js':
        `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/mobile_core.js`,
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
        const body = readFileSync(file);
        const type = file.endsWith('.css') ? 'text/css'
            : file.endsWith('.js') ? 'application/javascript'
            : 'application/octet-stream';
        return route.fulfill({ contentType: type, body });
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
    window.__sheet = () => [...document.querySelectorAll('.m-sheet')].pop();
    window.__calls = [];
    window.__models = [
        { name: 'local/Alpha.safetensors', title: '', author: '', description: '', local: true,
            architecture: 'flux-1/lora', standard_width: 1024, standard_height: 1024,
            hash: '', trigger_phrase: '', tags: [], preview_image: 'imgs/model_placeholder.jpg',
            lora_default_weight: '0.8', lora_default_confinement: '' },
        { name: 'remote/Beta.safetensors', title: 'Remote', local: false, architecture: 'flux-1/lora' },
        { name: 'local/Known.safetensors', title: 'Old', author: 'me', local: true,
            architecture: 'flux-1/lora', standard_width: 768, standard_height: 768,
            description: 'From <a href="https://civitai.com/models/99?modelVersionId=77">link</a>',
            hash: '0xDEADBEEFCAFE', trigger_phrase: '', tags: ['old'],
            preview_image: 'imgs/model_placeholder.jpg', lora_default_weight: '', lora_default_confinement: '' },
        { name: 'local/Pictured.safetensors', title: 'Pictured', author: '', local: true,
            architecture: 'flux-1/lora', description: 'Local preview only',
            hash: '', trigger_phrase: 'bow', tags: [],
            preview_image: '/ViewSpecial/LoRA/local/Pictured.safetensors' }
    ];
    window.__hashMode = 'ok'; // ok | empty | fail
    window.__byHashMode = 'hit'; // hit | miss | error
    window.__modelMetaMode = 'ok'; // ok | empty
    window.__saveMode = 'ok'; // ok | fail
    window.__previewData = 'data:image/jpeg;base64,qq==';
    // imageToData is in util.js; stub after load so civitai CDN forwarding is not needed.
    window.__stubImageToData = true;
});

page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mModels != 'undefined' && typeof mUI != 'undefined' && typeof imageToData == 'function');

await page.evaluate(() => {
    if (window.__stubImageToData) {
        window.imageToData = (src, callback) => callback(window.__previewData);
    }
    mUI.warnings = [];
    mUI.notes = [];
    const _warn = mUI.warn.bind(mUI);
    const _note = mUI.note.bind(mUI);
    mUI.warn = (m) => { mUI.warnings.push(m); _warn(m); };
    mUI.note = (m) => { mUI.notes.push(m); _note(m); };
    window.genericRequest = (route, args, callback, depth, errorCallback) => {
        window.__calls.push({ route, args: JSON.parse(JSON.stringify(args || {})) });
        if (route == 'ListModels') {
            let files = window.__models.filter(m => m.local !== false || args.allowRemote);
            // Depth-1 folder listing: return all fixtures for this harness.
            callback({ files: JSON.parse(JSON.stringify(files)), folders: [] });
            return;
        }
        if (route == 'GetModelHash') {
            if (window.__hashMode == 'fail') {
                if (errorCallback) { errorCallback('hash failed'); }
                return;
            }
            if (window.__hashMode == 'empty') {
                callback({ hash: '' });
                return;
            }
            callback({ hash: '0xABCDEF1234567890' });
            return;
        }
        if (route == 'ForwardMetadataRequest') {
            let url = args.url || '';
            if (url.includes('/model-versions/by-hash/')) {
                if (window.__byHashMode == 'miss') {
                    callback({ response: { error: 'Not Found' } });
                    return;
                }
                if (window.__byHashMode == 'error') {
                    if (errorCallback) { errorCallback('network'); }
                    return;
                }
                callback({ response: { modelId: 42, id: 7 } });
                return;
            }
            if (url.includes('/api/v1/models/')) {
                if (window.__modelMetaMode == 'empty') {
                    callback({ response: null });
                    return;
                }
                callback({
                    response: {
                        name: 'Face Card',
                        description: 'Model desc',
                        creator: { username: 'artist' },
                        tags: ['character', 'style'],
                        modelVersions: [{
                            id: 7,
                            name: 'v1',
                            createdAt: '2026-01-02',
                            trainedWords: ['ohwx', 'person'],
                            baseModel: 'Illustrious',
                            description: 'Vers desc',
                            images: [
                                { type: 'video', url: 'https://image.civitai.com/x/clip.mp4' },
                                { type: 'image', url: 'https://image.civitai.com/x/preview.jpg' }
                            ]
                        }, {
                            id: 77,
                            name: 'vKnown',
                            createdAt: '2026-02-03',
                            trainedWords: ['known'],
                            baseModel: 'Pony',
                            description: '',
                            images: [{ type: 'image', url: 'https://image.civitai.com/x/known.jpg' }]
                        }]
                    }
                });
                return;
            }
            callback({ response: {} });
            return;
        }
        if (route == 'SaveModelPreviewImage') {
            if (window.__saveMode == 'fail') {
                if (errorCallback) { errorCallback('save failed'); }
                return;
            }
            callback({ success: true, preview_image: '/ViewSpecial/LoRA/' + args.model + '?editid=9' });
            return;
        }
        if (route == 'EditModelMetadata') {
            callback({ success: true });
            return;
        }
        if (route == 'GetMyUserData') {
            callback({ presets: [], starred_models: {} });
            return;
        }
        if (errorCallback) {
            errorCallback('unhandled ' + route);
        }
        else {
            callback({});
        }
    };
    mState.starredModels = {};
    mState.params = {};
    mCreate.loraList = null;
    mCreate.modelList = null;
    let panel = document.querySelector('.m-panel[data-mtab="models"]');
    panel.innerHTML = '';
    panel.classList.add('m-tab-active');
    mModels.subtype = 'LoRA';
    mModels.folder = '';
    mModels.build(panel);
    mModels.refresh();
});

await page.waitForFunction(() => document.querySelectorAll('.m-model-card').length >= 2);

const buttons = await page.evaluate(() => {
    let cards = [...document.querySelectorAll('.m-model-card')];
    return cards.map(card => ({
        text: card.querySelector('.m-model-name')?.textContent || '',
        hasBtn: !!card.querySelector('.m-model-civitai-btn')
    }));
});
check('local model card shows Load CivitAI preview', buttons.some(b => b.hasBtn && b.text.includes('Alpha')), JSON.stringify(buttons));
check('remote model card hides Load CivitAI', buttons.some(b => !b.hasBtn && (b.text.includes('Beta') || b.text.includes('Remote'))), JSON.stringify(buttons));
check('real preview hides Load CivitAI', buttons.some(b => !b.hasBtn && b.text.includes('Pictured')), JSON.stringify(buttons));
check('CivitAI description link hides Load CivitAI', buttons.some(b => !b.hasBtn && b.text.includes('Old')), JSON.stringify(buttons));

// Permission gate: rebuild without permission.
await page.evaluate(() => {
    window.permissions = { hasPermission: (p) => p != 'edit_model_metadata' };
    mModels.refresh();
});
await page.waitForFunction(() => document.querySelectorAll('.m-model-card').length >= 2);
check('no edit_model_metadata permission: no Load CivitAI buttons',
    await page.evaluate(() => document.querySelectorAll('.m-model-civitai-btn').length == 0));

// Restore permission and select/add must not fire when clicking Load CivitAI.
await page.evaluate(() => {
    window.permissions = { hasPermission: () => true };
    mUI.notes = [];
    mUI.warnings = [];
    window.__calls = [];
    mState.params = {};
    mState.setLoras([]);
    mModels.refresh();
});
await page.waitForFunction(() => document.querySelector('.m-model-civitai-btn'));

// ---- Miss path: hash lookup finds nothing ----
await page.evaluate(() => {
    window.__byHashMode = 'miss';
    window.__hashMode = 'ok';
    window.__calls = [];
    mUI.warnings = [];
    mModels.civitaiBusy = false;
    let btn = [...document.querySelectorAll('.m-model-civitai-btn')]
        .find(b => b.closest('.m-model-card').textContent.includes('Alpha'));
    btn.click();
});
await page.waitForFunction(() => (mUI.warnings || []).some(w => /No CivitAI match/i.test(w)));
const miss = await page.evaluate(() => ({
    warnings: mUI.warnings.slice(),
    routes: window.__calls.map(c => c.route),
    notes: (mUI.notes || []).slice(),
    loras: mState.getLoras(),
    sheetOpen: !!document.querySelector('.m-sheet')
}));
check('no match: GetModelHash then ForwardMetadataRequest, never saves',
    miss.routes.includes('GetModelHash') && miss.routes.includes('ForwardMetadataRequest')
    && !miss.routes.includes('SaveModelPreviewImage') && !miss.routes.includes('EditModelMetadata'),
    miss.routes.join(','));
check('no match: warns the user', miss.warnings.some(w => /No CivitAI match/i.test(w)), miss.warnings.join('|'));
check('Load CivitAI click does not add the LoRA', miss.loras.length == 0, JSON.stringify(miss.loras));

// Close any open sheet from the miss path.
await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mUI.openSheets = 0;
    mModels.civitaiBusy = false;
});

// ---- Happy path via description URL (skips hash) ----
await page.evaluate(() => {
    window.__byHashMode = 'hit';
    window.__modelMetaMode = 'ok';
    window.__saveMode = 'ok';
    window.__calls = [];
    mUI.notes = [];
    mUI.warnings = [];
    mCreate.loraList = [{ name: 'local/Known.safetensors', title: 'Old', tags: ['old'], preview_image: 'imgs/model_placeholder.jpg' }];
    mModels.refresh();
});
await page.waitForFunction(() => {
    let cards = [...document.querySelectorAll('.m-model-card')];
    let known = cards.find(card => card.textContent.includes('Old'));
    let pictured = cards.find(card => card.textContent.includes('Pictured'));
    return known && pictured && !known.querySelector('.m-model-civitai-btn') && !pictured.querySelector('.m-model-civitai-btn')
        && document.querySelector('.m-model-civitai-btn');
});
await page.evaluate(() => {
    let known = window.__models.find(model => model.name.includes('Known'));
    mModels.openCivitaiLoad(known);
});
await page.waitForFunction(() => window.__calls.some(c => c.route == 'SaveModelPreviewImage'));
const saved = await page.evaluate(() => {
    let edit = window.__calls.find(c => c.route == 'SaveModelPreviewImage');
    let row = mCreate.loraList.find(m => m.name == 'local/Known.safetensors');
    return {
        routes: window.__calls.map(c => c.route),
        args: edit ? edit.args : null,
        notes: (mUI.notes || []).slice(),
        hashCalls: window.__calls.filter(c => c.route == 'GetModelHash').length,
        forwardUrls: window.__calls.filter(c => c.route == 'ForwardMetadataRequest').map(c => c.args.url),
        row
    };
});
check('description URL skips GetModelHash', saved.hashCalls == 0, `${saved.hashCalls}`);
check('description URL fetches the model metadata API',
    saved.forwardUrls.some(u => u.includes('/api/v1/models/99')), saved.forwardUrls.join('|'));
check('SaveModelPreviewImage sends only the still-image URL',
    saved.args && saved.args.model == 'local/Known.safetensors' && saved.args.subtype == 'LoRA'
    && saved.args.url == 'https://image.civitai.com/x/known.jpg' && !saved.args.image
    && !saved.args.title && !saved.args.tags && !saved.args.description && !saved.args.type,
    JSON.stringify(saved.args));
check('picker cache updates the preview and keeps the title and tags',
    saved.row && saved.row.preview_image == '/ViewSpecial/LoRA/local/Known.safetensors?editid=9'
    && saved.row.title == 'Old' && saved.row.tags.join(',') == 'old',
    JSON.stringify(saved.row));
check('description URL never calls EditModelMetadata', !saved.routes.includes('EditModelMetadata'), saved.routes.join(','));
check('success notes the user', saved.notes.some(n => /CivitAI preview saved/i.test(n)), saved.notes.join('|'));

// ---- Hash happy path for Alpha ----
await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mUI.openSheets = 0;
    mModels.civitaiBusy = false;
    window.__calls = [];
    window.__byHashMode = 'hit';
    window.__modelMetaMode = 'ok';
    mUI.notes = [];
    mModels.refresh();
});
await page.waitForFunction(() => document.querySelectorAll('.m-model-civitai-btn').length >= 1);
await page.evaluate(() => {
    let btn = [...document.querySelectorAll('.m-model-civitai-btn')]
        .find(b => b.closest('.m-model-card').textContent.includes('Alpha'));
    btn.click();
});
await page.waitForFunction(() => window.__calls.some(c => c.route == 'SaveModelPreviewImage'));
const hashPath = await page.evaluate(() => {
    let edit = window.__calls.find(c => c.route == 'SaveModelPreviewImage');
    let byHash = window.__calls.find(c => c.route == 'ForwardMetadataRequest'
        && (c.args.url || '').includes('by-hash'));
    return {
        routes: window.__calls.map(c => c.route),
        byHashUrl: byHash ? byHash.args.url : null,
        url: edit && edit.args.url,
        image: edit && edit.args.image
    };
});
check('hash path: GetModelHash then by-hash then models then SaveModelPreviewImage',
    hashPath.routes.indexOf('GetModelHash') < hashPath.routes.indexOf('SaveModelPreviewImage')
    && hashPath.routes.indexOf('ForwardMetadataRequest') < hashPath.routes.indexOf('SaveModelPreviewImage')
    && !hashPath.routes.includes('EditModelMetadata')
    && hashPath.byHashUrl && hashPath.byHashUrl.includes('by-hash/ABCDEF123456'),
    JSON.stringify({ routes: hashPath.routes, byHashUrl: hashPath.byHashUrl }));
check('hash path saves the first still image and skips the leading video',
    hashPath.url == 'https://image.civitai.com/x/preview.jpg' && !hashPath.image,
    JSON.stringify(hashPath));

// Trigger phrases clamp to whole lines. more/less reveals the rest and does not add the LoRA.
const triggers = await page.evaluate(async () => {
    let phrases = [];
    for (let i = 0; i < 30; i++) {
        phrases.push(`tag${i}`);
    }
    phrases.push('zzztailtoken');
    let full = phrases.join(', ');
    let inserted = [];
    mCreate.insertTriggerPhrase = (phrase) => { inserted.push(phrase); };
    mState.setLoras([]);
    mModels.grid.innerHTML = '';
    let longCard = mModels.buildCard({
        name: 'local/Clip.safetensors',
        title: 'A Very Long Title That Should Clamp On Whole Lines Without Cutting Glyphs In Half',
        trigger_phrase: full,
        local: true,
        preview_image: '/ViewSpecial/LoRA/local/Clip.safetensors',
        description: ''
    });
    let shortCard = mModels.buildCard({
        name: 'local/Short.safetensors',
        title: 'Short',
        trigger_phrase: 'bow',
        local: true,
        preview_image: '',
        description: ''
    });
    mModels.grid.appendChild(longCard);
    mModels.grid.appendChild(shortCard);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    /** Whole rendered lines: client height matches N times the used line height. */
    let wholeLines = (el) => {
        let lh = parseFloat(getComputedStyle(el).lineHeight);
        if (!lh) {
            return { ok: false, lines: 0, delta: -1, h: el.clientHeight, scroll: el.scrollHeight };
        }
        let lines = Math.round(el.clientHeight / lh);
        let delta = Math.abs(el.clientHeight - lines * lh);
        return { ok: delta <= 2 && lines >= 1, lines, delta, h: el.clientHeight, scroll: el.scrollHeight, lh };
    };
    let text = longCard.querySelector('.m-trigger-chip-text');
    let name = longCard.querySelector('.m-model-name');
    let sub = longCard.querySelector('.m-model-sub');
    let block = longCard.querySelector('.m-model-text');
    let more = longCard.querySelector('.m-trigger-more');
    let shortMore = shortCard.querySelector('.m-trigger-more');
    let before = { loras: mState.getLoras().length, inserted: inserted.length };
    more.click();
    let opened = {
        expanded: more.getAttribute('aria-expanded'),
        label: more.getAttribute('aria-label'),
        text: text.textContent,
        loras: mState.getLoras().length,
        inserted: inserted.length
    };
    more.click();
    let closed = {
        expanded: more.getAttribute('aria-expanded'),
        text: text.textContent
    };
    longCard.querySelector('.m-trigger-chip').click();
    let chip = { inserted: inserted.slice(), loras: mState.getLoras().length };
    return {
        before,
        opened,
        closed,
        chip,
        triggerLines: wholeLines(text),
        nameLines: wholeLines(name),
        subLines: wholeLines(sub),
        blockOverflow: getComputedStyle(block).overflow,
        blockClips: block.scrollHeight > block.clientHeight + 1,
        moreVisible: !more.hidden && getComputedStyle(more).display != 'none',
        shortMoreHidden: shortMore.hidden || getComputedStyle(shortMore).display == 'none',
        longButton: !!longCard.querySelector('.m-model-civitai-btn'),
        shortButton: !!shortCard.querySelector('.m-model-civitai-btn'),
        nameClamp: getComputedStyle(name).webkitLineClamp,
        subClamp: getComputedStyle(sub).webkitLineClamp
    };
});
check('trigger clamp is two whole lines', triggers.triggerLines.ok && triggers.triggerLines.lines == 2
    && triggers.triggerLines.scroll > triggers.triggerLines.h + 1, JSON.stringify(triggers.triggerLines));
check('title clamps to two whole lines', triggers.nameLines.ok && triggers.nameLines.lines == 2
    && triggers.nameClamp == '2', JSON.stringify(triggers.nameLines));
check('subtitle clamps to one whole line', triggers.subLines.ok && triggers.subLines.lines == 1
    && triggers.subClamp == '1', JSON.stringify(triggers.subLines));
check('card text block does not cut its children', triggers.blockOverflow != 'hidden' && !triggers.blockClips,
    JSON.stringify({ overflow: triggers.blockOverflow, clips: triggers.blockClips }));
check('more reveals the full trigger and does not add the LoRA', triggers.moreVisible && triggers.before.inserted == 0
    && triggers.opened.expanded == 'true' && triggers.opened.text.includes('zzztailtoken')
    && triggers.opened.inserted == 0 && triggers.opened.loras == 0 && triggers.opened.label == 'Hide full trigger',
    JSON.stringify(triggers.opened));
check('less collapses back to the preview', triggers.closed.expanded == 'false' && !triggers.closed.text.includes('zzztailtoken'),
    JSON.stringify(triggers.closed));
check('trigger chip still inserts the full phrase', triggers.chip.inserted.length == 1
    && triggers.chip.inserted[0].includes('zzztailtoken') && triggers.chip.loras == 0, JSON.stringify(triggers.chip));
check('a short trigger hides more', triggers.shortMoreHidden, JSON.stringify(triggers.shortMoreHidden));
check('preview card hides Load CivitAI and an empty card keeps it', !triggers.longButton && triggers.shortButton,
    JSON.stringify({ longButton: triggers.longButton, shortButton: triggers.shortButton }));

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
