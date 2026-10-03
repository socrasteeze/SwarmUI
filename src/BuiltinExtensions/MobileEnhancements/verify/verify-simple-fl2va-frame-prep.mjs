/**
 * Light offline checks for m_frame_prep.js scaling math + preset detection (no DOM / canvas / Playwright).
 * Run from repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-fl2va-frame-prep.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import vm from 'vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../Assets/m/m_frame_prep.js'), 'utf8');

const sandbox = {
    mState: { activePresets: [], presets: [], initImage: null, videoEndImage: null },
    getImageOutPrefix: () => '/View',
    console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src + '\nglobalThis.MFramePrep = MFramePrep;\nglobalThis.mFramePrep = mFramePrep;\n', sandbox);

const MFramePrep = sandbox.MFramePrep;
const mFramePrep = sandbox.mFramePrep;
const mState = sandbox.mState;

let failed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('FAIL', msg); failed++; }
    else { console.log('ok', msg); }
}

assert(typeof MFramePrep === 'function', 'MFramePrep class exists');
assert(typeof mFramePrep === 'object', 'mFramePrep singleton exists');

function dims(w, h) { return JSON.stringify(MFramePrep.targetDims(w, h)); }
assert(dims(1920, 1080) === JSON.stringify([1376, 768]), '1920x1080 -> 1376x768 got ' + dims(1920, 1080));
assert(dims(1080, 1920) === JSON.stringify([768, 1376]), '1080x1920 -> 768x1376 got ' + dims(1080, 1920));
assert(dims(1024, 1024) === JSON.stringify([768, 768]), '1024x1024 -> 768x768 got ' + dims(1024, 1024));
assert(dims(768, 768) === JSON.stringify([768, 768]), 'already 768 square stays');
assert(dims(800, 600) === JSON.stringify([1024, 768]), '800x600 -> 1024x768 got ' + dims(800, 600));
assert(dims(1000, 700) === JSON.stringify([1088, 768]), '1000x700 rounds nearest without padding -> 1088x768 got ' + dims(1000, 700));
assert(dims(700, 1000) === JSON.stringify([768, 1088]), '700x1000 rounds nearest without padding -> 768x1088 got ' + dims(700, 1000));

mState.activePresets = ['minimax/FL2VA_360_Orbit_Eros'];
assert(mFramePrep.isSameFramePreset() === true, 'known Orbit_Eros title matches');
assert(mFramePrep.sameAsStartEnabled() === true, 'default Same-as-start ON for Orbit_Eros');

mState.activePresets = ['flux/something'];
assert(mFramePrep.isSameFramePreset() === false, 'unrelated preset does not match');

mState.activePresets = ['minimax/FL2VA_Something_Orbit'];
assert(mFramePrep.isSameFramePreset() === true, 'FL2VA+orbit title heuristic matches');

mState.activePresets = ['minimax/FL2VA_360_Orbit_Eros'];
mState.initImage = { kind: 'path', value: 'raw/a.png' };
mState.videoEndImage = null;
assert(mFramePrep.mirrorStartToEnd() === true, 'mirror copies start to empty end');
assert(mState.videoEndImage && mState.videoEndImage.value === 'raw/a.png', 'end value matches start');
assert(mState.videoEndImage !== mState.initImage, 'end is a clone, not same object');
assert(mFramePrep.mirrorStartToEnd() === false, 'second mirror is a no-op');


const refs = { '1:1': [512, 512], '16:9': [672, 384], '4:3': [576, 448] };
assert(MFramePrep.sideLengthForClosest('1:1', 1024, 1024, refs, {}) === 1024, 'square 1024 stays 1024, not forced up');
assert(MFramePrep.sideLengthForClosest('1:1', 768, 768, refs, {}) === 768, 'square 768 is allowed, not bumped to 1024');
assert(MFramePrep.sideLengthForClosest('1:1', 400, 300, refs, {}) === 768, 'below 768 floors at 768');
assert(MFramePrep.sideLengthForClosest('16:9', 1344, 768, refs, {}) === 1024, '16:9 at short 768 uses side 1024 got ' + MFramePrep.sideLengthForClosest('16:9', 1344, 768, refs, {}));
assert(MFramePrep.sideLengthForClosest('4:3', 1024, 768, refs, {}) === 896, '4:3 short 768 aligns up to *32 without dropping under 768 got ' + MFramePrep.sideLengthForClosest('4:3', 1024, 768, refs, {}));

mState.params = {};
mState.presets = [];
mState.activePresets = ['krea/portrait'];
mState.presets = [{ title: 'krea/portrait', description: 'krea edit', param_map: { model: 'krea/foo' } }];
assert(MFramePrep.isLowResAspectContext() === false, 'krea does not get the 768 floor');

mState.activePresets = ['qwen/edit'];
mState.presets = [{ title: 'qwen/edit', description: 'qwen', param_map: { model: 'qwen/image' } }];
assert(MFramePrep.isLowResAspectContext() === false, 'qwen does not get the 768 floor');

mState.params = { videomodel: 'minimax/10Eros_Max_h3_TURBO-hybrid_beta5' };
mState.activePresets = [];
mState.presets = [];
assert(MFramePrep.isLowResAspectContext() === true, 'hybrid H3 video model gets the 768 floor');

mState.params = {};
mState.activePresets = ['minimax/FL2VA'];
mState.presets = [{ title: 'minimax/FL2VA', description: '', param_map: {} }];
assert(MFramePrep.isLowResAspectContext() === true, 'FL2VA preset gets the 768 floor');

mState.params = {};
mState.activePresets = ['minimax/something'];
mState.presets = [{ title: 'minimax/something', description: 'plain t2v', param_map: { videomodel: 'minimax/base' } }];
assert(MFramePrep.isLowResAspectContext() === false, 'plain minimax without hybrid or FL2VA keeps 1024');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('ALL PASSED');