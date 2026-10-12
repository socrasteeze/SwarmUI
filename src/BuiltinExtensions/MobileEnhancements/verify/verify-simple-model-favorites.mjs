/** /simple model favorites: shared API payload, persistence, failures, and pointer/keyboard isolation. */
import { chromium, webkit } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
let assets = `${repo}/src/BuiltinExtensions/MobileEnhancements/Assets/m`;
let engine = process.env.SWARM_WEBKIT == '1' ? webkit : chromium;
let browser = await engine.launch();
let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
let failed = false;
/** Records a meaningful browser assertion. */
function check(name, pass, detail = '') {
    failed ||= !pass;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`);
}
page.on('pageerror', error => check(error.message, false));
try {
    await page.setContent('<main><section class="m-panel m-tab-active"></section></main>');
    await page.addStyleTag({ content: readFileSync(`${assets}/m.css`, 'utf8') });
    await page.evaluate(() => {
        window.__requests = [];
        window.__warnings = [];
        window.__saved = { 'Stable-Diffusion': ['Other.safetensors'], 'LoRA': ['Keep.safetensors'], 'VAE': ['KeepVAE.safetensors'] };
        window.mUI = {
            el: (tag, classes, text = '') => { let el = document.createElement(tag); el.className = classes; el.textContent = text; return el; },
            modelThumb: () => null, modelText: model => { let el = document.createElement('div'); el.textContent = model.name; return el; },
            modelLines: model => ({ primary: model.name }), modelName: name => name, note: () => {}, warn: message => window.__warnings.push(message)
        };
        window.mCreate = { modelList: null, loraList: null, insertTriggerPhrase: () => {} };
        window.permissions = { hasPermission: () => false };
        window.genericRequest = (route, args, success, depth, fail) => {
            if (route == 'ListModels') {
                success({ files: [{ name: 'Folder/Alpha.safetensors', local: false }, { name: 'Other.safetensors', local: false }], folders: [] });
                return;
            }
            window.__requests.push({ route, args, success, fail });
        };
        window.__read = () => {
            let request = window.__requests.shift();
            if (request.route != 'GetMyUserData') { throw Error(`Unexpected read: ${request.route}`); }
            request.success({ starred_models: structuredClone(window.__saved) });
        };
        window.__write = () => {
            let request = window.__requests.shift();
            if (request.route != 'SetStarredModels') { throw Error(`Unexpected write: ${request.route}`); }
            window.__saved = structuredClone(request.args);
            request.success({ success: true });
        };
    });
    await page.addScriptTag({ content: readFileSync(`${assets}/m_state.js`, 'utf8') });
    await page.addScriptTag({ content: readFileSync(`${assets}/m_models.js`, 'utf8') });
    await page.evaluate(() => {
        mState.changed = () => { for (let listener of mState.changeListeners) { listener(); } };
        mState.starredModels = structuredClone(window.__saved);
        mModels.build(document.querySelector('.m-panel'));
        mModels.refresh();
    });
    let target = page.locator('.m-model-favorite[data-model="Folder/Alpha.safetensors"]');
    let report = await target.evaluate(button => ({ pressed: button.getAttribute('aria-pressed'), label: button.getAttribute('aria-label'), width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height }));
    check('unstarred models have an accessible 44px favorite control', report.pressed == 'false' && report.label == 'Add Favorite' && report.width == 44 && report.height == 44, JSON.stringify(report));
    await target.click();
    report = await page.evaluate(() => ({ routes: window.__requests.map(request => request.route), disabled: [...document.querySelectorAll('.m-model-favorite')].every(button => button.disabled), selected: mState.params.model, loras: mState.getLoras().length, favorite: mState.isStarred('Stable-Diffusion', 'Folder/Alpha.safetensors') }));
    check('favorite tap fetches fresh data without selecting a model or claiming success early', report.routes.join(',') == 'GetMyUserData' && report.disabled && !report.selected && report.loras == 0 && !report.favorite, JSON.stringify(report));
    report = await page.evaluate(() => {
        window.__saved.VAE.push('AddedInClassic.safetensors');
        mModels.toggleFavorite('Stable-Diffusion', 'Other.safetensors');
        window.__read();
        return { route: window.__requests[0].route, payload: window.__requests[0].args, pending: window.__requests.length };
    });
    check('save uses the full Classic API dictionary and preserves changes from another client', report.route == 'SetStarredModels' && report.payload['Stable-Diffusion'].includes('Folder/Alpha.safetensors') && report.payload.LoRA.includes('Keep.safetensors') && report.payload.VAE.includes('AddedInClassic.safetensors') && report.pending == 1, JSON.stringify(report));
    await page.evaluate(() => window.__write());
    check('confirmed favorite shows a filled star and sorts before other models', await target.getAttribute('aria-pressed') == 'true' && await target.getAttribute('aria-label') == 'Remove Favorite' && await target.textContent() == '\u2605' && await page.locator('.m-model-favorite').first().getAttribute('data-model') == 'Folder/Alpha.safetensors');
    report = await page.evaluate(() => {
        window.__saved['Stable-Diffusion'].push('FOLDER\\ALPHA');
        return mState.params.model;
    });
    await target.focus();
    await page.keyboard.press('Space');
    await page.evaluate(() => { window.__read(); window.__write(); });
    report = await page.evaluate(() => ({ saved: window.__saved['Stable-Diffusion'], selected: mState.params.model, pressed: document.querySelector('[data-model="Folder/Alpha.safetensors"]').getAttribute('aria-pressed') }));
    check('keyboard unfavorite removes normalized aliases and leaves generation model unchanged', report.saved.join(',') == 'Other.safetensors' && !report.selected && report.pressed == 'false', JSON.stringify(report));
    await target.click();
    await page.evaluate(() => window.__requests.shift().fail('read failed'));
    check('failed read keeps the star unchanged and sends no write', await page.evaluate(() => !mState.isStarred('Stable-Diffusion', 'Folder/Alpha.safetensors') && window.__requests.length == 0 && !mModels.favoriteBusy && !document.querySelector('.m-model-favorite').disabled && window.__warnings.includes('Could not save favorite: read failed')));
    await target.click();
    await page.evaluate(() => { window.__read(); window.__requests.shift().fail('write failed'); });
    check('failed save keeps confirmed favorites and allows retry', await page.evaluate(() => !mState.isStarred('Stable-Diffusion', 'Folder/Alpha.safetensors') && !mModels.favoriteBusy && window.__warnings.includes('Could not save favorite: write failed')));
    await page.evaluate(() => { mModels.subtype = 'LoRA'; mModels.refresh(); });
    await target.focus();
    await page.keyboard.press('Enter');
    await page.evaluate(() => { window.__read(); window.__write(); });
    report = await page.evaluate(() => ({ saved: window.__saved, loras: mState.getLoras().length, selected: mState.params.model }));
    check('LoRA keyboard favorite saves the LoRA subtype without adding it to generation', report.saved.LoRA.includes('Folder/Alpha.safetensors') && report.saved['Stable-Diffusion'].includes('Other.safetensors') && report.loras == 0 && !report.selected, JSON.stringify(report));
    report = await page.evaluate(() => {
        window.__saved.LoRA = ['Keep.safetensors'];
        mState.userDataRefreshedAt = 0;
        mModels.onShow();
        window.__read();
        return document.querySelector('[data-model="Folder/Alpha.safetensors"]').getAttribute('aria-pressed');
    });
    check('returning to Models reads favorites changed in Classic', report == 'false');
    for (let width of [360, 390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        report = await target.evaluate(button => {
            let box = button.getBoundingClientRect();
            let card = button.closest('.m-model-card').getBoundingClientRect();
            return { fits: box.left >= card.left && box.right <= card.right && box.top >= card.top && box.bottom <= card.bottom, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        check(`favorite stays within the card at ${width}px`, report.fits && report.overflow <= 1, JSON.stringify(report));
    }
}
finally {
    await browser.close();
}
process.exit(failed ? 1 : 0);
