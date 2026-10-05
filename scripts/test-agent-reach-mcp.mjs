import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
    buildPlatformQuery,
    cleanVtt,
    createAgentReachMcpServer,
    validatePublicHttpUrl,
    validateYoutubeUrl,
} from '../services/agent-reach-mcp/tools.mjs';
import { createAgentReachHttpServer } from '../services/agent-reach-mcp/server.mjs';

const checks = [];
async function test(name, fn) {
    await fn();
    checks.push(name);
    console.log(`✓ ${name}`);
}

await test('public URL guard rejects local, credentialed, and non-http targets', async () => {
    assert.equal(validatePublicHttpUrl('https://example.com/path#fragment'), 'https://example.com/path');
    for (const url of [
        'file:///etc/passwd',
        'https://user:secret@example.com/',
        'http://localhost/admin',
        'http://127.0.0.1:9222/json',
        'http://169.254.169.254/latest/meta-data',
        'http://[::1]/',
        'http://10.0.0.1/',
    ]) assert.throws(() => validatePublicHttpUrl(url));
});

await test('YouTube tool only accepts single YouTube video URLs', async () => {
    assert.equal(validateYoutubeUrl('https://youtu.be/abc123').startsWith('https://youtu.be/'), true);
    assert.equal(validateYoutubeUrl('https://www.youtube.com/watch?v=abc123').includes('youtube.com/watch'), true);
    assert.throws(() => validateYoutubeUrl('https://example.com/watch?v=abc123'));
    assert.throws(() => validateYoutubeUrl('https://youtube.com/playlist?list=abc'));
});

await test('platform searches are constrained to known public domains', async () => {
    assert.equal(buildPlatformQuery('release notes', 'web'), 'release notes');
    assert.equal(buildPlatformQuery('security issue', 'reddit'), 'security issue site:reddit.com');
    assert.equal(buildPlatformQuery('model', 'x').includes('site:x.com'), true);
    assert.throws(() => buildPlatformQuery('topic', 'unknown-platform'));
});

await test('VTT subtitle cleanup removes timestamps and repeated lines', async () => {
    const transcript = cleanVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello there\n\n00:00:02.000 --> 00:00:03.000\nHello there\nAgain');
    assert.equal(transcript, 'Hello there\nAgain');
});

const token = 'mcp-test-token-'.padEnd(64, 'x');
const callOrder = [];
const dependencies = {
    doctor: async () => { callOrder.push('doctor'); return { channels: { web: { active_backend: 'Jina Reader' } } }; },
    probeSearch: async () => { callOrder.push('probeSearch'); return { available: true, backend: 'Exa hosted MCP' }; },
    probeYtDlp: async () => ({ available: true, backend: 'yt-dlp subtitles', version: 'test' }),
    searchMany: async (queries, count) => {
        callOrder.push('searchMany');
        return {
            available: true,
            backend: 'Exa hosted MCP',
            results: queries.map(query => {
                callOrder.push(`search:${query}`);
                return { query, content: `search(${count}): ${query}`, truncated: false };
            }),
        };
    },
    read: async url => ({ url, backend: 'Jina Reader', text: 'page text', truncated: false }),
    transcript: async url => ({ url, backend: 'yt-dlp subtitles', transcript: 'video captions' }),
    checkUpdate: async () => ({ output: 'up to date', update_applied: false }),
};

const httpServer = createAgentReachHttpServer({
    token,
    createMcpServer: () => createAgentReachMcpServer(dependencies),
});
httpServer.listen(0, '127.0.0.1');
await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
});
const address = httpServer.address();
if (!address || typeof address === 'string') throw new Error('Could not determine test server port.');
const endpoint = `http://127.0.0.1:${address.port}/mcp`;

try {
    await test('health endpoint is public and does not reveal the bearer token', async () => {
        const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.service, 'SANDBOX_RUNNER_CI');
        assert.equal(body.read_only, true);
        assert.equal(JSON.stringify(body).includes(token), false);
    });

    await test('MCP endpoint requires bearer token and supports browser preflight', async () => {
        const unauthorized = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        assert.equal(unauthorized.status, 401);
        const preflight = await fetch(endpoint, { method: 'OPTIONS' });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    });

    const client = new Client({ name: 'agent-reach-test', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    try {
        await client.connect(transport, { timeout: 5_000, maxTotalTimeout: 5_000 });

        await test('MCP publishes only read-only Agent-Reach tools', async () => {
            const { tools } = await client.listTools({}, { timeout: 5_000 });
            const names = tools.map(tool => tool.name).sort();
            assert.deepEqual(names, [
                'agent_reach_check_update',
                'agent_reach_doctor',
                'agent_reach_read_url',
                'agent_reach_search',
                'agent_reach_youtube_transcript',
            ]);
            assert.equal(tools.every(tool => tool.annotations?.readOnlyHint === true), true);
            assert.equal(tools.every(tool => tool.annotations?.destructiveHint === false), true);
            assert.equal(names.some(name => /post|comment|like|write|execute|configure|install/i.test(name)), false);
        });

        await test('research search checks doctor before parallel public platform queries', async () => {
            callOrder.length = 0;
            const result = await client.callTool({
                name: 'agent_reach_search',
                arguments: { query: 'browser automation', platforms: ['web', 'reddit'], numResults: 2 },
            }, undefined, { timeout: 5_000, maxTotalTimeout: 5_000 });
            assert.equal(result.isError, undefined);
            const payload = JSON.parse(result.content[0].text);
            assert.equal(payload.read_only, true);
            assert.equal(payload.results.length, 2);
            assert.equal(payload.results[0].backend, 'Exa hosted MCP');
            assert.match(payload.results[1].scope, /Public web index only/);
            assert.deepEqual(callOrder.slice(0, 2), ['doctor', 'searchMany']);
            assert.equal(callOrder.filter(item => item.startsWith('search:')).length, 2);
        });

        await test('URL reading and video captions route through read-only handlers', async () => {
            const page = await client.callTool({ name: 'agent_reach_read_url', arguments: { url: 'https://example.com' } }, undefined, { timeout: 5_000 });
            assert.match(page.content[0].text, /Jina Reader/);
            const captions = await client.callTool({ name: 'agent_reach_youtube_transcript', arguments: { url: 'https://youtu.be/abc123' } }, undefined, { timeout: 5_000 });
            assert.match(captions.content[0].text, /video captions/);
            assert.equal(callOrder.filter(item => item === 'doctor').length, 1);
        });

        await test('update check reports but never applies an update', async () => {
            const result = await client.callTool({ name: 'agent_reach_check_update', arguments: {} }, undefined, { timeout: 5_000 });
            const payload = JSON.parse(result.content[0].text);
            assert.equal(payload.update_applied, false);
            assert.equal(payload.output, 'up to date');
        });
    } finally {
        await client.close().catch(() => {});
    }
} finally {
    await new Promise(resolve => httpServer.close(resolve));
}

console.log(`\n${checks.length} Agent-Reach MCP checks passed.`);
