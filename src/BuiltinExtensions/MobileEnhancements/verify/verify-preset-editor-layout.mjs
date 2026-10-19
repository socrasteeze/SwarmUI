/**
 * Preset editor layout: Simple row order and prompt autogrow, Classic single-line control height,
 * and Classic preset-modal prompt autogrow.
 *
 * Loads the shipped m.css / m_ui.js / m_presets.js and the shipped Classic stylesheets plus the
 * text-box sizer from site.js. No server.
 *
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-preset-editor-layout.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const M = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m`;
const MOBILE = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets`;
const results = [];

function check(name, pass, detail) {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

function extract(source, signature) {
    let start = source.indexOf(signature);
    if (start < 0) {
        throw new Error(`missing ${signature}`);
    }
    let open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] == '{') {
            depth++;
        }
        else if (source[i] == '}') {
            depth--;
            if (depth == 0) {
                return source.slice(start, i + 1);
            }
        }
    }
    throw new Error(`unbalanced ${signature}`);
}

const siteJs = readFileSync(`${REPO}/src/wwwroot/js/site.js`, 'utf8');
const presetsJs = readFileSync(`${REPO}/src/wwwroot/js/genpage/gentab/presets.js`, 'utf8');
const textBoxSizeAdjust = extract(siteJs, 'function textBoxSizeAdjust(');
const textPromptInputHandle = extract(siteJs, 'function textPromptInputHandle(');
const growPresetPromptAreas = extract(presetsJs, 'function growPresetPromptAreas(');

const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
try {
    const simple = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const simpleErrors = [];
    simple.on('pageerror', error => simpleErrors.push(error.message));
    await simple.setContent('<!doctype html><html><head></head><body></body></html>');
    await simple.addStyleTag({ path: `${M}/m.css` });
    await simple.addScriptTag({ content: `
        window.mState = { paramMeta: {}, params: {}, presets: [], activePresets: [], models: { 'Stable-Diffusion': [] }, changed() {} };
        window.MCreate = {
            paramLabel(key) {
                let meta = mState.paramMeta[key];
                return meta && meta.name ? meta.name : key;
            },
            UpscaleScaleParams: []
        };
        window.genericRequest = () => {};
        window.permissions = { hasPermission: () => true };
    ` });
    await simple.addScriptTag({ path: `${M}/m_ui.js` });
    await simple.addScriptTag({ path: `${M}/m_presets.js` });

    const order = await simple.evaluate(async () => {
        mState.paramMeta = {
            cfgscale: { name: 'CFG Scale' },
            negativeprompt: { name: 'Negative Prompt', view_type: 'prompt' },
            overrideoutpathformat: { name: 'Output path' },
            prompt: { name: 'Prompt', view_type: 'prompt' },
            sampler: { name: 'Sampler' },
            videoframes: { name: 'Video Frames' }
        };
        let map = {
            cfgscale: '1',
            negativeprompt: 'bad quality',
            overrideoutpathformat: 'out',
            prompt: 'a cat',
            sampler: 'euler',
            videoframes: '81'
        };
        mPresets.openEditor({ title: 'Order', description: '', is_starred: false, param_map: map }, () => {});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let sheet = [...document.querySelectorAll('.m-sheet')].pop();
        let rows = [...sheet.querySelectorAll('.m-preset-params .m-preset-param-label')].map(label => label.title);
        let video = [...sheet.querySelectorAll('.m-preset-video .m-preset-param-label')].map(label => label.title);
        for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
            elem.remove();
        }
        mState.paramMeta = {
            prompt: { name: 'Prompt', view_type: 'prompt' },
            negativeprompt: { name: 'Negative Prompt', view_type: 'prompt' },
            sampler: { name: 'Sampler' }
        };
        mPresets.openParamPicker({}, () => {});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let picker = [...document.querySelectorAll('.m-sheet')].pop();
        let pickerKeys = [...picker.querySelectorAll('.m-preset-row-sub')].map(row => row.textContent);
        return { rows, video, pickerKeys };
    });
    check('simple editor lists prompt then negative prompt, then the other keys alphabetically',
        JSON.stringify(order.rows) == JSON.stringify(['prompt', 'negativeprompt', 'cfgscale', 'overrideoutpathformat', 'sampler']),
        JSON.stringify(order.rows));
    check('simple editor video section stays in its own order',
        JSON.stringify(order.video) == JSON.stringify(['videoframes']),
        JSON.stringify(order.video));
    check('simple add-parameter list puts an adjacent prompt pair prompt-first',
        order.pickerKeys[0] == 'prompt' && order.pickerKeys[1] == 'negativeprompt',
        JSON.stringify(order.pickerKeys));

    const grown = await simple.evaluate(async () => {
        for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
            elem.remove();
        }
        let long = Array.from({ length: 8 }, () => 'misty forest path').join(', ');
        mState.paramMeta = {
            prompt: { name: 'Prompt', view_type: 'prompt' },
            negativeprompt: { name: 'Negative Prompt', view_type: 'prompt' }
        };
        mPresets.openEditor({ title: 'Grow', description: '', is_starred: false, param_map: {
            prompt: long,
            negativeprompt: 'low quality'
        } }, () => {});
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let sheet = [...document.querySelectorAll('.m-sheet')].pop();
        let prompt = sheet.querySelector('.m-preset-params .m-preset-textarea');
        let wide = { height: prompt.offsetHeight, fits: prompt.scrollHeight <= prompt.clientHeight + 2 };
        sheet.style.right = 'auto';
        sheet.style.width = '180px';
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await new Promise(resolve => setTimeout(resolve, 50));
        let narrow = { height: prompt.offsetHeight, fits: prompt.scrollHeight <= prompt.clientHeight + 2, width: Math.round(prompt.getBoundingClientRect().width) };
        let capText = Array.from({ length: 40 }, () => 'a whole line of prompt text').join('\n');
        prompt.value = capText;
        prompt.dispatchEvent(new Event('input'));
        await new Promise(resolve => requestAnimationFrame(resolve));
        let maxPx = 0.4 * window.innerHeight;
        let style = getComputedStyle(prompt);
        let capped = {
            taller: prompt.scrollHeight > prompt.clientHeight + 2,
            withinMax: prompt.offsetHeight <= maxPx + 2,
            overflow: style.overflowY
        };
        return { wide, narrow, capped };
    });
    check('simple prompt textarea grows to its text',
        grown.wide.fits && grown.wide.height > 40, JSON.stringify(grown.wide));
    check('simple prompt textarea regrows when its width changes',
        grown.narrow.width < 200 && grown.narrow.height > grown.wide.height && grown.narrow.fits,
        JSON.stringify(grown.narrow));
    check('simple prompt textarea caps at 40dvh and scrolls',
        grown.capped.taller && grown.capped.withinMax && (grown.capped.overflow == 'auto' || grown.capped.overflow == 'scroll'),
        JSON.stringify(grown.capped));

    const rerender = await simple.evaluate(async () => {
        for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
            elem.remove();
        }
        let block = Array.from({ length: 6 }, () => 'second paragraph of the prompt').join('\n');
        mState.paramMeta = {
            prompt: { name: 'Prompt', view_type: 'prompt' },
            steps: { name: 'Steps' }
        };
        mState.params = { prompt: block };
        mPresets.openEditor({ title: 'Add', description: '', is_starred: false, param_map: { steps: '20' } }, () => {});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let sheet = [...document.querySelectorAll('.m-sheet')].find(elem => elem.querySelector('.m-edit-save-button'));
        [...sheet.querySelectorAll('button')].find(button => button.textContent == 'Use current Create settings').click();
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await new Promise(resolve => setTimeout(resolve, 50));
        let prompt = [...sheet.querySelectorAll('.m-preset-param-row')]
            .find(row => row.querySelector('.m-preset-param-label').title == 'prompt')
            .querySelector('textarea');
        let captured = {
            fits: prompt.scrollHeight <= prompt.clientHeight + 2,
            height: prompt.offsetHeight,
            text: prompt.value.length
        };
        [...sheet.querySelectorAll('.m-preset-param-remove')].find(button => button.getAttribute('aria-label').includes('Steps')).click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await new Promise(resolve => setTimeout(resolve, 50));
        prompt = [...sheet.querySelectorAll('.m-preset-param-row')]
            .find(row => row.querySelector('.m-preset-param-label').title == 'prompt')
            .querySelector('textarea');
        return {
            fits: captured.fits && prompt.scrollHeight <= prompt.clientHeight + 2,
            height: prompt.offsetHeight,
            text: captured.text
        };
    });
    check('simple prompt textarea grows after Use current and remove re-render the rows',
        rerender.fits && rerender.height > 40 && rerender.text > 40, JSON.stringify(rerender));
    check('simple preset scripts produced no page errors', simpleErrors.length == 0, simpleErrors.join(' | '));
    await simple.close();

    const classicCss = [
        `${REPO}/src/wwwroot/css/bootstrap.min.css`,
        `${REPO}/src/wwwroot/css/site.css`,
        `${REPO}/src/wwwroot/css/genpage.css`,
        `${MOBILE}/mobile.css`,
        `${REPO}/src/wwwroot/css/themes/modern.css`,
        `${REPO}/src/wwwroot/css/themes/modern_dark.css`,
        `${MOBILE}/theme_mobile.css`
    ];
    const classicHtml = `<!doctype html><html><head></head><body>
        <div class="input-group"><div class="input-group-content">
            <select class="auto-dropdown"><option>Euler Ancestral</option></select>
            <input type="number" class="auto-number" value="20">
            <input type="number" class="auto-slider-number" value="7">
            <input type="text" class="auto-text" value="hello">
        </div></div>
        <div id="new_preset_modal_inputs" class="preset-modal-inputs">
            <textarea class="auto-text auto-text-block" id="preset_input_prompt" rows="2" oninput="textPromptInputHandle(this)"></textarea>
            <textarea class="auto-text auto-text-block" id="preset_input_negativeprompt" rows="2" oninput="textPromptInputHandle(this)"></textarea>
        </div>
    </body></html>`;

    /** Measures the four single-line controls. */
    async function measureControls(page) {
        return await page.evaluate(() => {
            let group = document.querySelector('.input-group-content');
            let select = group.querySelector('select.auto-dropdown');
            let number = group.querySelector('input.auto-number');
            let slider = group.querySelector('input.auto-slider-number');
            let text = group.querySelector('input.auto-text');
            let heights = [select, number, slider, text].map(elem => elem.offsetHeight);
            let selectStyle = getComputedStyle(select);
            let inner = select.clientHeight - parseFloat(selectStyle.paddingTop) - parseFloat(selectStyle.paddingBottom);
            return {
                heights,
                equal: Math.max(...heights) - Math.min(...heights) <= 1,
                font: selectStyle.fontSize,
                centered: inner + 0.5 >= parseFloat(selectStyle.fontSize)
            };
        });
    }

    const desktop = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await desktop.setContent(classicHtml);
    for (let file of classicCss) {
        await desktop.addStyleTag({ path: file });
    }
    await desktop.addScriptTag({ content: `
        let jitterDebug = false;
        function textPromptDoCount() {}
        ${textBoxSizeAdjust}
        ${textPromptInputHandle}
        ${growPresetPromptAreas}
    ` });
    const desktopHeights = await measureControls(desktop);
    check('classic desktop select, number, slider-number, and text share one height',
        desktopHeights.equal && desktopHeights.centered, JSON.stringify(desktopHeights));

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.setContent(classicHtml);
    for (let file of classicCss) {
        await phone.addStyleTag({ path: file });
    }
    await phone.addScriptTag({ content: `
        let jitterDebug = false;
        function textPromptDoCount() {}
        ${textBoxSizeAdjust}
        ${textPromptInputHandle}
        ${growPresetPromptAreas}
    ` });
    await phone.evaluate(() => {
        document.body.classList.add('small-window', 'coarse-pointer');
    });
    const phoneHeights = await measureControls(phone);
    check('classic mobile select, number, slider-number, and text share one height',
        phoneHeights.equal && phoneHeights.centered && phoneHeights.font == '16px', JSON.stringify(phoneHeights));

    const modal = await phone.evaluate(async () => {
        let prompt = document.getElementById('preset_input_prompt');
        let negative = document.getElementById('preset_input_negativeprompt');
        prompt.value = 'one line of the preset prompt\ntwo\nthree\nfour\nfive';
        negative.value = 'negative one\nnegative two';
        let before = prompt.offsetHeight;
        growPresetPromptAreas();
        await new Promise(resolve => requestAnimationFrame(resolve));
        let opened = {
            grew: prompt.offsetHeight > before,
            fits: prompt.scrollHeight <= prompt.clientHeight + 2,
            negativeFits: negative.scrollHeight <= negative.clientHeight + 2,
            height: prompt.offsetHeight
        };
        prompt.value = prompt.value + '\nsix\nseven\neight';
        prompt.dispatchEvent(new Event('input'));
        let typed = {
            taller: prompt.offsetHeight > opened.height,
            fits: prompt.scrollHeight <= prompt.clientHeight + 2
        };
        prompt.value = Array.from({ length: 50 }, () => 'preset prompt line').join('\n');
        prompt.dispatchEvent(new Event('input'));
        let maxPx = 0.4 * window.innerHeight;
        let style = getComputedStyle(prompt);
        let capped = {
            taller: prompt.scrollHeight > prompt.clientHeight + 2,
            withinMax: prompt.offsetHeight <= maxPx + 2,
            overflow: style.overflowY
        };
        return { opened, typed, capped };
    });
    check('classic preset prompt grows to its text when the editor opens',
        modal.opened.grew && modal.opened.fits && modal.opened.negativeFits, JSON.stringify(modal.opened));
    check('classic preset prompt grows again on input',
        modal.typed.taller && modal.typed.fits, JSON.stringify(modal.typed));
    check('classic preset prompt caps at 40vh and scrolls',
        modal.capped.taller && modal.capped.withinMax && (modal.capped.overflow == 'auto' || modal.capped.overflow == 'scroll'),
        JSON.stringify(modal.capped));
    check('classic create and edit both open through the preset grow helper',
        (presetsJs.match(/showPresetEditorModal\(/g) || []).length >= 3);

    await desktop.close();
    await phone.close();
}
finally {
    await browser.close();
}

const failed = results.filter(result => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
