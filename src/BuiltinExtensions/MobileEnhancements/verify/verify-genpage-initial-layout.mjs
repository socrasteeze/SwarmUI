/** Checks that Genpage's first parsed layout class matches its later layout decision. */
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import vm from 'vm';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SOURCE = readFileSync(`${REPO}/src/Pages/Text2Image.cshtml`, 'utf8');
const start = SOURCE.indexOf('    (() => {');
const end = SOURCE.indexOf('    })();', start) + '    })();'.length;
assert.ok(start >= 0 && end > start, 'initial layout script missing');
const SCRIPT = SOURCE.slice(start, end);

function check(width, stored, expected, coarse = false) {
    let classes = new Set();
    let context = {
        window: { innerWidth: width, matchMedia() { return { matches: coarse }; } },
        document: { body: { classList: { toggle(name, enabled) { if (enabled) { classes.add(name); } else { classes.delete(name); } } } } },
        localStorage: { getItem() { return stored; } }
    };
    vm.runInNewContext(SCRIPT, context);
    let actual = classes.has('small-window');
    assert.equal(actual, expected, `${width}px / ${stored || 'auto'}`);
    assert.equal(classes.has('large-window'), !expected, `large class ${width}px / ${stored || 'auto'}`);
    assert.equal(classes.has('coarse-pointer'), coarse, `pointer class ${width}px / ${stored || 'auto'}`);
    console.log(`PASS  ${width}px ${stored || 'auto'} -> ${expected ? 'small' : 'large'}`);
}

check(360, null, true);
check(767, 'auto', true);
check(768, 'auto', false);
check(1440, 'auto', false);
check(1440, 'mobile', true);
check(360, 'desktop', false);
check(360, 'auto', true, true);
