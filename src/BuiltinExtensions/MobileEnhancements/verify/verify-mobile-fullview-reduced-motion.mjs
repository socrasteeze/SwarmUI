/** Reduced-motion checks for MobileFullViewTouch's automated settle paths. */
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import vm from 'vm';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SOURCE = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/mobile_fullview_touch.js`, 'utf8');

function extract(signature) {
    let start = SOURCE.indexOf(signature);
    assert.ok(start >= 0, `missing ${signature}`);
    let open = SOURCE.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < SOURCE.length; i++) {
        if (SOURCE[i] == '{') {
            depth++;
        }
        else if (SOURCE[i] == '}') {
            depth--;
            if (depth == 0) {
                return SOURCE.slice(start, i + 1).replaceAll(/^    /gm, '');
            }
        }
    }
    throw new Error(`unbalanced ${signature}`);
}

const reduceMotion = extract('    reduceMotion() {');
const animateInnerHome = extract('    animateInnerHome() {');
const animateNav = extract('    animateNav(next) {');
const context = {
    imageFullView: { content: { style: { opacity: '0.5' } } },
    shiftToNextImagePreview(next, shift, arrows) { context.calls.push([next, shift, arrows]); return true; },
    setTimeout() { context.timeouts++; },
    console,
    window: { matchMedia() { return { matches: true }; } },
    calls: [],
    timeouts: 0
};
vm.runInNewContext(`class TestTouch {\n${reduceMotion}\n${animateInnerHome}\n${animateNav}\n}\nthis.TestTouch = TestTouch;`, context);

let touch = new context.TestTouch();
let inner = { style: { transition: 'transform 0.18s ease-out', transform: 'translateX(20px)' } };
touch.currentInner = () => inner;
touch.clearInner = () => { touch.clears = (touch.clears || 0) + 1; inner.style.transition = ''; inner.style.transform = ''; };
touch.haptic = () => { touch.haptics = (touch.haptics || 0) + 1; };
touch.preloadAdjacent = () => { touch.preloads = (touch.preloads || 0) + 1; };
touch.animating = true;
touch.animateInnerHome();
assert.equal(touch.clears, 1, 'reduced motion must settle home synchronously');
assert.equal(context.timeouts, 0, 'reduced motion must not schedule home animation');
touch.animateNav(true);
assert.deepEqual(context.calls, [[true, true, true]], 'reduced motion must use the core navigation path once');
assert.equal(touch.haptics, 1, 'reduced motion retains completion feedback');
assert.equal(touch.preloads, 1, 'reduced motion retains adjacent preload');
assert.equal(touch.clears, 2, 'reduced motion clears the navigation transform synchronously');
assert.equal(touch.animating, false, 'reduced motion leaves no animation state');
assert.equal(context.timeouts, 0, 'reduced motion must not schedule navigation animation');
console.log('PASS  reduced-motion fullview settle and navigation keep feedback without travel');
