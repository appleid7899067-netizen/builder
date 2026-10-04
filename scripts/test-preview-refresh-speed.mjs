import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Regression guard for the end-of-build "Applying changes…" wait. A verified
// content match used to be followed by a hard-coded 10-second delay, and each
// changed file was probed / read serially. Exercise the real refresh functions
// with a fast, fresh CDN response and ensure reload commits immediately.

const UI = fs.readFileSync(new URL('../src/js/ui.js', import.meta.url), 'utf8');
function slice(from, to) {
    const a = UI.indexOf(from);
    const b = UI.indexOf(to, a);
    if (a < 0 || b <= a) throw new Error('could not extract ' + from);
    return UI.slice(a, b);
}

const setup = ({ expectedByPath, readFails = false } = {}) => {
    let frameUrl = null;
    let storedUrl = null;
    let loadHandler = null;
    const scheduled = new Map();
    let timerSeq = 0;
    let readsInFlight = 0;
    let maxConcurrentReads = 0;
    let probesInFlight = 0;
    let maxConcurrentProbes = 0;
    let hostingUpdates = 0;
    const realDelay = ms => new Promise(resolve => globalThis.setTimeout(resolve, ms));

    const frame = {
        length: 1,
        data(key, value) {
            if (value === undefined) return key === 'preview-url' ? storedUrl : undefined;
            if (key === 'preview-url') storedUrl = value;
            return frame;
        },
        one(event, callback) { if (event === 'load') loadHandler = callback; return frame; },
        attr(key, value) { if (key === 'src') frameUrl = value; return frame; },
    };
    const overlay = { length: 0, remove() { this.length = 0; } };
    const body = {
        length: 1,
        find() { return overlay; },
        append() { overlay.length = 1; return body; },
    };
    const $ = selector => {
        if (selector === '.preview-frame') return frame;
        if (selector === '.preview-body') return body;
        return { length: 0 };
    };

    const userWindow = {
        currentPreviewUrl: 'https://draft.puter.site/',
        currentPreviewPath: '/app',
        ensureAppManifest: async () => {},
        applyPreviewCacheBust: async () => {},
        refreshChatThumb: () => {},
        resetPreviewErrorDedup: () => {},
        _notifyPreviewReloadCommit: () => {},
    };
    const puter = {
        fs: {
            async read(path) {
                readsInFlight++;
                maxConcurrentReads = Math.max(maxConcurrentReads, readsInFlight);
                await realDelay(12);
                readsInFlight--;
                if (readFails) throw new Error('missing');
                const rel = path.slice('/app/'.length);
                return { text: async () => expectedByPath?.[rel] || '' };
            },
        },
        hosting: {
            async update() { hostingUpdates++; },
        },
    };
    const fetch = async url => {
        const parsed = new URL(url);
        if (parsed.pathname === '/') {
            return { headers: { get: () => 'no-store' }, text: async () => '' };
        }
        probesInFlight++;
        maxConcurrentProbes = Math.max(maxConcurrentProbes, probesInFlight);
        await realDelay(12);
        probesInFlight--;
        const rel = decodeURIComponent(parsed.pathname.slice(1));
        return {
            headers: { get: () => 'no-store' },
            text: async () => expectedByPath?.[rel] || '',
        };
    };
    const fakeSetTimeout = (callback, delay) => {
        const id = ++timerSeq;
        scheduled.set(id, { callback, delay });
        return id;
    };
    const fakeClearTimeout = id => scheduled.delete(id);

    const helpers =
        slice('// Monotonic counter identifying the latest preview operation', '// --- Project-loading skeleton') +
        slice('async function runPreviewRefresh($frame', '\nlet previewRefreshPending = false;') +
        slice('function previewSubdomain(url) {', '// ===========================================================================');
    const factory = new Function(
        '$', 'window', 'puter', 'fetch', 'setTimeout', 'clearTimeout', 'AbortSignal', 'Date', 'Math',
        helpers + '\nreturn { runPreviewRefresh, record: window.recordPreviewChange };'
    );
    const api = factory($, userWindow, puter, fetch, fakeSetTimeout, fakeClearTimeout, AbortSignal, Date, Math);
    return {
        api,
        frame,
        frameUrl: () => frameUrl,
        storedUrl: () => storedUrl,
        loadHandler: () => loadHandler,
        scheduled: () => Array.from(scheduled.values()),
        maxConcurrentReads: () => maxConcurrentReads,
        maxConcurrentProbes: () => maxConcurrentProbes,
        hostingUpdates: () => hostingUpdates,
    };
};

// Six changed text files should be checked together. Once every live response
// matches disk, the iframe reloads with a fresh cache-bust token immediately —
// there must be no artificial 10-second timer after the proof of freshness.
{
    const expectedByPath = { 'index.html': '<main>fresh</main>' };
    for (let i = 1; i <= 6; i++) expectedByPath[`script${i}.js`] = `const n = ${i};`;
    const h = setup({ expectedByPath });
    for (let i = 1; i <= 6; i++) h.api.record(`/app/script${i}.js`);

    const started = Date.now();
    await h.api.runPreviewRefresh(h.frame, 'https://draft.puter.site/', 'chat-one', 0);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 1000, `fresh content should reload promptly, took ${elapsed}ms`);
    assert.match(h.frameUrl(), /[?&]__pv=/, 'the iframe is reloaded with a cache-busting URL');
    assert.equal(h.storedUrl(), h.frameUrl(), 'the cached frame URL matches the committed navigation');
    assert.equal(h.hostingUpdates(), 1, 'the preview host is synced before probing');
    assert.ok(h.maxConcurrentReads() > 1, 'expected local files are read concurrently');
    assert.ok(h.maxConcurrentProbes() > 1, 'live files are probed concurrently');
    assert.ok(!h.scheduled().some(timer => timer.delay >= 9000),
        'a confirmed fresh deploy must not incur the old 10-second settling delay');
    console.log(`ok   - fresh preview commits promptly and probes files concurrently (${elapsed}ms)`);
}

// If there is nothing on disk to compare (or the host cannot be probed), do not
// sleep through a fixed delay that cannot verify readiness; still cache-bust and
// load the best available preview.
{
    const h = setup({ expectedByPath: {}, readFails: true });
    await h.api.runPreviewRefresh(h.frame, 'https://draft.puter.site/', 'chat-two', 0);
    assert.match(h.frameUrl(), /[?&]__pv=/);
    assert.ok(!h.scheduled().some(timer => timer.delay >= 9000));
    console.log('ok   - an unavailable readiness probe does not add a fake wait');
}

console.log('\nAll preview-refresh-speed checks passed.');
