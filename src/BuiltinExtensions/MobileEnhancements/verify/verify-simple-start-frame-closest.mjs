/**
 * Offline check: setting a MiniMax hybrid / FL2VA / Eros start frame snaps aspect to that
 * frame's closest ratio, the same way "Use closest ratio" does. End frames do not.
 * Run from repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-start-frame-closest.mjs
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import vm from "vm";

const here = dirname(fileURLToPath(import.meta.url));
const frameSrc = readFileSync(resolve(here, "../Assets/m/m_frame_prep.js"), "utf8");
const stateSrc = readFileSync(resolve(here, "../Assets/m/m_state.js"), "utf8");
let createSrc = readFileSync(resolve(here, "../Assets/m/m_create.js"), "utf8");
createSrc = createSrc.replace(/\nmCreate = new MCreate\(\);\s*$/, "\n");

const sandbox = {
    console,
    localStorage: { getItem() { return null; }, setItem() {} },
    mUI: { warn() {}, note() {}, toast() {} },
    roundTo(val, prec) { return Math.round(val / prec) * prec; },
    requestAnimationFrame(fn) { sandbox._frames.push(fn); },
};
sandbox.globalThis = sandbox;
sandbox._frames = [];
vm.createContext(sandbox);
vm.runInContext(frameSrc + "\nglobalThis.MFramePrep = MFramePrep;\n", sandbox);
vm.runInContext(stateSrc, sandbox);
vm.runInContext(createSrc + "\nglobalThis.MCreate = MCreate;\n", sandbox);

const mState = sandbox.mState;
const MCreate = sandbox.MCreate;

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

function armEros() {
    mState.params = { prompt: "a cat", aspectratio: "1:1", sidelength: "1024", images: "1", seed: "-1" };
    mState.customRatio = 0;
    mState.aspectPinned = false;
    mState.activePresets = [erosPreset.title];
    mState.presets = [erosPreset];
    mState.promptImages = [];
    mState.videoEndImage = null;
    mState.initImage = null;
}

const create = Object.create(MCreate.prototype);
create.startFrameSeq = 1;
create.startAspectGen = 0;

const portrait = { kind: "data", value: "data:image/png;base64,xx", width: 900, height: 1200 };

armEros();
mState.initImage = portrait;
create.applyStartFrameAspect(portrait, 1, 0);
assert(mState.params.aspectratio == "3:4", "900x1200 start frame snaps to 3:4, got " + mState.params.aspectratio);
assert(mState.aspectPinned === true, "start frame pins the aspect");
assert(mState.params.sidelength == "1024", "short side 900 -> side length 1024, got " + mState.params.sidelength);

let input = mState.buildGenInput();
assert(input.aspectratio == "3:4", "pinned closest beats preset 1:1, got " + input.aspectratio);
assert(input.videoresolution == "Image Aspect, Model Res", "first frame still sends Image Aspect, Model Res, got " + input.videoresolution);
assert(!("width" in input) && !("height" in input), "square preset width/height dropped");

armEros();
mState.params.aspectratio = "1:1";
mState.aspectPinned = false;
create.applyClosestBox({ w: 900, h: 1200, ratio: 900 / 1200 });
assert(mState.params.aspectratio == "3:4" && mState.params.sidelength == "1024" && mState.aspectPinned === true,
    "closest button and start frame write the same ladder result");

armEros();
mState.initImage = portrait;
create.startFrameSeq = 1;
create.applyImageRatio(false);
assert(mState.params.aspectratio == "3:4" && mState.params.sidelength == "1024",
    "Use closest ratio on the start frame matches the auto apply, got " + mState.params.aspectratio + " / " + mState.params.sidelength);

armEros();
mState.initImage = portrait;
create.startFrameSeq = 4;
create.startAspectGen = 0;
create.noteAspectOverride();
create.applyStartFrameAspect(portrait, 4, 0);
assert(mState.params.aspectratio == "1:1" && mState.aspectPinned === false, "a stepper tap during load keeps the stepper ratio");

armEros();
mState.initImage = portrait;
create.startAspectGen = 0;
create.startFrameSeq = 9;
create.applyStartFrameAspect(portrait, 8, 0);
assert(mState.params.aspectratio == "1:1" && mState.aspectPinned === false, "a replaced start frame does not apply the old one");

armEros();
create.startFrameSeq = 3;
create.startAspectGen = 0;
mState.initImage = { kind: "data", value: "other", width: 900, height: 1200 };
create.applyStartFrameAspect(portrait, 3, 0);
assert(mState.aspectPinned === false, "aspect is not applied once Start no longer holds that entry");

armEros();
create.applyStartFrameAspect(null, 1, 0);
assert(mState.params.aspectratio == "1:1" && mState.aspectPinned === false, "clearing Start does not invent a ratio");

const krea = { title: "krea/portrait", description: "", param_map: { model: "krea/foo", aspectratio: "1:1" } };
mState.params = { prompt: "a cat", aspectratio: "1:1", sidelength: "1024" };
mState.aspectPinned = false;
mState.activePresets = [krea.title];
mState.presets = [krea];
mState.initImage = portrait;
create.startFrameSeq = 1;
create.startAspectGen = 0;
create.applyStartFrameAspect(portrait, 1, 0);
assert(mState.params.aspectratio == "1:1" && mState.aspectPinned === false, "non hybrid / FL2VA start frames do not take over aspect");

const src = readFileSync(resolve(here, "../Assets/m/m_create.js"), "utf8");
const startAt = src.indexOf("this.startFrameSlot = this.buildFrameSlot");
const endAt = src.indexOf("this.endFrameSlot = this.buildFrameSlot");
const rowAt = src.indexOf("row.appendChild(this.startFrameSlot)");
const startBody = src.slice(startAt, endAt);
const endBody = src.slice(endAt, rowAt);
assert(startBody.includes("this.applyStartFrameAspect(scaled, seq, aspectGen)"), "same-frame scale applies closest from the scaled start");
assert(startBody.includes("this.applyStartFrameAspect(entry, seq, aspectGen)"), "set/paste applies closest from the start entry");
assert(startBody.includes("mirrorStartToEnd()"), "same-as-start still mirrors");
assert(!endBody.includes("applyStartFrameAspect"), "end frame setter does not set aspect");
assert(endBody.includes("mirror") === false || !endBody.includes("applyStartFrameAspect"), "same-as-start end path does not fight");

if (failed) { console.error(failed + " failed"); process.exit(1); }
console.log("ALL PASSED");