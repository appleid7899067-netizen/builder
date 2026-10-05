import assert from 'node:assert/strict';
import { readGitHubPullRequest, readGitHubRepo } from '../services/agent-reach-mcp/tools.mjs';

const checks = [];
async function test(name, fn) {
    await fn();
    checks.push(name);
    console.log(`✓ ${name}`);
}

function jsonResponse(value, { status = 200, headers = {} } = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '54', ...headers },
    });
}

const repoMetadata = {
    id: 123,
    full_name: 'octocat/Hello-World',
    html_url: 'https://github.com/octocat/Hello-World',
    description: 'A public test repository',
    default_branch: 'main',
    private: false,
    language: 'JavaScript',
    stargazers_count: 42,
    forks_count: 7,
    open_issues_count: 3,
    topics: ['example'],
    license: { spdx_id: 'MIT', name: 'MIT License' },
    updated_at: '2026-10-05T00:00:00Z',
};

await test('reads public repository metadata and decodes the README via GitHub API', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const parsed = new URL(url);
        calls.push({ url: parsed, init });
        if (parsed.pathname === '/repos/octocat/Hello-World') return jsonResponse(repoMetadata);
        if (parsed.pathname === '/repos/octocat/Hello-World/readme') {
            return jsonResponse({
                type: 'file', path: 'README.md', size: 13, encoding: 'base64',
                content: Buffer.from('# Hello World\n').toString('base64'),
            });
        }
        throw new Error(`Unexpected GitHub API route: ${parsed.pathname}`);
    };
    const result = await readGitHubRepo('octocat', 'Hello-World', { fetchImpl });
    assert.equal(result.backend, 'GitHub public REST API');
    assert.equal(result.scope.includes('Public repositories only'), true);
    assert.equal(result.repository.full_name, 'octocat/Hello-World');
    assert.equal(result.repository.visibility, 'public');
    assert.equal(result.repository.stars, 42);
    assert.equal(result.document.kind, 'file');
    assert.equal(result.document.path, 'README.md');
    assert.equal(result.document.content, '# Hello World\n');
    assert.equal(result.rate_limit_remaining, '54');
    assert.equal(calls.length, 2);
    for (const { url, init } of calls) {
        assert.equal(url.origin, 'https://api.github.com');
        assert.equal(init.method, 'GET');
        assert.equal(init.headers.Authorization, undefined);
        assert.equal(init.headers.Cookie, undefined);
        assert.equal(init.headers['User-Agent'], 'SANDBOX_RUNNER_CI/1.0');
        assert.equal(init.signal instanceof AbortSignal, true);
    }
});

await test('reads a selected directory at a requested ref and keeps API paths scoped', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const parsed = new URL(url);
        calls.push({ url: parsed, init });
        if (parsed.pathname === '/repos/octocat/Hello-World') return jsonResponse(repoMetadata);
        if (parsed.pathname === '/repos/octocat/Hello-World/contents/src') {
            assert.equal(parsed.searchParams.get('ref'), 'feature/docs');
            return jsonResponse([
                { name: 'index.js', path: 'src/index.js', type: 'file', size: 120, html_url: 'https://github.com/octocat/Hello-World/blob/main/src/index.js' },
                { name: 'components', path: 'src/components', type: 'dir', size: 0, html_url: 'https://github.com/octocat/Hello-World/tree/main/src/components' },
            ], { headers: { Link: '<https://api.github.com/repos/octocat/Hello-World/contents/src?page=2>; rel="next"' } });
        }
        throw new Error(`Unexpected GitHub API route: ${parsed.pathname}`);
    };
    const result = await readGitHubRepo('octocat', 'Hello-World', { path: 'src', ref: 'feature/docs', fetchImpl });
    assert.equal(result.document.kind, 'directory');
    assert.equal(result.document.entries.length, 2);
    assert.equal(result.document.entries[0].path, 'src/index.js');
    assert.equal(result.document.has_more_entries, true);
    assert.equal(calls.length, 2);
    assert.equal(calls.every(call => call.url.origin === 'https://api.github.com'), true);
});

await test('rejects path traversal and malformed repository coordinates before any request', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return jsonResponse(repoMetadata); };
    await assert.rejects(readGitHubRepo('octocat', 'Hello-World', { path: '../private', fetchImpl }), /dot, or parent/);
    await assert.rejects(readGitHubRepo('octocat/evil', 'Hello-World', { fetchImpl }), /owner or organization/);
    await assert.rejects(readGitHubRepo('octocat', 'Hello-World', { ref: 'main\nAuthorization: evil', fetchImpl }), /printable characters/);
    assert.equal(calls, 0);
});

await test('returns only directory metadata for binary files', async () => {
    const fetchImpl = async url => {
        const parsed = new URL(url);
        if (parsed.pathname === '/repos/octocat/Hello-World') return jsonResponse(repoMetadata);
        return jsonResponse({ type: 'file', path: 'assets/logo.bin', size: 3, encoding: 'base64', content: Buffer.from([0, 1, 2]).toString('base64') });
    };
    const result = await readGitHubRepo('octocat', 'Hello-World', { path: 'assets/logo.bin', fetchImpl });
    assert.equal(result.document.content, null);
    assert.match(result.document.note, /Binary/);
});

await test('reads a public PR, conversation/review comments, inline notes, and changed-file patches', async () => {
    const calls = [];
    const longPatch = `@@ -1 +1 @@\n${'x'.repeat(3_100)}`;
    const longComment = 'c'.repeat(3_100);
    const fetchImpl = async (url, init) => {
        const parsed = new URL(url);
        calls.push({ url: parsed, init });
        if (parsed.pathname === '/repos/acme/project/pulls/42') {
            return jsonResponse({
                number: 42,
                title: 'Improve docs',
                state: 'open',
                draft: false,
                merged_at: null,
                created_at: '2026-10-01T00:00:00Z',
                updated_at: '2026-10-05T00:00:00Z',
                closed_at: null,
                html_url: 'https://github.com/acme/project/pull/42',
                user: { login: 'contributor' },
                body: 'Please review this change.',
                base: { ref: 'main' },
                head: { ref: 'docs/update', sha: 'abcdef123456' },
                additions: 4,
                deletions: 1,
                changed_files: 1,
            });
        }
        if (parsed.pathname === '/repos/acme/project/issues/42/comments') {
            return jsonResponse([{ id: 7, user: { login: 'maintainer' }, created_at: '2026-10-02T00:00:00Z', html_url: 'https://github.com/acme/project/pull/42#issuecomment-7', body: 'Thanks for the PR.' }], {
                headers: { Link: '<https://api.github.com/repos/acme/project/issues/42/comments?page=2>; rel="next"' },
            });
        }
        if (parsed.pathname === '/repos/acme/project/pulls/42/reviews') {
            return jsonResponse([{ id: 8, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-10-03T00:00:00Z', html_url: 'https://github.com/acme/project/pull/42#pullrequestreview-8', body: 'Looks good.' }]);
        }
        if (parsed.pathname === '/repos/acme/project/pulls/42/comments') {
            return jsonResponse([{ id: 9, user: { login: 'reviewer' }, path: 'README.md', line: 4, created_at: '2026-10-03T00:00:00Z', html_url: 'https://github.com/acme/project/pull/42#discussion_r9', body: longComment }]);
        }
        if (parsed.pathname === '/repos/acme/project/pulls/42/files') {
            return jsonResponse([{ filename: 'README.md', status: 'modified', additions: 4, deletions: 1, changes: 5, patch: longPatch }]);
        }
        throw new Error(`Unexpected GitHub API route: ${parsed.pathname}`);
    };
    const result = await readGitHubPullRequest('acme', 'project', 42, { fetchImpl });
    assert.equal(result.pull_request.number, 42);
    assert.equal(result.pull_request.title, 'Improve docs');
    assert.equal(result.pull_request.merged, false);
    assert.equal(result.conversation_comments[0].body, 'Thanks for the PR.');
    assert.equal(result.review_submissions[0].state, 'APPROVED');
    assert.equal(result.inline_review_comments[0].path, 'README.md');
    assert.equal(result.inline_review_comments[0].body.length, 3_000);
    assert.equal(result.inline_review_comments[0].truncated, true);
    assert.equal(result.files[0].filename, 'README.md');
    assert.equal(result.files[0].patch.length, 3_000);
    assert.equal(result.files[0].patch_truncated, true);
    assert.equal(result.pagination.comments, true);
    assert.equal(result.read_only, true);
    assert.match(result.note, /No PRs, reviews, or comments were created or changed/);
    assert.equal(calls.length, 5);
    assert.equal(calls.every(call => call.url.origin === 'https://api.github.com'), true);
    assert.equal(calls.every(call => call.init.headers.Authorization === undefined && call.init.headers.Cookie === undefined), true);
});

await test('reports GitHub public API rate limits and hides private repository details', async () => {
    const fetchImpl = async () => jsonResponse({ message: 'private detail must not be surfaced' }, { status: 404 });
    await assert.rejects(readGitHubRepo('acme', 'private-project', { fetchImpl }), /not found or is not public/);
    const rateLimitedFetch = async () => jsonResponse({ message: 'private quota text' }, { status: 403, headers: { 'X-RateLimit-Remaining': '0' } });
    await assert.rejects(readGitHubRepo('octocat', 'Hello-World', { fetchImpl: rateLimitedFetch }), /rate limit reached/);
});

console.log(`\n${checks.length} GitHub MCP helper checks passed.`);
