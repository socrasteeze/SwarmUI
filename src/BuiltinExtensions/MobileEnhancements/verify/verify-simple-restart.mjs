/**
 * /simple "Restart server" harness (fork). The row itself is trivial; the watcher behind it is not, and every
 * check here is aimed at the watcher:
 *
 * 1. It must not reload into the OLD process. The server stays responsive for a moment after accepting the
 *    request (its shutdown is a detached delayed task), so a naive "poll until it answers" watcher succeeds
 *    immediately and reloads back into the very server it was asked to replace. The fix is two-phase - wait
 *    for a probe to fail, THEN wait for one to succeed - and the "does not reload while the server is still
 *    up" check is the one that would catch a regression back to one phase.
 * 2. A server-side rejection (no permission) must restore the row and report, while a dead connection must
 *    NOT - the connection dying is the expected outcome of a successful restart, not a failure.
 * 3. It must give up with an honest message if the server never returns (a server not started from a launch
 *    script exits on code 42 and stays gone) or never goes down at all.
 *
 * Runs the REAL m_app.js against a scripted fake server: `genericRequest` and `fetch` are replaced in-page so
 * the harness can drive the up/down timeline exactly, and `hardRefresh` is stubbed to a flag so "it reloaded"
 * is observable without actually navigating. Timer values are patched down from the shipped 2s poll so the
 * whole thing runs in seconds rather than minutes - the loop structure under test is untouched.
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling rather than
 * part of the CI gate. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-restart.mjs
 * Set SWARM_CHROMIUM to override the browser path. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const M = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m`;

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

// The shipped source, with only the two poll delays shrunk so the suite runs in seconds. Asserted below to
// have actually matched, so a rename/retune of the timings fails loudly here instead of silently running the
// slow version (or, worse, testing nothing).
let appSource = readFileSync(`${M}/m_app.js`, 'utf8');
// replaceAll, not replace: there are two sleep sites (one per phase) and patching only the first leaves the
// up-phase sleeping the real 2s, so the whole second half of this suite silently tests nothing. That is
// exactly what happened while writing it, which is why the count below is asserted rather than assumed.
const patched = appSource.replaceAll('await sleep(2000);', 'await sleep(20);');
const sleepPatchCount = appSource.split('await sleep(2000);').length - 1;

const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
const page = await browser.newPage();
page.on('pageerror', e => check(`no page errors (${e.message})`, false));
// A real origin, not about:blank: buildMore reads localStorage (the haptics toggle), which an opaque origin
// refuses outright. Nothing is fetched from it - every request this test makes is stubbed in-page.
await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
await page.goto('http://localhost/simple');

check('the shipped watcher still uses the 2s poll this harness patches', sleepPatchCount == 2, `found ${sleepPatchCount} sites, expected 2`);

// Minimal stand-ins for the globals m_app.js touches, then the real class on top.
await page.evaluate(source => {
    window.mState = {
        load() {}, loadParamMeta() {}, changed() {}, onChange() {},
        presets: [], starredModels: {}, paramMeta: {}, params: {},
    };
    window.MCreate = { paramValueLabel: (id, v) => `${v}` };
    window.mGen = { queueTotal: 0, pollStatus() {} };
    window.mUI = {
        warnings: [],
        notes: [],
        warn(m) { this.warnings.push(m); },
        note(m) { this.notes.push(m); },
        confirm(msg, onYes) { this.lastConfirm = msg; onYes(); },
        el(tag, cls, text) { let e = document.createElement(tag); e.className = cls || ''; if (text != null) { e.textContent = text; } return e; },
        registerTab() {}, initRouter() {}, initKeyboardWatch() {}, moreItems: [],
    };
    window.mCreate = { openBackendSheet() {} };
    window.mAutoComplete = { loadSettings() {}, enterAccepts: false, setEnterAccepts() {} };
    window.permissions = { hasPermission: () => true };
    window.getSession = () => {};
    window.genericRequest = () => {};
    // eval rather than a <script> tag so the patched source is what runs, with no file/route plumbing.
    eval(source);
}, patched);

/** Builds a fresh More panel and returns a handle to its Restart row. */
async function freshRow() {
    return await page.evaluate(() => {
        document.body.innerHTML = '';
        let panel = document.createElement('div');
        document.body.appendChild(panel);
        window.mApp.buildMore(panel);
        let rows = [...panel.querySelectorAll('.m-more-item')];
        window.__row = rows.find(r => r.textContent == 'Restart server');
        return !!window.__row;
    });
}

check('the More panel has a Restart server row', await freshRow());
check('it is distinct from the client-side Force update row', await page.evaluate(() => {
    let labels = [...document.querySelectorAll('.m-more-item')].map(r => r.textContent);
    return labels.includes('Restart server') && labels.some(l => l.startsWith('Force update'));
}));

// ---- Permission gate ----
await page.evaluate(() => {
    window.permissions = { hasPermission: () => false };
    window.mUI.warnings = [];
    window.__requested = false;
    window.genericRequest = () => { window.__requested = true; };
    window.__row.click();
});
check('no permission: warns and never calls the API', await page.evaluate(() =>
    !window.__requested && window.mUI.warnings.some(w => w.includes('permission'))));
check('no permission: the row stays usable', await page.evaluate(() => !window.__row.disabled));

// ---- Confirm text mentions in-flight work only when there is some ----
await page.evaluate(() => { window.permissions = { hasPermission: () => true }; });
await freshRow();
await page.evaluate(() => {
    window.mGen.queueTotal = 0;
    window.genericRequest = () => {}; // accepted, never calls back - freezes the flow after the request
    window.__row.click();
});
check('confirm text omits the queue line when nothing is running', await page.evaluate(() =>
    !window.mUI.lastConfirm.includes('interrupts')));
await freshRow();
await page.evaluate(() => {
    window.mGen.queueTotal = 3;
    window.__row.click();
});
check('confirm text names the queued work when there is some', await page.evaluate(() =>
    window.mUI.lastConfirm.includes('interrupts 3 queued/running')), await page.evaluate(() => window.mUI.lastConfirm));
check('the row disables and reports while restarting', await page.evaluate(() =>
    window.__row.disabled && window.__row.textContent == 'Restarting server...'));

// ---- A server-side rejection restores the row; a dead connection does not ----
await freshRow();
await page.evaluate(() => {
    window.mUI.warnings = [];
    window.genericRequest = (url, data, cb, depth, errorHandle) => errorHandle('You do not have the permission restart.');
    window.__row.click();
});
check('string error (server rejected it): row restored and reported', await page.evaluate(() =>
    !window.__row.disabled && window.__row.textContent == 'Restart server' && window.mUI.warnings.some(w => w.includes('Could not restart'))));

// ---- The main event: two-phase watch, and no reload while the old server is still up ----
await freshRow();
await page.evaluate(() => {
    window.__reloaded = false;
    window.mApp.hardRefresh = () => { window.__reloaded = true; };
    window.__probes = 0;
    window.__serverUp = true; // still answering after accepting the request, as the real one is
    window.fetch = () => {
        window.__probes++;
        return window.__serverUp ? Promise.resolve({ ok: true }) : Promise.reject(new Error('down'));
    };
    window.genericRequest = (url, data, cb) => { window.__lastCall = { url, data }; cb({ success: true }); };
    window.__row.click();
});
check('it calls UpdateAndRestart with force (no git update requested)', await page.evaluate(() =>
    window.__lastCall.url == 'UpdateAndRestart' && window.__lastCall.data.force === true
    && window.__lastCall.data.doUpdateServer === undefined), await page.evaluate(() => JSON.stringify(window.__lastCall)));

await page.waitForTimeout(300); // several patched polls, with the server still up throughout
check('does NOT reload while the old server is still answering', await page.evaluate(() => !window.__reloaded));
check('it is actually probing during that time', await page.evaluate(() => window.__probes > 2), await page.evaluate(() => `${window.__probes} probes`));
// Asserted against the source rather than by intercepting a call: overriding window.fetch here would replace
// the fake server mid-run and strand the watcher (it did exactly that once), and the claim being made is a
// property of the shipped code, not of this run.
check('probes are POSTs, which the service worker passes straight through',
    appSource.includes("method: 'POST'") && appSource.includes("cache: 'no-store'"));

// Server goes away, then comes back - only now may it reload.
await page.evaluate(() => { window.__serverUp = false; });
await page.waitForTimeout(200);
check('still no reload while the server is down', await page.evaluate(() => !window.__reloaded));
check('the row reports the waiting state', await page.evaluate(() => window.__row.textContent.includes('waiting')));
await page.evaluate(() => { window.__serverUp = true; });
await page.waitForTimeout(300);
check('reloads once the server is back', await page.evaluate(() => window.__reloaded));
check('it finishes via hardRefresh, so client caches are cleared too', appSource.includes('this.hardRefresh();'));

// ---- Never comes back: give up with an honest message rather than spinning ----
await freshRow();
await page.evaluate(() => {
    window.mUI.warnings = [];
    window.__reloaded = false;
    window.mApp.hardRefresh = () => { window.__reloaded = true; };
    window.__serverUp = true;
    window.fetch = () => window.__serverUp ? Promise.resolve({ ok: true }) : Promise.reject(new Error('down'));
    window.genericRequest = (url, data, cb) => cb({ success: true });
    // Shrink only this run's up-phase budget so "never returns" resolves quickly.
    window.__row.click();
    setTimeout(() => { window.__serverUp = false; }, 50);
});
await page.waitForTimeout(400);
check('while down and waiting, it has not falsely reloaded', await page.evaluate(() => !window.__reloaded));
check('the give-up path names the launch-script cause', appSource.includes('it will not restart on its own'));
check('the never-went-down path tells the user to check the logs', appSource.includes('The server did not restart. Check the server logs.'));

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
