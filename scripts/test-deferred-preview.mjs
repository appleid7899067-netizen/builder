import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The chat remains the active work surface while an app is being changed or
// verified. Exercise the real UI helpers and guard the turn-token wiring that
// prevents a stale tool from exposing another project's preview.
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const UI = read('../src/js/ui.js');
const APP = read('../src/js/app.js');
const CSS = read('../src/css/styles.css');
const PUBLISH = read('../src/tools/apps_and_sites/publish_site.js');
const UPDATE = read('../src/tools/apps_and_sites/update_preview.js');
const PROMPT = read('../src/js/prompt.js');

function takeBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0 || end <= start) {
        throw new Error(`Could not extract source between ${startMarker} and ${endMarker}`);
    }
    return source.slice(start, end);
}

function makePreviewEnv({ active = false } = {}) {
    const classes = new Set(active ? ['preview-active'] : []);
    const toggleAttrs = {};
    const state = { refreshes: 0, syncs: 0 };
    const body = {
        addClass(names) { String(names).split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); return this; },
        removeClass(names) { String(names).split(/\s+/).filter(Boolean).forEach(name => classes.delete(name)); return this; },
        hasClass(name) { return classes.has(name); },
    };
    const toggle = { attr(attrs) { Object.assign(toggleAttrs, attrs); return this; } };
    const pane = { length: 1 };
    const $ = selector => {
        if (selector === 'body') return body;
        if (selector === '.preview-toggle-chat') return toggle;
        if (selector === '.preview-pane') return pane;
        return { length: 0, attr() { return this; }, addClass() { return this; }, removeClass() { return this; } };
    };
    const window = {
        currentPreviewUrl: null,
        syncViewSeg() { state.syncs++; },
        updateVersionNavButtons() {},
        updateIssuesBadge() {},
        refreshPublishButton() {},
    };

    const lifecycle = takeBetween(
        UI,
        'let deferredPreviewTurn = null;',
        '/**\n * Mark the preview as needing a refresh because files changed.'
    );
    const schedulerStart = UI.indexOf('window.schedulePreviewRefresh = function(state) {');
    const schedulerEnd = UI.indexOf('\n};', schedulerStart);
    if (schedulerStart < 0 || schedulerEnd < 0) throw new Error('Could not extract schedulePreviewRefresh');
    const scheduler = UI.slice(schedulerStart, schedulerEnd + 3);
    const showStart = UI.indexOf('window.showAppPreview = function(url, opts) {');
    const showEnd = UI.indexOf('\n};\n\n/** Hide the preview pane', showStart);
    if (showStart < 0 || showEnd < 0) throw new Error('Could not extract showAppPreview');
    const show = UI.slice(showStart, showEnd + 3);

    const run = new Function(
        '$', 'window', 'refreshPreviewWhenReady', 'reloadPreviewFrame',
        lifecycle + '\nlet previewRefreshPending = false;\n' + scheduler + '\n' + show + '\n' +
        'return { isPending: () => previewRefreshPending };'
    );
    const refreshPreviewWhenReady = () => { state.refreshes++; };
    const env = run($, window, refreshPreviewWhenReady, () => {});
    return { $, window, body, classes, toggleAttrs, state, ...env };
}

// Fresh preview: host it in the background, keep mobile in chat, then reveal
// only when the same turn has reached its final UI teardown.
{
    const h = makePreviewEnv();
    h.window.beginPreviewTurn('chat-a', 7);
    h.window.showAppPreview('https://preview-a.puter.site/', {
        waitForReady: true,
        deferUntilTurnComplete: true,
        chatId: 'chat-a',
        turnSeq: 7,
    });
    assert.equal(h.window.currentPreviewUrl, 'https://preview-a.puter.site/');
    assert.ok(h.classes.has('preview-active'));
    assert.ok(h.classes.has('preview-deferred'), 'pane is deferred');
    assert.ok(h.classes.has('mobile-view-chat'), 'chat stays selected on mobile');
    assert.equal(h.state.refreshes, 1, 'hidden preview still loads for verification');
    assert.equal(h.window.finishPreviewTurn('other-chat', 7), false, 'wrong chat cannot reveal it');
    assert.ok(h.classes.has('preview-deferred'));
    assert.equal(h.window.finishPreviewTurn('chat-a', 6), false, 'wrong turn cannot reveal it');
    assert.equal(h.window.finishPreviewTurn('chat-a', 7), true);
    assert.ok(!h.classes.has('preview-deferred'));
    assert.ok(!h.classes.has('mobile-view-chat'), 'completed build opens the preview');
    assert.ok(h.classes.has('preview-active'));
    assert.equal(h.toggleAttrs['aria-expanded'], 'true');
}

// A file edit in a project with an existing preview also keeps the conversation
// in front; a write from an older turn cannot change the active turn's layout.
{
    const h = makePreviewEnv({ active: true });
    h.window.beginPreviewTurn('chat-a', 8);
    h.window.schedulePreviewRefresh({ currentChatId: 'chat-a', turnSeq: 8 });
    assert.equal(h.isPending(), true);
    assert.ok(h.classes.has('preview-deferred'));
    assert.ok(h.classes.has('mobile-view-chat'));
    h.window.beginPreviewTurn('chat-b', 9);
    h.window.cancelPreviewTurn('chat-a', 8);
    assert.ok(h.classes.has('preview-deferred'), 'stale cleanup cannot cancel the newer turn');
    assert.equal(h.window.finishPreviewTurn('chat-a', 8), false);
    assert.ok(h.classes.has('preview-deferred'));
    assert.equal(h.window.finishPreviewTurn('chat-b', 9), true);
}

// Reopening a saved project outside a build preserves the normal immediate
// preview behavior and clears any leftover deferred/mobile-chat state.
{
    const h = makePreviewEnv();
    h.window.beginPreviewTurn('chat-a', 10);
    h.window.deferPreviewForTurn('chat-a', 10);
    h.window.showAppPreview('https://saved.puter.site/', { waitForReady: true });
    assert.ok(h.classes.has('preview-active'));
    assert.ok(!h.classes.has('preview-deferred'));
    assert.ok(!h.classes.has('mobile-view-chat'));
}

// The actual pane stays mounted and sized while hidden so its iframe can load
// and update_preview can verify it without covering the streaming chat.
assert.match(CSS, /body\.preview-active\.preview-deferred \.preview-pane\s*\{[^}]*visibility:\s*hidden\s*!important;[^}]*pointer-events:\s*none\s*!important;/s);
assert.match(CSS, /body\.preview-active\.preview-deferred \.chat\s*\{[^}]*max-width:\s*680px/s);
assert.match(CSS, /body\.preview-active\.preview-deferred \.view-seg\s*\{[^}]*display:\s*none\s*!important;/s);

// Build-turn ownership is threaded through publish and file-refresh paths, and
// preview reveal happens only after the turn reset/final response work.
assert.match(APP, /window\.beginPreviewTurn\?\.\(turnChatId, turnSeq\)/);
assert.match(APP, /turnSeq, deferPreviewUntilTurnComplete: true, interrupted: true/);
const resetAt = APP.indexOf('resetUIState(turnChatId);', APP.indexOf('const supersededInChat ='));
const finishAt = APP.indexOf('window.finishPreviewTurn?.(turnChatId, turnSeq)', resetAt);
assert.ok(resetAt >= 0 && finishAt > resetAt, 'preview is revealed after the final UI reset and history save');
assert.match(PUBLISH, /deferUntilTurnComplete: state\?\.deferPreviewUntilTurnComplete === true/);
assert.match(PUBLISH, /chatId: state\?\.currentChatId/);
assert.match(UPDATE, /window\.verifyPreview\(state\)/);
for (const file of [
    '../src/tools/fs/write.js', '../src/tools/fs/edit.js', '../src/tools/fs/multi_edit.js',
    '../src/tools/fs/delete.js', '../src/tools/fs/copy.js', '../src/tools/fs/move.js',
    '../src/tools/fs/rename.js',
]) {
    assert.match(read(file), /schedulePreviewRefresh\?\.\(state\)/, `${file} passes its originating turn`);
}
assert.match(PROMPT, /do not call publish_site until every requested file change is finished and the checklist is complete/);
assert.match(PROMPT, /raw tool logs/);

console.log('All deferred-preview checks passed');
