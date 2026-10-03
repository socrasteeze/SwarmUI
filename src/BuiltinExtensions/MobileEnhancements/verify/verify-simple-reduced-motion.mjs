/**
 * /simple reduced-motion harness. Checks the shipped m.css rules in Chromium and WebKit without a server.
 * Run from the repository root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-reduced-motion.mjs
 */
import { chromium, webkit } from 'playwright';
import { mkdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CSS = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m.css`, 'utf8');
const results = [];

function check(name, pass, detail = '') {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function verify(browserType, name) {
    const browser = await browserType.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent('<div class="m-preview-canvas-pending"><div class="m-preview-canvas-bar"></div></div><div class="m-sheet-backdrop"></div><div class="m-sheet"></div><div class="m-live-tile"><div class="m-tile-progress"></div></div><div class="m-toast">Saved</div>');
    await page.addStyleTag({ content: CSS });
    let reduced = await page.evaluate(() => {
        let style = selector => getComputedStyle(document.querySelector(selector));
        return {
            pendingAnimation: style('.m-preview-canvas-bar').animationName,
            sheetTransition: style('.m-sheet').transitionDuration,
            backdropTransition: style('.m-sheet-backdrop').transitionDuration,
            progressTransition: style('.m-tile-progress').transitionDuration,
            toastTransition: style('.m-toast').transitionDuration
        };
    });
    check(`${name}: reduced motion removes travel and continuous motion`, reduced.pendingAnimation == 'none'
        && reduced.sheetTransition == '0s' && reduced.progressTransition == '0s', JSON.stringify(reduced));
    check(`${name}: reduced motion keeps short opacity feedback`, reduced.backdropTransition == '0.12s'
        && reduced.toastTransition == '0.12s', JSON.stringify(reduced));
    await page.evaluate(() => {
        let backdrop = document.querySelector('.m-sheet-backdrop');
        let sheet = document.querySelector('.m-sheet');
        let toast = document.querySelector('.m-toast');
        backdrop.classList.add('m-open');
        sheet.classList.add('m-open');
        toast.classList.add('m-toast-open');
    });
    await page.waitForTimeout(150);
    let state = await page.evaluate(() => {
        let backdrop = document.querySelector('.m-sheet-backdrop');
        let sheet = document.querySelector('.m-sheet');
        let toast = document.querySelector('.m-toast');
        let opened = { backdrop: getComputedStyle(backdrop).opacity, sheet: getComputedStyle(sheet).transform,
            toast: getComputedStyle(toast).opacity, toastPointer: getComputedStyle(toast).pointerEvents };
        backdrop.classList.remove('m-open');
        sheet.classList.remove('m-open');
        toast.classList.remove('m-toast-open');
        return { opened, closed: { sheet: getComputedStyle(sheet).transform, toastPointer: getComputedStyle(toast).pointerEvents } };
    });
    check(`${name}: sheet and toast still open and close functionally`, state.opened.backdrop == '1'
        && state.opened.sheet != 'none' && state.opened.toast == '1' && state.opened.toastPointer == 'auto'
        && state.closed.toastPointer == 'none', JSON.stringify(state));
    mkdirSync(`${REPO}/.local/full-audit`, { recursive: true });
    await page.screenshot({ path: `${REPO}/.local/full-audit/reduced-motion-${name.toLowerCase()}.png`, fullPage: false });
    await browser.close();
}

await verify(chromium, 'Chromium');
await verify(webkit, 'WebKit');
if (results.some(result => !result.pass)) {
    process.exitCode = 1;
}
