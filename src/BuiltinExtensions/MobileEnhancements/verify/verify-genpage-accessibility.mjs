/** Chromium checks for shared Genpage browser keyboard access and progress metadata resilience. */
import assert from 'assert/strict';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { chromium } from 'playwright';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BROWSERS = readFileSync(`${REPO}/src/wwwroot/js/genpage/helpers/browsers.js`, 'utf8');
const HANDLER = readFileSync(`${REPO}/src/wwwroot/js/genpage/helpers/generatehandler.js`, 'utf8');
const POPOVERS = readFileSync(`${REPO}/src/wwwroot/js/genpage/helpers/ui_improvements.js`, 'utf8');
const SCREENSHOTS = `${REPO}/.local/full-audit/screens`;

function check(name, condition, detail = '') {
    assert.equal(condition, true, name);
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
}

function extract(source, signature) {
    let start = source.indexOf(signature);
    assert.ok(start >= 0, `missing ${signature}`);
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

const buildContentList = extract(BROWSERS, '    buildContentList(container, files, before = null, startId = 0) {').replaceAll(/^    /gm, '');
const clearOwnedPopovers = extract(BROWSERS, '    clearOwnedPopovers() {').replaceAll(/^    /gm, '');
const internalHandleData = extract(HANDLER, '    internalHandleData(data, images, discardable, timeLastGenHit, actualInput, socketId, socket, isPreview, batch_id) {').replaceAll(/^    /gm, '');
const hidePopover = extract(POPOVERS, 'function hidePopover(');
const showPopover = extract(POPOVERS, 'function showPopover(');
const doPopover = extract(POPOVERS, 'function doPopover(');

mkdirSync(SCREENSHOTS, { recursive: true });
const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setContent('<!doctype html><div id="root"></div>');
    await page.addStyleTag({ path: `${REPO}/src/wwwroot/css/site.css` });
    await page.addScriptTag({ content: `
        function createDiv(id, classes, html = '') { let elem = document.createElement('div'); elem.id = id || ''; elem.className = classes || ''; elem.innerHTML = html; return elem; }
        function createSpan(id, classes, html = '') { let elem = document.createElement('span'); elem.id = id || ''; elem.className = classes || ''; elem.innerHTML = html; return elem; }
        let popHide = [];
        let lastPopover = null;
        let lastPopoverTime = 0;
        let mouseX = 0;
        let mouseY = 0;
        function getRequiredElementById(id) { return document.getElementById(id); }
        ${hidePopover}
        ${showPopover}
        ${doPopover}
        function isValidMediaPath() { return false; }
        function escapeHtml(text) { return text; }
        function stripHtmlToText(text) { return text; }
        let browserUtil = { makeVisible() { } };
        class TestBrowser { ${buildContentList}\n${clearOwnedPopovers} }
        window.makeBrowser = format => {
            let browser = new TestBrowser();
            browser.maxPreBuild = 512;
            browser.format = format;
            browser.filter = '';
            browser.chunksRendered = 0;
            browser.id = 'audit';
            browser.handleMultiSelectTileClick = () => false;
            browser.select = () => { window.selections = (window.selections || 0) + 1; };
            browser.describe = file => ({ className: '', description: 'description', searchable: file.name, image: '', buttons: [{ label: 'Action', onclick() { window.actions = (window.actions || 0) + 1; } }] });
            return browser;
        };
        class TestHandler { ${internalHandleData} }
        window.checkProgress = metadata => {
            let handler = new TestHandler();
            handler.progressBarHtml = '';
            handler.gotImagePreview = () => null;
            handler.gotTrackedImagePreview = () => { };
            handler.gotProgress = () => { window.progressCalls = (window.progressCalls || 0) + 1; };
            handler.getDiv = () => null;
            handler.setCurrentImage = () => { };
            handler.setImageFor = () => { };
            handler.gotTrackedImageResult = () => { };
            handler.appendGenTimeFrom = () => { };
            handler.internalHandleData({ gen_progress: { request_id: 'request', batch_index: 0, metadata } }, {}, {}, [Date.now()], { model: 'fallback-model' }, 'normal', null, false, 1);
        };
    ` });

    for (let format of ['Cards', 'Thumbnails', 'List', 'Details List']) {
        await page.evaluate(format => {
            document.getElementById('root').replaceChildren();
            document.body.querySelectorAll('.sui-popover').forEach(elem => elem.remove());
            window.selections = 0;
            window.actions = 0;
            window.menuOpens = 0;
            let browser = window.makeBrowser(format);
            browser.buildContentList(document.getElementById('root'), [{ name: 'entry', data: { src: 'entry' } }]);
            let image = document.querySelector('.image-block-img-inner');
            let menu = document.querySelector('.model-block-menu-button');
            let action = document.querySelector('.sui_popover_model_button');
            image.dataset.audit = 'image';
            menu.dataset.audit = 'menu';
            action.dataset.audit = 'action';
        }, format);
        const image = page.locator('[data-audit="image"]');
        const menu = page.locator('[data-audit="menu"]');
        const action = page.locator('[data-audit="action"]');
        await image.focus();
        await image.press('Enter');
        await image.press('Space');
        await menu.focus();
        const beforeOpen = await action.evaluate(element => getComputedStyle(element).visibility);
        await menu.press('Enter');
        await page.waitForTimeout(10);
        const focusedAction = await page.evaluate(() => document.activeElement?.dataset.audit);
        await action.press('Enter');
        await action.press('Escape');
        const result = await page.evaluate(() => {
            let image = document.querySelector('[data-audit="image"]');
            let menu = document.querySelector('[data-audit="menu"]');
            let action = document.querySelector('[data-audit="action"]');
            return { selections: window.selections, actions: window.actions, imageTabIndex: image.tabIndex, menuTabIndex: menu.tabIndex, actionTabIndex: action.tabIndex, activeIsMenu: document.activeElement == menu, hidden: document.querySelector('.sui-popover').dataset.visible == 'false' };
        });
        check(`${format} supports keyboard selection`, result.selections == 2 && result.imageTabIndex == 0);
        check(`${format} keyboard opening focuses its hidden first action`, beforeOpen == 'hidden' && focusedAction == 'action', `${beforeOpen}/${focusedAction}`);
        check(`${format} supports one keyboard menu action without duplicate activation`, result.actions == 1 && result.menuTabIndex == 0 && result.actionTabIndex == 0);
        check(`${format} Escape closes the menu and restores menu focus`, result.hidden && result.activeIsMenu);
        await page.screenshot({ path: `${SCREENSHOTS}/browser-${format.replaceAll(' ', '-').toLowerCase()}.png`, fullPage: true });
    }

    const popoverResult = await page.evaluate(() => {
        document.getElementById('root').replaceChildren();
        document.body.querySelectorAll('.sui-popover').forEach(elem => elem.remove());
        let browser = window.makeBrowser('Cards');
        let files = Array.from({ length: 160 }, (_, index) => ({ name: `entry-${index}`, data: { src: `entry-${index}` } }));
        browser.buildContentList(document.getElementById('root'), files);
        let other = createDiv('popover_other-1', 'sui-popover');
        document.body.appendChild(other);
        browser.clearOwnedPopovers();
        document.getElementById('root').replaceChildren();
        browser.buildContentList(document.getElementById('root'), [files[0]]);
        return { count: document.querySelectorAll('.sui-popover').length, other: document.getElementById('popover_other-1') != null };
    });
    check('browser rebuild clears only its old action popovers', popoverResult.count == 2 && popoverResult.other, `${popoverResult.count} remaining`);

    await page.evaluate(() => {
        document.getElementById('root').replaceChildren();
        window.selections = 0;
        window.multiSelects = 0;
        let browser = window.makeBrowser('Cards');
        browser.handleMultiSelectTileClick = () => { window.multiSelects++; return true; };
        browser.buildContentList(document.getElementById('root'), [{ name: 'entry', data: { src: 'entry' } }]);
        document.querySelector('.image-block-img-inner').dataset.audit = 'multi-image';
    });
    await page.locator('[data-audit="multi-image"]').focus();
    await page.locator('[data-audit="multi-image"]').press('Enter');
    check('keyboard multi-select executes once without normal selection', await page.evaluate(() => window.multiSelects == 1 && window.selections == 0));

    for (let metadata of ['not-json', '', null, [], '[]', '"string"', '{}']) {
        await page.evaluate(metadata => window.checkProgress(metadata), metadata);
    }
    check('malformed, empty, null, and non-object progress metadata keep later progress handling live', await page.evaluate(() => window.progressCalls == 7));

    let normal = await page.evaluate(() => getComputedStyle(document.querySelector('.sui-popover')).transition);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    let reduced = await page.evaluate(() => getComputedStyle(document.querySelector('.sui-popover')).transition);
    check('shared popovers use a short ease-out normal fade', normal.includes('0.2s') && normal.includes('ease-out'));
    check('shared popovers reduce to a 100ms opacity fade', reduced.includes('0.1s') && reduced.includes('ease-out'));
    await page.evaluate(() => document.querySelector('.sui-popover').classList.add('sui-popover-notransition'));
    check('popover no-transition override remains authoritative under reduced motion', await page.evaluate(() => getComputedStyle(document.querySelector('.sui-popover')).transition == 'none'));
    check('browser keyboard tests produced no page errors', pageErrors.length == 0, pageErrors.join('\n'));
} finally {
    await browser.close();
}
