/** /simple shared viewer prompt and full-width action layout harness. */
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
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    let labels = await page.evaluate(() => [...document.querySelectorAll('.m-viewer-action')].map(button => button.textContent));
    let widths = geometry.buttons.slice(0, 5).map(box => box.width);
    let closeBox = geometry.buttons[geometry.buttons.length - 1];
    check(`${size[0]}x${size[1]} actions are a 3-column grid with Close across the last row`, geometry.buttons.length == 6
        && labels.join('|') == 'Reuse Params|Copy Prompt|Prompt Img|Star|Delete|Close'
        && Math.abs(geometry.buttons[0].left - geometry.footer.left) <= 1
        && Math.abs(geometry.buttons[2].top - geometry.buttons[0].top) <= 1
        && Math.abs(geometry.buttons[3].top - geometry.buttons[4].top) <= 1
        && geometry.buttons[3].top > geometry.buttons[0].bottom - 1
        && Math.abs(closeBox.left - geometry.footer.left) <= 1
        && Math.abs(closeBox.right - geometry.footer.right) <= 1
        && closeBox.top > geometry.buttons[3].bottom - 1
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

mkdirSync(`${REPO}/.local/simple-viewer`, { recursive: true });
await page.evaluate(() => { document.querySelector('.m-viewer')?.remove(); mImages.openViewer(mImages.entries[0], 0); });
await page.screenshot({ path: `${REPO}/.local/simple-viewer/viewer-${engine == webkit ? 'webkit' : 'chromium'}.png`, fullPage: true });
await browser.close();
process.exit(failed ? 1 : 0);
