import fs from 'node:fs';
import vm from 'node:vm';

let source = fs.readFileSync(new URL('../Assets/tagdex_library.js', import.meta.url), 'utf8');
source = source.substring(0, source.indexOf('tagDexLibrary =')) + '\nglobalThis.TagDexLibraryClass = TagDexLibraryClass;';
let applied = [];
let elements = {
    input_loras: { selectedOptions: [{ value: 'existing.safetensors' }] },
    input_loraweights: { value: '0.5' },
    input_prompt: { value: 'wide shot, forest' },
    input_negativeprompt: { value: 'blurry' }
};
let context = {
    console,
    document: { getElementById: id => elements[id] || null },
    gen_param_types: ['prompt', 'negativeprompt', 'model', 'loras', 'loraweights'].map(id => ({ id })),
    setDirectParamValue: (type, value) => {
        applied.push([type.id, value]);
        if (elements[`input_${type.id}`]) {
            elements[`input_${type.id}`].value = value;
        }
    },
    sessionReadyCallbacks: []
};
vm.createContext(context);
vm.runInContext(source, context);
let library = new context.TagDexLibraryClass();
let recipe = { prompt: 'character tags', negative_prompt: 'bad hands', checkpoint: 'model', loras: [] };

let threw = false;
try {
    library.applyRecipe(recipe, [{ logical_name: 'existing.safetensors', weight: 1, name: 'Conflict' }]);
}
catch (error) {
    threw = true;
}
if (!threw || applied.length != 0) {
    throw new Error('Weight conflict was not atomic.');
}

library.applyRecipe(recipe, [
    { logical_name: 'existing.safetensors', weight: 0.5, name: 'Existing' },
    { logical_name: 'new.safetensors', weight: 0.8, name: 'New' },
    { logical_name: 'new.safetensors', weight: 0.8, name: 'New duplicate' }
]);
let loras = applied.find(row => row[0] == 'loras')[1];
let weights = applied.find(row => row[0] == 'loraweights')[1];
if (JSON.stringify(loras) != JSON.stringify(['existing', 'new'])) {
    throw new Error(`LoRA deduplication failed: ${JSON.stringify(loras)}`);
}
if (JSON.stringify(weights) != JSON.stringify(['0.5', '0.8'])) {
    throw new Error(`Weight order failed: ${JSON.stringify(weights)}`);
}
let prompt = applied.findLast(row => row[0] == 'prompt')[1];
let negative = applied.findLast(row => row[0] == 'negativeprompt')[1];
if (prompt != 'wide shot, forest, character tags' || negative != 'blurry, bad hands') {
    throw new Error(`Prompt merge failed: ${prompt} / ${negative}`);
}
let beforeRepeat = applied.length;
library.applyRecipe(recipe, [
    { logical_name: 'existing.safetensors', weight: 0.5, name: 'Existing' },
    { logical_name: 'new.safetensors', weight: 0.8, name: 'New' }
]);
if (applied.findLast(row => row[0] == 'prompt')[1] != prompt
    || applied.findLast(row => row[0] == 'negativeprompt')[1] != negative
    || applied.length <= beforeRepeat) {
    throw new Error('Repeated recipe application was not prompt-idempotent.');
}

let offsets = [];
context.genericRequest = (route, input, success) => {
    offsets.push(input.offset);
    let count = input.offset == 0 ? 250 : 55;
    success({ results: Array.from({ length: count }, (_, i) => ({ id: input.offset + i })), total: 305 });
};
let allCharacters = await new Promise((resolve, reject) => library.loadAllCharacters('', resolve, reject));
if (allCharacters.results.length != 305 || JSON.stringify(offsets) != JSON.stringify([0, 250])) {
    throw new Error(`Character pagination failed: ${allCharacters.results.length} at ${JSON.stringify(offsets)}`);
}
console.log('TagDex library JS checks passed.');
