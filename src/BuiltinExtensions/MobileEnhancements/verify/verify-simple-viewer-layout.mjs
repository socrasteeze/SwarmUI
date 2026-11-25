/** /simple shared viewer prompt, model/LoRA lines, and 3x2 action layout harness. */
import { chromium, webkit } from 'playwright';
import { mkdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SOURCE = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m_images.js`, 'utf8');
const CSS = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m.css`, 'utf8');
const engine = process.env.SWARM_WEBKIT == '1' ? webkit : chromium;
const browser = await engine.launch(engine == chromium && process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
const page = await browser.newPage();
let failed = false;
function check(name, pass, detail = '') {
    failed ||= !pass;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}
page.on('pageerror', error => check(`no page errors: ${error.message}`, false));
await page.setContent('<style>:root{--background:#111;--background-panel:#222;--text:#eee;--border-color:#555;--m-safe-left:0px;--m-safe-right:0px;--m-safe-bottom:0px}html,body{margin:0;width:100%;height:100%;background:#111}</style><div class="m-app"></div>');
await page.addStyleTag({ content: CSS });
await page.evaluate(() => {
    Object.defineProperty(window, 'localStorage', { value: { getItem: () => null, setItem: () => {} } });
    window.mGen = { onFrame: () => {} };
    window.mUI = { el: (tag, classes, text = '') => { let el = document.createElement(tag); el.className = classes; el.textContent = text; return el; }, warn: () => {}, confirm: () => {} };
    window.mState = { params: { prompt: 'wrong current prompt' }, promptImages: [], applyMetadata: () => true, changed: () => {} };
    window.mCreate = { forgetImage: () => {} };
    window.genericRequest = () => {};
    window.getImageOutPrefix = () => '/View';
});
await page.addScriptTag({ content: SOURCE });
const longPrompt = Array.from({ length: 80 }, (_, i) => `resolved-${i}`).join(' ');
await page.evaluate(prompt => {
    mImages.entries = [
        { url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', fullsrc: 'one.png', metadata: JSON.stringify({ sui_image_params: { prompt }, sui_extra_data: { original_prompt: 'wrong original' } }) },
        { url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', fullsrc: 'two.png', metadata: { sui_image_params: { prompt: '<b>literal & safe</b>' } } }
    ];
}, longPrompt);

for (let size of [[360, 800], [390, 844], [768, 900], [1440, 900], [680, 420]]) {
    await page.setViewportSize({ width: size[0], height: size[1] });
    await page.evaluate(() => { document.querySelector('.m-viewer')?.remove(); mImages.openViewer(mImages.entries[0], 0); });
    let geometry = await page.evaluate(() => {
        let viewer = document.querySelector('.m-viewer').getBoundingClientRect();
        let image = document.querySelector('.m-viewer-imgwrap').getBoundingClientRect();
        let prompt = document.querySelector('.m-viewer-prompt');
        let promptBox = prompt.getBoundingClientRect();
        let footer = document.querySelector('.m-viewer-actions').getBoundingClientRect();
        let buttons = [...document.querySelectorAll('.m-viewer-action')].map(button => button.getBoundingClientRect());
        let promptStyle = getComputedStyle(prompt);
        let lineHeight = parseFloat(promptStyle.lineHeight);
        let padding = parseFloat(promptStyle.paddingTop) + parseFloat(promptStyle.paddingBottom);
        return { viewer, image, promptBox, footer, buttons, lines: (promptBox.height - padding) / lineHeight,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            closeClass: !!document.querySelector('.m-viewer-close') };
    });
    let labels = await page.evaluate(() => [...document.querySelectorAll('.m-viewer-action')].map(button => button.textContent));
    let widths = geometry.buttons.map(box => box.width);
    let closeBox = geometry.buttons[5];
    let starBox = geometry.buttons[3];
    let deleteBox = geometry.buttons[4];
    check(`${size[0]}x${size[1]} actions are a 3x2 grid with Close beside Delete`, geometry.buttons.length == 6
        && labels.join('|') == 'Reuse Params|Copy Prompt|Prompt Img|Star|Delete|Close'
        && !geometry.closeClass
        && Math.abs(geometry.buttons[0].left - geometry.footer.left) <= 1
        && Math.abs(geometry.buttons[1].top - geometry.buttons[0].top) <= 1
        && Math.abs(geometry.buttons[2].top - geometry.buttons[0].top) <= 1
        && Math.abs(starBox.top - deleteBox.top) <= 1
        && Math.abs(closeBox.top - starBox.top) <= 1
        && starBox.top > geometry.buttons[0].bottom - 1
        && closeBox.left > deleteBox.right - 1
        && Math.abs(closeBox.right - geometry.footer.right) <= 1
        && closeBox.width * 2 < geometry.footer.width
        && Math.max(...widths) - Math.min(...widths) <= 1
        && geometry.buttons.every(box => box.height >= 44), JSON.stringify({ labels, footer: geometry.footer, buttons: geometry.buttons }));
    check(`${size[0]}x${size[1]} prompt and image remain contained`, geometry.lines <= 5.05
        && geometry.image.bottom <= geometry.promptBox.top + 1 && geometry.promptBox.bottom <= geometry.footer.top + 1
        && geometry.footer.bottom <= geometry.viewer.bottom + 1 && geometry.overflow <= 1, JSON.stringify(geometry));
}

let content = await page.evaluate(() => ({ prompt: document.querySelector('.m-viewer-prompt').textContent, current: 'unrelated current prompt' }));
check('viewer uses resolved prompt instead of original or current prompt', content.prompt.startsWith('resolved-0') && !content.prompt.includes('wrong original') && !content.prompt.includes(content.current), content.prompt.slice(0, 80));
await page.evaluate(() => {
    let wrap = document.querySelector('.m-viewer-imgwrap');
    let start = new Event('touchstart');
    Object.defineProperty(start, 'touches', { value: { length: 1, item: () => ({ clientX: 300, clientY: 100 }) } });
    wrap.dispatchEvent(start);
    let end = new Event('touchend');
    Object.defineProperty(end, 'changedTouches', { value: { item: () => ({ clientX: 100, clientY: 105 }) } });
    wrap.dispatchEvent(end);
});
content = await page.evaluate(() => document.querySelector('.m-viewer-prompt').textContent);
check('swipe updates the image-specific prompt and renders HTML literally', content == '<b>literal & safe</b>', content);

await page.evaluate(() => { document.querySelector('.m-viewer')?.remove(); mImages.openViewer({ url: 'x', fullsrc: 'bad.png', metadata: 'not json with steps 20' }, null); });
check('malformed metadata shows no borrowed prompt and causes no error', await page.locator('.m-viewer-prompt').count() == 0);
await page.evaluate(() => { document.querySelector('.m-viewer')?.remove(); mImages.openViewer({ url: 'x', fullsrc: 'plain.png', metadata: JSON.stringify({ prompt: 'legacy top-level prompt' }) }, null); });
check('legacy top-level prompt metadata remains supported', await page.locator('.m-viewer-prompt').textContent() == 'legacy top-level prompt');
await page.evaluate(() => { document.querySelector('.m-viewer')?.remove(); mImages.openViewer({ url: 'x', metadata: { prompt: 42 } }, null); });
check('non-string and array-like metadata do not render as prompts', await page.locator('.m-viewer-prompt').count() == 0);

/** Opens one image and reads the model block. metadata may be an object, a JSON string, or empty. */
async function openMeta(metadata) {
    return await page.evaluate(meta => {
        document.querySelector('.m-viewer')?.remove();
        mImages.openViewer({ url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', fullsrc: 'meta.png', metadata: meta }, null);
        let block = document.querySelector('.m-viewer-models');
        let prompt = document.querySelector('.m-viewer-prompt');
        let viewer = document.querySelector('.m-viewer');
        let order = viewer ? [...viewer.children].map(el => el.className) : [];
        return {
            models: block ? block.textContent : '',
            present: !!block,
            prompt: prompt ? prompt.textContent : '',
            order
        };
    }, metadata);
}
let shown = await openMeta(JSON.stringify({
    sui_image_params: {
        prompt: 'keep this prompt',
        model: 'anima/checkpoints/anima-preview.safetensors',
        loras: ['styles/soft light.safetensors', 'detail/micro.ckpt'],
        loraweights: ['0.8', '1.25']
    },
    model: 'ignored/top-level.pt',
    sui_extra_data: { original_prompt: 'not the model' }
}));
check('viewer shows checkpoint short name and LoRA weights under the prompt', shown.present
    && shown.models.includes('Checkpoint: anima-preview')
    && shown.models.includes('soft light: 0.8')
    && shown.models.includes('micro: 1.25')
    && !shown.models.includes('anima/checkpoints')
    && !shown.models.includes('.safetensors')
    && !shown.models.includes('top-level')
    && !shown.models.includes('not the model')
    && shown.prompt == 'keep this prompt'
    && shown.order.indexOf('m-viewer-prompt') < shown.order.indexOf('m-viewer-models')
    && shown.order.indexOf('m-viewer-models') < shown.order.indexOf('m-viewer-actions'), shown.models);
shown = await openMeta({ sui_image_params: { loras: 'folder/only.pt,folder/second.gguf', loraweights: '0.4' } });
check('a LoRA with no paired weight still shows its short name', shown.present
    && shown.models.includes('LoRAs: only: 0.4, second')
    && !shown.models.includes('Checkpoint')
    && !shown.models.includes('.pt')
    && !shown.models.includes('.gguf'), shown.models);
shown = await openMeta({ model: 'vae\\hero.ckpt', loras: 'a/one.pt\n|||\nb/two.safetensors', loraweights: [0.5, ''] });
check('legacy top-level model and list forms are shown', shown.models.includes('Checkpoint: hero')
    && shown.models.includes('one: 0.5')
    && shown.models.includes('two')
    && !shown.models.includes('two:'), shown.models);
shown = await openMeta({ sui_image_params: { prompt: 'just a prompt', steps: 20, negativeprompt: 'folder/secret.safetensors' } });
check('missing model and loras omit the block and do not borrow other fields', !shown.present && shown.models == '' && shown.prompt == 'just a prompt');
shown = await openMeta({});
check('empty metadata omits the model block', !shown.present && shown.models == '');
shown = await openMeta('');
check('blank metadata omits the model block', !shown.present);
shown = await openMeta(null);
check('missing metadata omits the model block', !shown.present);
shown = await openMeta('not json with steps 20 and model foo.safetensors');
check('malformed metadata omits the model block and does not borrow text', !shown.present && !shown.models.includes('foo') && !shown.models.includes('steps'));
shown = await openMeta({ sui_image_params: { model: '   ', loras: [], loraweights: [1] } });
check('blank model and empty loras omit the block', !shown.present && shown.models == '');

await page.setViewportSize({ width: 360, height: 800 });
let longLoras = Array.from({ length: 12 }, (_, i) => `folder/very-long-lora-name-number-${i}-extra-text.safetensors`);
let longWeights = longLoras.map((_, i) => (0.1 * (i + 1)).toFixed(2));
let longGeom = await page.evaluate(({ loras, weights }) => {
    document.querySelector('.m-viewer')?.remove();
    mImages.openViewer({
        url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        fullsrc: 'long.png',
        metadata: { sui_image_params: { prompt: 'short prompt', model: 'checkpoints/this-is-a-very-long-checkpoint-file-name.safetensors', loras, loraweights: weights } }
    }, null);
    let models = document.querySelector('.m-viewer-models');
    let box = models.getBoundingClientRect();
    let style = getComputedStyle(models);
    let buttons = [...document.querySelectorAll('.m-viewer-action')].map(button => button.getBoundingClientRect());
    let footer = document.querySelector('.m-viewer-actions').getBoundingClientRect();
    let viewer = document.querySelector('.m-viewer').getBoundingClientRect();
    let prompt = document.querySelector('.m-viewer-prompt').getBoundingClientRect();
    return {
        text: models.textContent,
        lines: box.height / parseFloat(style.lineHeight),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        modelOverflow: models.scrollWidth - models.clientWidth,
        boxWidth: box.width,
        viewerWidth: viewer.width,
        footerBottom: footer.bottom,
        viewerBottom: viewer.bottom,
        promptBottom: prompt.bottom,
        modelsTop: box.top,
        closeTop: buttons[5].top,
        starTop: buttons[3].top,
        closeWidth: buttons[5].width,
        starWidth: buttons[3].width,
        count: buttons.length,
        labels: [...document.querySelectorAll('.m-viewer-action')].map(button => button.textContent).join('|')
    };
}, { loras: longLoras, weights: longWeights });
check('long LoRA list wraps without horizontal overflow or a blown action grid', longGeom.lines > 1.4
    && longGeom.overflow <= 1
    && longGeom.modelOverflow <= 1
    && longGeom.boxWidth <= longGeom.viewerWidth + 1
    && longGeom.promptBottom <= longGeom.modelsTop + 1
    && longGeom.footerBottom <= longGeom.viewerBottom + 1
    && longGeom.count == 6
    && longGeom.labels == 'Reuse Params|Copy Prompt|Prompt Img|Star|Delete|Close'
    && Math.abs(longGeom.closeTop - longGeom.starTop) <= 1
    && Math.abs(longGeom.closeWidth - longGeom.starWidth) <= 1
    && longGeom.text.includes('Checkpoint: this-is-a-very-long-checkpoint-file-name')
    && longGeom.text.includes('very-long-lora-name-number-0-extra-text: 0.10')
    && !longGeom.text.includes('.safetensors'), JSON.stringify(longGeom));

await page.evaluate(() => { document.querySelector('.m-viewer')?.remove(); mImages.openViewer(mImages.entries[0], 0); });
await page.locator('.m-viewer-action', { hasText: 'Close' }).click();
check('Close click removes the viewer', await page.locator('.m-viewer').count() == 0);
await page.evaluate(() => { mImages.openViewer(mImages.entries[0], 0); document.querySelector('.m-viewer').focus(); });
await page.keyboard.press('Escape');
check('Escape still closes the viewer', await page.locator('.m-viewer').count() == 0);

mkdirSync(`${REPO}/.local/simple-viewer`, { recursive: true });
await page.evaluate(() => { document.querySelector('.m-viewer')?.remove(); mImages.openViewer(mImages.entries[0], 0); });
await page.screenshot({ path: `${REPO}/.local/simple-viewer/viewer-${engine == webkit ? 'webkit' : 'chromium'}.png`, fullPage: true });
await browser.close();
process.exit(failed ? 1 : 0);
