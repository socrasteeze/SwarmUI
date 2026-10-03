/**
 * Offline check: /simple aspect stepper applies to first-frame FL2VA / hybrid Eros gens.
 * Run from repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-first-frame-aspect.mjs
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import vm from "vm";

const here = dirname(fileURLToPath(import.meta.url));
const frameSrc = readFileSync(resolve(here, "../Assets/m/m_frame_prep.js"), "utf8");
const stateSrc = readFileSync(resolve(here, "../Assets/m/m_state.js"), "utf8");

const sandbox = {
    console,
    localStorage: { getItem() { return null; }, setItem() {} },
    mUI: { warn() {}, note() {} },
    roundTo(val, prec) { return Math.round(val / prec) * prec; },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(frameSrc + "\nglobalThis.MFramePrep = MFramePrep;\n", sandbox);
vm.runInContext(stateSrc, sandbox);

const mState = sandbox.mState;
const MFramePrep = sandbox.MFramePrep;

let failed = 0;
function assert(cond, msg) {
    if (!cond) { console.error("FAIL", msg); failed++; }
    else { console.log("ok", msg); }
}

const erosPreset = {
    title: "minimax/Eros euler 8",
    description: "",
    param_map: {
        videomodel: "minimax/10Eros_Max_h3_TURBO-hybrid_beta5_w4a8_14gb_optimized",
        videoresolution: "Model Preferred",
        aspectratio: "1:1",
        width: "960",
        height: "960",
    },
};
const fl2vaPreset = {
    title: "minimax/FL2VA",
    description: "",
    param_map: { videomodel: "minimax/FL2VA" },
};

function arm(preset, aspect, pinned, frame) {
    mState.params = { prompt: "a cat", aspectratio: aspect, sidelength: "1024", images: "1", seed: "-1" };
    mState.customRatio = 0;
    mState.aspectPinned = pinned;
    mState.activePresets = [preset.title];
    mState.presets = [preset];
    mState.initImage = frame ? { kind: "path", value: "raw/start.png" } : null;
    mState.videoEndImage = null;
    mState.promptImages = [];
    return mState.buildGenInput();
}

let input = arm(erosPreset, "2:3", true, true);
assert(input.videoresolution == "Image Aspect, Model Res", "pinned 2:3 first frame overrides Model Preferred, got " + input.videoresolution);
assert(input.aspectratio == "2:3", "pinned stepper beats preset 1:1, got " + input.aspectratio);
assert(input.sidelength == "1024", "side length kept, got " + input.sidelength);
assert(!("width" in input) && !("height" in input), "square preset width/height dropped, got " + input.width + "x" + input.height);
assert(MFramePrep.isLowResAspectContext() === true, "eros hybrid is a low-res aspect context");

input = arm(erosPreset, "2:3", false, true);
assert(input.aspectratio == "1:1", "unpinned stepper leaves preset 1:1 as the default, got " + input.aspectratio);
assert(input.videoresolution == "Image Aspect, Model Res", "first frame still uses image aspect even when the preset aspect is kept");

input = arm(erosPreset, "2:3", true, false);
assert(input.videoresolution == "Model Preferred", "no start frame keeps preset Model Preferred, got " + input.videoresolution);
assert(input.aspectratio == "1:1", "no frame: preset aspect is not replaced, got " + input.aspectratio);

input = arm(fl2vaPreset, "2:3", true, true);
assert(input.aspectratio == "2:3", "FL2VA first frame keeps the stepper aspect, got " + input.aspectratio);
assert(input.videoresolution == "Image Aspect, Model Res", "FL2VA first frame sets Image Aspect when the preset omitted it");

const imagePreset = {
    title: "krea/portrait",
    description: "",
    param_map: { model: "krea/foo", aspectratio: "1:1" },
};
input = arm(imagePreset, "2:3", true, true);
assert(!("videoresolution" in input), "non-video preset with a frame does not gain videoresolution, got " + input.videoresolution);
assert(input.aspectratio == "1:1", "pin does not override aspect outside FL2VA / hybrid, got " + input.aspectratio);

const imageRes = {
    title: "minimax/FL2VA",
    description: "",
    param_map: { videoresolution: "Image", aspectratio: "1:1" },
};
input = arm(imageRes, "9:16", true, true);
assert(input.videoresolution == "Image", "explicit Image video resolution is left alone, got " + input.videoresolution);
assert(input.aspectratio == "9:16", "pinned 9:16 still replaces the preset aspect");

if (failed) { console.error(failed + " failed"); process.exit(1); }
console.log("ALL PASSED");