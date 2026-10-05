import fs from 'node:fs';
import vm from 'node:vm';

// Regression coverage for live free-model discovery. The real helper is run in
// an isolated browser-like context; tests don't need a Puter account/network.
const source = fs.readFileSync(new URL('../src/js/free-models.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(source, { window, Number, Object, String, Date, Array, Set, RegExp });
const discovery = window.FreeModelDiscovery;
if (!discovery) throw new Error('FreeModelDiscovery did not attach to window');

let failures = 0;
function check(name, condition) {
    if (condition) console.log('ok   - ' + name);
    else { console.error('FAIL - ' + name); failures++; }
}

const deepseek = {
    id: 'infron:deepseek/deepseek-v4-flash:free',
    name: 'DeepSeek V4 Flash (Free)',
    provider: 'infron',
    tool_call: true,
    modalities: { input: ['text'] },
    costs: { tokens: 1000000, prompt: 0, completion: 0, request: 0 },
};
const qwen = {
    id: 'alibaba:qwen/qwen3.8-27b:free',
    name: 'Qwen 3.8 27B',
    tool_call: true,
    modalities: { input: ['text', 'image'] },
    cost: { input: 0, output: 0 },
};
const gemma = {
    id: 'openrouter:google/gemma-4-31b-it:free',
    name: 'Gemma 4 31B',
    tool_call: true,
    modalities: { input: ['text'] },
    costs: { prompt_tokens: 0, completion_tokens: 0 },
};

check('recognizes a provider-qualified :free variant', discovery.isFreeModel(deepseek));
check('recognizes a free marker in the model name', discovery.isFreeModel({ id: 'vendor/model', name: 'Model (Free)' }));
check('recognizes the explicit OpenRouter free router', discovery.isFreeModel({ id: 'openrouter/free', name: 'Free model router' }));
check('recognizes zero input/output costs', discovery.isFreeModel({ id: 'vendor/model', cost: { input: 0, output: 0 } }));
check('recognizes zero prompt/completion token costs', discovery.isFreeModel({ id: 'vendor/model', costs: { prompt_tokens: 0, completion_tokens: 0 } }));
check('rejects a paid model even if its name says free', !discovery.isFreeModel({ id: 'vendor/model', name: 'Free tier', cost: { input: 0, output: 1 } }));
check('rejects a :free ID when pricing contradicts it', !discovery.isFreeModel({ id: 'vendor/model:free', costs: { prompt: 0, completion: 2 } }));
check('rejects paid :flex variants', !discovery.isFreeModel({ id: 'vendor/model:flex', costs: { prompt: 1, completion: 2 } }));
check('does not assume an unpriced model is free', !discovery.isFreeModel({ id: 'vendor/open-weights-model', open_weights: true }));
check('filters models that explicitly cannot call tools', !discovery.isUsableChatModel({ ...deepseek, tool_call: false }));
check('filters models with no text input capability', !discovery.isUsableChatModel({ ...deepseek, modalities: { input: ['image'] } }));
check('filters models that explicitly cannot stream', !discovery.isUsableChatModel({ ...deepseek, streaming: false }));
check('allows a free text model when tool metadata is absent', discovery.isUsableChatModel({ id: 'vendor/text:free', modalities: { input: ['text'] } }));

const catalog = [
    { ...deepseek, id: 'infron:deepseek/deepseek-v4-flash:free', context: 1000000, release_date: '2026-07-31' },
    { ...deepseek, id: 'infron:deepseek/deepseek-v4.1-flash:free', context: 1000000, release_date: '2026-09-13' },
    qwen,
    gemma,
    { id: 'vendor/paid-model', name: 'Paid model', tool_call: true, costs: { prompt: 1, completion: 1 } },
    { ...deepseek, id: 'vendor/no-tools:free', tool_call: false },
];
const found = discovery.findFreeModels({ models: catalog });
check('accepts the listModels { models: [...] } response shape', found.length === 1);
check('excludes paid and unsupported models from discovery', found.every(model => model.id !== 'vendor/paid-model' && model.id !== 'vendor/no-tools:free'));
check('sorts explicit tool-capable options ahead of unknown capabilities', found[0].tool_call === true);
check('deduplicates repeated model IDs case-insensitively', discovery.findFreeModels([gemma, { ...gemma, id: gemma.id.toUpperCase() }]).length === 1);

const primaryCatalog = [
    gemma,
    { id: 'meta:llama/llama-4-8b:free', name: 'Llama 4 8B', tool_call: true, modalities: { input: ['text'] }, cost: { input: 0, output: 0 } },
    { id: 'mistral:mistral-small:free', name: 'Mistral Small', tool_call: true, modalities: { input: ['text'] }, cost: { input: 0, output: 0 } },
    { id: 'google:gemma/another:free', name: 'Gemma Another', tool_call: true, modalities: { input: ['text'] }, cost: { input: 0, output: 0 } },
];
const primary = discovery.selectPrimary(primaryCatalog, 3);
check('exposes up to three primary choices', primary.length === 3);
check('prefers different model families for the three primary choices', new Set(primary.map(model => model.id.split('/')[0].split(':').pop())).size === 3);
const tenChoiceCatalog = Array.from({ length: 10 }, (_, i) => ({ ...primaryCatalog[i % primaryCatalog.length], id: primaryCatalog[i % primaryCatalog.length].id + '-choice-' + i }));
check('supports up to ten selectable choices', discovery.selectPrimary(tenChoiceCatalog, 10).length === 10);
check('fills available slots when fewer than three free model families exist', discovery.selectPrimary([deepseek, { ...deepseek, id: 'infron:deepseek/another-free-variant:free' }], 3).length === 2);
check('returns no models when the live catalog contains no free options', discovery.findFreeModels([{ id: 'vendor/paid', costs: { prompt: 1, completion: 1 } }]).length === 0);

const app = fs.readFileSync(new URL('../src/js/app.js', import.meta.url), 'utf8');
const tools = fs.readFileSync(new URL('../src/js/tools.js', import.meta.url), 'utf8');
check('app discovers models from Puter live catalog', /puter\.ai\.listModels\(\)/.test(app));
check('main build request uses the selected discovered model', /model:\s*attemptModel/.test(app));
check('tool handoffs use the selected discovered model', /model:\s*MODEL/.test(tools));
check('auto-fallback selects only from discovered primary free models', /selectNextFreeModel\(attemptedFreeModelIds\)/.test(app));
const selectedModelRefs = [...app.matchAll(/model:\s*([A-Za-z_$][\w$]*)/g)].map(match => match[1]).filter(model => model !== '$');
check('every AI request uses a live selected model reference', selectedModelRefs.length === 5 && selectedModelRefs.every(model =>
    ['attemptModel', 'MODEL', 'suggestionModel', 'nameModel', 'labelModel'].includes(model)));
check('no hard-coded paid or stale model ID remains in app chat calls', !/qwen\/qwen3\.8-flash|FALLBACK_QWEN_MODELS|QWEN_MODELS/.test(app));

if (failures) {
    console.error(`\n${failures} free-model check(s) failed`);
    process.exit(1);
}
console.log('\nAll free-model discovery checks passed');
