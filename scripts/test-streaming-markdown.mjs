import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Regression guard for streamed assistant rendering. The UI paints once per
// frame and commits stable markdown blocks, but a full render at the end must
// still match the ordinary saved-message path exactly (including escaping,
// links, syntax highlighting, tables, HTML blocks and reference definitions).

const src = fs.readFileSync(new URL('../src/js/helpers.js', import.meta.url), 'utf8');
function slice(from, to) {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    if (a < 0 || b <= a) throw new Error('could not extract ' + from);
    return src.slice(a, b);
}

const sandbox = vm.createContext({ console, out: {} });
vm.runInContext('var window = this; var self = this;', sandbox);
vm.runInContext(fs.readFileSync(new URL('../src/vendor/marked.umd.min.js', import.meta.url), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(new URL('../src/vendor/highlight.min.js', import.meta.url), 'utf8'), sandbox);
vm.runInContext(slice('function htmlEscape(', 'function generateChatId('), sandbox);
vm.runInContext(slice('window.hasUnsafeUrlScheme = function', 'function prepareHistoryForAI('), sandbox);
vm.runInContext('marked.use(window.MARKED_OPTIONS);', sandbox);

function fullRender(text) {
    sandbox.out.source = text;
    vm.runInContext("out.html = marked.parse(escapeMarkdownSource(out.source)).replace(/<a href=/g, '<a target=\\\"_blank\\\" href=');", sandbox);
    return sandbox.out.html;
}
function renderInChunks(text, chunkSize, { checkEveryPrefix = true } = {}) {
    const renderer = vm.runInContext('createStreamingMarkdownRenderer()', sandbox);
    let source = '';
    let html = '';
    for (let i = 0; i < text.length; i += chunkSize) {
        source += text.slice(i, i + chunkSize);
        html = renderer.render(source);
        if (checkEveryPrefix) {
            assert.equal(html, fullRender(source), `streamed markdown diverged at ${source.length} chars`);
        }
    }
    html = renderer.render(source, true);
    assert.equal(html, fullRender(source), 'final flush matches a full saved-message render');
    return html;
}

// A mix of common model output. Chunks intentionally split fences, links and
// markdown delimiters so the renderer sees the same incomplete prefixes as a
// real token stream.
const sample = [
    'Here is the **finished app**. Visit https://example.test/docs for details.\n\n',
    '# Overview\nA heading can be followed directly by a paragraph.\n\n',
    '> A quote with `inline code`.\n> A second quoted line.\n\n',
    '- First item with **bold**\n- Second item\n\n',
    '```js\nconst value = "<safe>";\nconsole.log(value);\n```\n\n',
    '| Name | Status |\n| --- | --- |\n| Build | Ready |\n\n',
    '<div class="notice">\n  Safe escaped HTML block\n</div>\n\n',
    'The link above should open in a new tab, and fenced URLs stay code: `https://example.test`.',
].join('');
const html = renderInChunks(sample, 11);
assert.match(html, /target="_blank" href="https:\/\/example\.test\/docs"/);
assert.match(html, /class="code-language">js</);
assert.match(html, /<table>/);
assert.match(html, /&lt;div class=&quot;notice&quot;&gt;/, 'raw HTML remains escaped');
console.log('ok   - streamed markdown matches the full renderer across split block boundaries');

// A reference link can be completed by a definition that arrives later. The
// incremental preview may show its literal label until the definition arrives;
// the final full flush must resolve it exactly like a restored message.
{
    const reference = '[docs][builder]\n\nSee also https://example.test.\n\n[builder]: https://example.test/guide';
    const finalHtml = renderInChunks(reference, 5, { checkEveryPrefix: false });
    assert.match(finalHtml, /<a target="_blank" href="https:\/\/example\.test\/guide">docs<\/a>/);
    assert.equal(finalHtml, fullRender(reference));
    console.log('ok   - later reference definitions are resolved by the final flush');
}

// Reusing a renderer for different source is defensive, but must not retain the
// first bubble's committed HTML when the second source has another prefix.
{
    const renderer = vm.runInContext('createStreamingMarkdownRenderer()', sandbox);
    renderer.render('First paragraph.\n\n');
    const next = 'A different message with **bold**.';
    assert.equal(renderer.render(next, true), fullRender(next));
    console.log('ok   - a reused renderer cannot leak a prior message prefix');
}

// Count the amount of markdown sent through marked.parse, rather than timing a
// benchmark (which is noisy on shared runners). With many separated blocks the
// stream path should parse substantially less text than re-parsing every growing
// prefix, while still doing the one final correctness pass.
{
    const large = Array.from({ length: 18 }, (_, i) =>
        `## Section ${i}\n\nA short paragraph for section ${i}, with **bold text**.\n\n`
        + `\`\`\`js\nconst section${i} = { id: ${i}, ready: true };\n\`\`\`\n\n`
    ).join('') + 'Finished.';
    const chunks = [];
    for (let i = 0; i < large.length; i += 19) chunks.push(large.slice(i, i + 19));

    vm.runInContext(`
        out.originalParse = marked.parse;
        out.parsedChars = 0;
        marked.parse = function (source, ...args) {
            out.parsedChars += String(source).length;
            return out.originalParse.call(marked, source, ...args);
        };
    `, sandbox);

    const renderer = vm.runInContext('createStreamingMarkdownRenderer()', sandbox);
    let source = '';
    for (const chunk of chunks) {
        source += chunk;
        renderer.render(source);
    }
    const incrementalHtml = renderer.render(source, true);
    const incrementalChars = sandbox.out.parsedChars;

    sandbox.out.parsedChars = 0;
    let fullSource = '';
    for (const chunk of chunks) {
        fullSource += chunk;
        fullRender(fullSource);
    }
    const repeatedFullParseChars = sandbox.out.parsedChars;
    assert.equal(incrementalHtml, fullRender(large));
    assert.ok(incrementalChars < repeatedFullParseChars / 4,
        `incremental renderer parsed ${incrementalChars} chars vs ${repeatedFullParseChars} for full re-parsing`);

    vm.runInContext('marked.parse = out.originalParse;', sandbox);
    console.log(`ok   - stable blocks avoid repeated parsing (${incrementalChars} vs ${repeatedFullParseChars} source chars)`);
}

console.log('\nAll streaming-markdown checks passed.');
