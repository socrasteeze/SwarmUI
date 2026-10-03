/** Deterministic resume/recovery checks for the shipped Genpage mobile network helper. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

let repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
let source = readFileSync(`${repo}/src/BuiltinExtensions/MobileEnhancements/Assets/mobile_network.js`, 'utf8');
let results = [];

/** Records one assertion without stopping independent recovery checks. */
function check(name, pass, detail = '') {
    results.push(pass);
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** Creates the smallest browser host needed by the real helper. */
function makeNetwork() {
    let documentListeners = {};
    let windowListeners = {};
    let requests = 0;
    let context = {
        console,
        Date,
        setTimeout,
        clearTimeout,
        AbortController,
        navigator: { onLine: true, vibrate: null, wakeLock: undefined },
        document: {
            visibilityState: 'visible',
            body: { appendChild() {} },
            getElementById() { return null; },
            addEventListener(name, handler) { documentListeners[name] = handler; }
        },
        window: {
            AbortController,
            MutationObserver: null,
            matchMedia() { return { matches: false }; },
            addEventListener(name, handler) { windowListeners[name] = handler; }
        },
        localStorage: { getItem() { return null; } },
        createDiv() { return { classList: { add() {}, remove() {} }, textContent: '' }; },
        translate(text) { return text; },
        genericServerError() {},
        fetch: async () => { requests++; return new Response('{}'); },
        Response,
    };
    context.window.navigator = context.navigator;
    vm.createContext(context);
    vm.runInContext(`${source}\nglobalThis.__mobileNetwork = mobileNetwork;`, context, { filename: 'mobile_network.js' });
    return {
        network: context.__mobileNetwork,
        requests: () => requests,
        hasVisibilityHandler: () => typeof documentListeners.visibilitychange == 'function',
        visible() { context.document.visibilityState = 'visible'; documentListeners.visibilitychange(); },
        pageShow() { windowListeners.pageshow(); },
        offline() { context.navigator.onLine = false; },
        online() { context.navigator.onLine = true; }
    };
}

{
    let fixture = makeNetwork();
    fixture.visible();
    check('idle visible resume registers a foreground recovery hook before a transport failure', fixture.hasVisibilityHandler());
}

{
    let fixture = makeNetwork();
    fixture.pageShow();
    fixture.visible();
    await new Promise(resolve => setTimeout(resolve, 10));
    check('pageshow and visibilitychange share the in-flight probe', fixture.requests() == 1, `${fixture.requests()} probes`);
}

{
    let fixture = makeNetwork();
    fixture.offline();
    fixture.pageShow();
    fixture.visible();
    await new Promise(resolve => setTimeout(resolve, 10));
    check('offline resume does not create network probes', fixture.requests() == 0, `${fixture.requests()} probes`);
}

if (results.some(pass => !pass)) {
    process.exitCode = 1;
}
