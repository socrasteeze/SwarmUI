/** Client model-browser search: every word is a case-insensitive substring, in any order.
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-model-search.mjs
 */
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const utilSrc = readFileSync(`${repo}/src/wwwroot/js/genpage/helpers/browsers.js`, 'utf8');
const start = utilSrc.indexOf('function textMatchesSearch(');
if (start < 0) {
    throw new Error('textMatchesSearch not found');
}
let open = utilSrc.indexOf('{', start);
let depth = 0;
let end = -1;
for (let i = open; i < utilSrc.length; i++) {
    if (utilSrc[i] == '{') {
        depth++;
    }
    else if (utilSrc[i] == '}') {
        depth--;
        if (depth == 0) {
            end = i + 1;
            break;
        }
    }
}
let textMatchesSearch = new Function(`${utilSrc.slice(start, end)}; return textMatchesSearch;`)();

let hay = 'SomeFolder/word_word2.safetensors, Title: Style Pack, Trigger Phrase: pose';
assert.equal(textMatchesSearch(hay, 'word2'), true);
assert.equal(textMatchesSearch(hay, 'WORD2'), true);
assert.equal(textMatchesSearch(hay, 'word2 style'), true);
assert.equal(textMatchesSearch(hay, 'style word2'), true);
assert.equal(textMatchesSearch('foo_word2_bar.safetensors', 'word2'), true);
assert.equal(textMatchesSearch(hay, 'word2 missing'), false);
assert.equal(textMatchesSearch(hay, ''), true);
assert.equal(textMatchesSearch(hay, '   '), true);
assert.equal(textMatchesSearch('other.safetensors', 'word2'), false);

let browsers = readFileSync(`${repo}/src/wwwroot/js/genpage/helpers/browsers.js`, 'utf8');
assert.equal(browsers.includes('textMatchesSearch(desc.searchable, this.filter)'), true);
console.log('PASS  model browser search');
