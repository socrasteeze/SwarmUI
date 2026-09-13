/** Chromium checks for Genpage startup preset laziness and batched control sizing. */
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { chromium } from 'playwright';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const site = readFileSync(`${REPO}/src/wwwroot/js/site.js`, 'utf8');
const params = readFileSync(`${REPO}/src/wwwroot/js/genpage/gentab/params.js`, 'utf8');
const presets = readFileSync(`${REPO}/src/wwwroot/js/genpage/gentab/presets.js`, 'utf8');
const settings = readFileSync(`${REPO}/src/wwwroot/js/genpage/helpers/settings_editor.js`, 'utf8');

function extract(source, signature) {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `missing ${signature}`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] == '{') { depth++; }
        else if (source[i] == '}') {
            depth--;
            if (depth == 0) { return source.slice(start, i + 1); }
        }
    }
    throw new Error(`unbalanced ${signature}`);
}

const autoWidthClass = extract(site, 'class AutoWidthBatchHelper');
const settingsLoad = extract(settings, 'function loadSettingsEditor');
const presetBuild = extract(presets, 'function ensurePresetInputsBuilt');
const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<!doctype html><style>.serif{font:17px Georgia,serif}.sans{font:13px Arial,sans-serif}</style><select id="s" class="serif"><option>Long model label with many separate words for a large checkpoint file title</option></select><select id="s2" class="serif"><option>Another quite long label with spaces and more words for a second checkpoint</option></select><input id="n" class="sans" value="987654321"><input id="skip" class="nogrow" value="ignored">`);
    await page.addScriptTag({ content: `${autoWidthClass}; window.AutoWidthBatchHelper = AutoWidthBatchHelper;` });
    const result = await page.evaluate(() => {
        let phase = [], appendCount = 0, readCount = 0;
        let append = document.documentElement.appendChild.bind(document.documentElement);
        document.documentElement.appendChild = node => { phase.push('append'); appendCount++; return append(node); };
        let descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { phase.push('read'); readCount++; return descriptor.get.call(this); } });
        let select = document.getElementById('s'), select2 = document.getElementById('s2'), number = document.getElementById('n'), skip = document.getElementById('skip');
        let expected = (elem, text, minimum, padding) => { let span = document.createElement('span'); span.style.font = getComputedStyle(elem).font; span.innerText = text; document.documentElement.appendChild(span); let width = Math.max(minimum, span.offsetWidth + padding); span.remove(); return width; };
        let expectedSelect = expected(select, select.options[0].text, 50, 30), expectedSelect2 = expected(select2, select2.options[0].text, 50, 30), expectedNumber = expected(number, number.value, 40, 15);
        phase = []; appendCount = 0; readCount = 0;
        let helper = new window.AutoWidthBatchHelper();
        helper.measure([{ elem: select, text: select.options[0].text, minimum: 50, padding: 30 }, { elem: select2, text: select2.options[0].text, minimum: 50, padding: 30 }, { elem: number, text: number.value, minimum: 40, padding: 15 }, { elem: skip, text: skip.value, minimum: 40, padding: 15 }]);
        return { select: parseInt(select.style.width), select2: parseInt(select2.style.width), number: parseInt(number.style.width), expectedSelect, expectedSelect2, expectedNumber, skip: skip.style.width, appendCount, readCount, phase };
    });
    assert.equal(result.select, result.expectedSelect, 'select geometry changed');
    assert.equal(result.select2, result.expectedSelect2, 'second long select geometry changed');
    assert.equal(result.number, result.expectedNumber, 'number geometry changed');
    assert.equal(result.skip, '', 'nogrow control changed');
    assert.equal(result.appendCount, 3, 'unexpected measurement-node count');
    assert.equal(result.phase.slice(0, 6).join(','), 'append,append,append,read,read,read', 'layout reads interleaved with appends');
    console.log('PASS  Chromium geometry and staged reads at 390px');
    await page.setViewportSize({ width: 1440, height: 900 });
    const wide = await page.evaluate(() => {
        let select = document.getElementById('s'), select2 = document.getElementById('s2');
        let helper = new window.AutoWidthBatchHelper();
        helper.measure([{ elem: select, text: select.options[0].text, minimum: 50, padding: 30 }, { elem: select2, text: select2.options[0].text, minimum: 50, padding: 30 }]);
        let span = document.createElement('span'); span.style.font = getComputedStyle(select).font; span.innerText = select.options[0].text; document.documentElement.appendChild(span); let one = Math.max(50, span.offsetWidth + 30); span.remove();
        span = document.createElement('span'); span.style.font = getComputedStyle(select2).font; span.innerText = select2.options[0].text; document.documentElement.appendChild(span); let two = Math.max(50, span.offsetWidth + 30); span.remove();
        return [parseInt(select.style.width), one, parseInt(select2.style.width), two];
    });
    assert.equal(wide[0], wide[1], 'wide first geometry changed');
    assert.equal(wide[2], wide[3], 'wide second geometry changed');
    console.log('PASS  Chromium geometry at 1440px');

    await page.setContent('<div id="preset"></div>');
    await page.addScriptTag({ content: `window.calls = []; window.replies = []; window.errors = []; window.serverLoads = 0; window.permissions = { hasPermission: () => true }; window.loadServerSettings = () => { window.serverLoads++; }; window.getRequiredElementById = id => document.getElementById('preset'); window.genInputs = (...args) => window.calls.push(args); window.showError = error => window.errors.push(error); window.loadUserSettings = (done, error) => window.replies.push({ done, error }); ${settingsLoad}` });
    await page.evaluate(() => { window.loadSettingsEditor(true, () => window.calls.push('complete')); });
    assert.equal(await page.evaluate(() => window.calls.length), 0, 'settings replied before initial build');
    assert.equal(await page.evaluate(() => window.serverLoads), 0, 'startup loaded the hidden server settings form');
    await page.evaluate(() => window.replies[0].done());
    assert.deepEqual(await page.evaluate(() => window.calls), [[false, false], 'complete'], 'initial settings build contract changed');
    await page.evaluate(() => { window.calls = []; window.replies = []; document.getElementById('preset').innerHTML = ''; window.loadSettingsEditor(false); window.replies[0].done(); });
    assert.deepEqual(await page.evaluate(() => window.calls), [[true, false]], 'later settings reload built unused presets');
    assert.equal(await page.evaluate(() => window.serverLoads), 1, 'explicit settings reload stopped loading server settings');
    await page.evaluate(() => { window.calls = []; window.replies = []; document.getElementById('preset').innerHTML = '<span>existing</span>'; window.loadSettingsEditor(false); window.replies[0].done(); });
    assert.deepEqual(await page.evaluate(() => window.calls), [[true, true]], 'later settings reload failed to rebuild existing presets');
    await page.evaluate(() => { window.calls = []; window.replies = []; window.errors = []; document.getElementById('preset').innerHTML = ''; window.loadSettingsEditor(true, () => window.calls.push('complete')); window.replies[0].error('settings failed'); window.replies[0].done(); });
    assert.deepEqual(await page.evaluate(() => window.calls), [[false, false], 'complete'], 'failed startup did not complete exactly once');
    assert.deepEqual(await page.evaluate(() => window.errors), ['settings failed'], 'failed startup error was not surfaced');
    await page.evaluate(() => { window.calls = []; window.replies = []; document.getElementById('preset').innerHTML = ''; window.loadSettingsEditor(true); window.replies[0].done(); window.replies[0].done(); });
    assert.deepEqual(await page.evaluate(() => window.calls), [[false, false]], 'duplicate settings callbacks rebuilt twice');
    console.log('PASS  extracted settings-load and preset-laziness behavior');
    await page.addScriptTag({ content: presetBuild });
    await page.evaluate(() => { window.calls = []; document.getElementById('preset').innerHTML = ''; window.ensurePresetInputsBuilt(); });
    assert.deepEqual(await page.evaluate(() => window.calls), [[]], 'explicit first preset build did not run');
    await page.evaluate(() => { window.calls = []; document.getElementById('preset').innerHTML = '<span>existing</span>'; window.ensurePresetInputsBuilt(); });
    assert.deepEqual(await page.evaluate(() => window.calls), [], 'existing preset controls rebuilt unexpectedly');
    console.log('PASS  extracted first-preset-build behavior');
} finally {
    await browser.close();
}

assert.ok(params.includes('autoWidthBatchHelper.measure(widthEntries);'), 'parameter width batch missing');
console.log('PASS  source-backed lazy preset and rebuild contracts');
