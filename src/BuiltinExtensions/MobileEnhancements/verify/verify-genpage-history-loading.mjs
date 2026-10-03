/** Chromium checks for bounded Genpage History browser rendering. */
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { chromium } from 'playwright';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BROWSERS = readFileSync(`${REPO}/src/wwwroot/js/genpage/helpers/browsers.js`, 'utf8');
const HISTORY = readFileSync(`${REPO}/src/wwwroot/js/genpage/gentab/outputhistory.js`, 'utf8');

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

let buildContentList = extract(BROWSERS, '    buildContentList(container, files, before = null, startId = 0) {').replaceAll(/^    /gm, '');
let buttonsForImage = extract(HISTORY, 'function buttonsForImage(');
let describeOutputFile = extract(HISTORY, 'function describeOutputFile(');

check('History owns a 50-record initial renderer cap', HISTORY.includes('imageHistoryBrowser.maxPreBuild = 50;'));
check('History keeps its server-filter callback', HISTORY.includes('imageHistoryBrowser.filterEvent = scheduleImageHistoryServerFilter;'));
check('History preserves sort reload wiring', HISTORY.includes("imageHistoryBrowser.lightRefresh();"));
check('History retains selection and delete actions', HISTORY.includes('function selectOutputInHistory(') && HISTORY.includes("label: 'Delete'"));
check('Browser rebuild keeps content scroll offset', BROWSERS.includes('scrollOffset = this.contentDiv.scrollTop;') && BROWSERS.includes('this.contentDiv.scrollTop = scrollOffset;'));
check('Browser rebuild clears old content before progressive chunks', BROWSERS.includes("this.contentDiv.innerHTML = '';"));

const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent('<!doctype html><div id="root"></div>');
    await page.addScriptTag({ content: `
        let registeredMediaButtons = [];
        let buttons;
        let formatCalls = 0;
        let parseCalls = 0;
        let permissions = { hasPermission: () => false };
        let localStorage = { getItem: () => null };
        function getMediaType() { return 'image'; }
        function escapeHtml(text) { return String(text); }
        function escapeHtmlForUrl(text) { return String(text); }
        function interpretMetadata(text) { parseCalls++; return text; }
        function formatMetadata() { formatCalls++; return 'metadata'; }
        function isValidMediaPath() { return false; }
        function createDiv(id, className) { let elem = document.createElement('div'); elem.id = id || ''; elem.className = className || ''; return elem; }
        function createSpan(id, className) { let elem = document.createElement('span'); elem.id = id || ''; elem.className = className || ''; return elem; }
        function doPopover() { }
        let browserUtil = { makeVisible() { } };
        ${buttonsForImage}
        ${describeOutputFile}
        class TestBrowser { ${buildContentList} }
        window.makeHistoryRenderer = (format, maxPreBuild) => {
            let renderer = new TestBrowser();
            renderer.maxPreBuild = maxPreBuild;
            renderer.format = format;
            renderer.filter = '';
            renderer.chunksRendered = 0;
            renderer.id = 'imagehistorybrowser';
            renderer.describe = describeOutputFile;
            renderer.select = () => { };
            return renderer;
        };
        window.makeHistoryFiles = count => Array.from({ length: count }, (_, index) => ({
            name: 'history/' + index + '.png',
            data: {
                fullsrc: 'history/' + index + '.png',
                src: 'Output/history/' + index + '.png',
                name: index + '.png',
                metadata: JSON.stringify({ is_starred: false, sui_image_params: { width: 1024, height: 768 }, sui_extra_data: { seed: index } })
            }
        }));
        window.renderHistory = (format, maxPreBuild, count) => {
            document.body.querySelectorAll('.sui-popover').forEach(elem => elem.remove());
            let root = document.getElementById('root');
            root.replaceChildren();
            formatCalls = 0;
            parseCalls = 0;
            let renderer = window.makeHistoryRenderer(format, maxPreBuild);
            let start = performance.now();
            renderer.buildContentList(root, window.makeHistoryFiles(count));
            let elapsed = performance.now() - start;
            return { root, elapsed, formatCalls, parseCalls };
        };
    ` });
    let matched = await page.evaluate(() => {
        let baseline = window.renderHistory('Thumbnails', 512, 600);
        let baselineResult = {
            descriptors: baseline.formatCalls,
            cards: baseline.root.querySelectorAll('[data-name]').length,
            elapsed: baseline.elapsed
        };
        let candidate = window.renderHistory('Thumbnails', 50, 600);
        return {
            baseline: baselineResult,
            candidate: {
                descriptors: candidate.formatCalls,
                cards: candidate.root.querySelectorAll('[data-name]').length,
                loaders: candidate.root.querySelectorAll('.browser-section-loader').length,
                elapsed: candidate.elapsed
            }
        };
    });
    check('50-record cap bounds initial real History descriptors', matched.baseline.descriptors == 513 && matched.candidate.descriptors == 51,
        `${matched.baseline.descriptors} -> ${matched.candidate.descriptors}`);
    check('50-record cap bounds initial History card DOM', matched.baseline.cards == 512 && matched.candidate.cards == 50 && matched.candidate.loaders > 0,
        `${matched.baseline.cards} -> ${matched.candidate.cards} cards`);
    console.log(`INFO  fixture diagnostic first-render time ${matched.baseline.elapsed.toFixed(2)}ms -> ${matched.candidate.elapsed.toFixed(2)}ms`);

    for (let format of ['List', 'Cards', 'Thumbnails']) {
        let result = await page.evaluate((format) => {
            let rendered = window.renderHistory(format, 50, 137);
            let root = rendered.root;
            let initialCards = root.querySelectorAll('[data-name]').length;
            let loaders = [...root.querySelectorAll('.browser-section-loader')];
            for (let loader of loaders) {
                loader.click();
            }
            let cards = [...root.querySelectorAll('[data-name]')];
            let ids = [...document.body.querySelectorAll('.sui-popover')].map(elem => elem.id);
            return {
                initialCards,
                allNames: cards.map(card => card.dataset.name),
                ids,
                loaderCount: loaders.length
            };
        }, format);
        check(`${format} retains all lazy History records`, result.initialCards == 50 && result.allNames.length == 137 && new Set(result.allNames).size == 137 && result.loaderCount > 0);
        check(`${format} gives every History action menu a unique ID`, result.ids.length == 137 && new Set(result.ids).size == 137);
    }
} finally {
    await browser.close();
}
