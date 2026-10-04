import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = fs.readFileSync(path.join(ROOT, 'src/js/ui.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'src/js/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src/css/styles.css'), 'utf8');
let passed = 0;
let failed = 0;
function check(description, condition) {
    if (condition) {
        console.log(`ok   - ${description}`);
        passed++;
    } else {
        console.error(`FAIL - ${description}`);
        failed++;
    }
}

// Evaluate the app-authored starter data, then run the actual renderer against a
// tiny DOM stand-in so prompt safety and card contents are covered without a
// browser or network dependency.
const promptsStart = UI.indexOf('const STARTER_PROMPTS = [');
const promptsEnd = UI.indexOf('\n];', promptsStart);
const renderStart = UI.indexOf('function renderStarterPrompts() {');
const renderEnd = UI.indexOf('\nwindow.renderStarterPrompts', renderStart);
if ([promptsStart, promptsEnd, renderStart, renderEnd].some(index => index < 0)) {
    throw new Error('could not find studio starter data or renderer');
}
const arrayStart = UI.indexOf('[', promptsStart);
const starterPrompts = new Function(`return ${UI.slice(arrayStart, promptsEnd + 3)};`)();
const renderSource = UI.slice(renderStart, renderEnd);

class FakeElement {
    constructor(markup = '') {
        this.markup = markup;
        this.classes = new Set();
        this.attributes = {};
        this.children = [];
        this.textContent = '';
        this.length = 1;
    }
    empty() { this.children = []; return this; }
    addClass(name) { this.classes.add(name); return this; }
    attr(name, value) { this.attributes[name] = value; return this; }
    text(value) { this.textContent = value; return this; }
    append(...children) { this.children.push(...children.flat()); return this; }
}
const row = new FakeElement('starter-row');
const $ = value => value === '.chat-starter-prompts' ? row : new FakeElement(value);
const render = new Function('$', 'STARTER_PROMPTS', `${renderSource}; return renderStarterPrompts;`)($, starterPrompts);
render();

check('the studio offers six complete starter briefs', starterPrompts.length === 6);
check('each starter has a distinct label, description, icon, tone, and useful prompt',
    starterPrompts.every(item => item.label && item.description && item.icon
        && /^[a-z]+$/.test(item.tone) && item.prompt.length >= 180));
check('starter labels are unique', new Set(starterPrompts.map(item => item.label)).size === starterPrompts.length);
check('the renderer creates one accessible, editable button per starter',
    row.children.length === starterPrompts.length
    && row.children.every(card => card.markup.includes('type="button"')
        && card.markup.includes('home-template-card')
        && card.attributes['data-prompt']));
check('starter card text is added as text, not interpolated HTML',
    renderSource.includes('.text(starter.icon)')
    && renderSource.includes('.text(starter.label)')
    && renderSource.includes('.text(starter.description)')
    && !renderSource.includes('.html('));
check('clicking a starter still prefills for review instead of auto-sending',
    /\.on\('click', '\.chat-starter-chip',[\s\S]*?applyChipPromptToComposer\(prompt\)[\s\S]*?\}\);/.test(UI)
    && !/\.on\('click', '\.chat-starter-chip',[\s\S]*?sendChatMessage\(/.test(UI));

// Capture the real brief-builder event callback and drive both its valid and
// invalid input paths with small form/selection stand-ins.
const briefStart = UI.indexOf("$(document).on('click', '.home-brief-apply'");
const briefEnd = UI.indexOf("$(document).on('click', '.upgrade-button'", briefStart);
if (briefStart < 0 || briefEnd < 0) throw new Error('could not find the local brief-builder handler');
const briefSource = UI.slice(briefStart, briefEnd);
const registeredHandlers = {};
const mockDocument = {};
const mockButton = {};
let currentDetails;
const mock$ = target => {
    if (target === mockDocument) {
        return { on: (eventName, selector, callback) => { registeredHandlers[selector] = callback; } };
    }
    if (target === mockButton) return { closest: () => currentDetails };
    throw new Error('unexpected brief-builder selection');
};
let appliedBrief = '';
new Function('document', '$', 'applyChipPromptToComposer', briefSource)(
    mockDocument,
    mock$,
    value => { appliedBrief = value; },
);
const fields = {
    idea: {
        value: 'A booking app for tutors',
        reportValidity() { return !!this.value.trim(); },
        setCustomValidity(message) { this.customError = message; },
        focus() { this.focused = true; },
    },
    audience: { value: 'Independent tutors' },
    actions: { value: 'publish availability, accept bookings, and track sessions' },
    style: { value: 'Warm and editorial, with expressive typography' },
};
const form = { querySelector: selector => fields[selector.match(/name="([^"]+)"/)[1]] };
let detailsOpen = true;
currentDetails = {
    find: selector => selector === '.home-brief-form' ? [form] : [],
    prop: (name, value) => { if (name === 'open') detailsOpen = value; },
};
registeredHandlers['.home-brief-apply'].call(mockButton);
check('the brief helper composes purpose, audience, actions, style, and quality guidance',
    appliedBrief.includes('Build this product: A booking app for tutors.')
    && appliedBrief.includes('Intended audience: Independent tutors.')
    && appliedBrief.includes('publish availability, accept bookings, and track sessions')
    && appliedBrief.includes('Visual direction: Warm and editorial')
    && appliedBrief.includes('rather than a static mockup'));
check('the generated brief remains editable and the helper closes afterward',
    detailsOpen === false && briefSource.includes('applyChipPromptToComposer(brief)'));
fields.idea.value = '   ';
const beforeInvalid = appliedBrief;
registeredHandlers['.home-brief-apply'].call(mockButton);
check('an empty idea is rejected without replacing the composer text', appliedBrief === beforeInvalid);
check('brief helper never sends the request on the user’s behalf', !briefSource.includes('sendChatMessage('));

check('the new studio landing includes an accessible composer and blueprint section',
    UI.includes('aria-label="Describe the app or website you want to build"')
    && UI.includes('aria-label="Starter app blueprints"')
    && UI.includes('Pick a direction. Make it yours.'));
check('studio cards adapt to tablet and phone widths',
    /@media \(max-width: 760px\)[\s\S]*?\.chat-starter-prompts \{ grid-template-columns: repeat\(2/.test(CSS)
    && /@media \(max-width: 520px\)[\s\S]*?\.chat-starter-prompts \{ grid-template-columns: 1fr/.test(CSS));
check('studio-only UI is hidden when a conversation or project-loading screen is active',
    CSS.includes('.chat.active .home-brief-details')
    && CSS.includes('body.project-loading .home-brief-details'));
check('reduced-motion preference is respected by studio cards and controls',
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.home-brief-apply \{ transition: none; \}/.test(CSS));
check('new project composer restores the studio-specific placeholder',
    APP.includes('What should we build together? Describe the idea, audience, or outcome…'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
