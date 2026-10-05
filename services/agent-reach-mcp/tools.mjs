import { execFile as nodeExecFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const execFile = promisify(nodeExecFile);
const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';
const GITHUB_API_ROOT = 'https://api.github.com';
const GITHUB_API_TIMEOUT_MS = 12_000;
const GITHUB_API_MAX_BYTES = 2_000_000;
const GITHUB_PAGE_SIZE = 20;
const GITHUB_FILE_LIMIT = 20;
const MAX_TOOL_OUTPUT = 48_000;
const MAX_READ_BYTES = 1_000_000;
const MAX_READ_CHARS = 32_000;
const MAX_TRANSCRIPT_BYTES = 1_000_000;
const SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_TOTAL_TIMEOUT_MS = 35_000;
const CLI_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 25_000;
const YOUTUBE_TIMEOUT_MS = 35_000;
const DOCTOR_CACHE_MS = 20_000;

let doctorCache = null;
let doctorCacheAt = 0;
let doctorInFlight = null;

async function getDoctorSnapshot(runDoctor, force = false) {
    if (!force && doctorCache !== null && Date.now() - doctorCacheAt < DOCTOR_CACHE_MS) return doctorCache;
    if (doctorInFlight) return doctorInFlight;
    doctorInFlight = Promise.resolve().then(runDoctor).then(value => {
        doctorCache = value;
        doctorCacheAt = Date.now();
        return value;
    }).finally(() => { doctorInFlight = null; });
    return doctorInFlight;
}

export const AGENT_REACH_PLATFORMS = Object.freeze([
    'web', 'github', 'youtube', 'reddit', 'x', 'bilibili', 'xiaohongshu',
    'v2ex', 'linkedin', 'facebook', 'instagram', 'xueqiu',
]);

const SITE_FILTERS = Object.freeze({
    github: 'site:github.com',
    youtube: '(site:youtube.com OR site:youtu.be)',
    reddit: 'site:reddit.com',
    x: '(site:x.com OR site:twitter.com)',
    bilibili: 'site:bilibili.com',
    xiaohongshu: 'site:xiaohongshu.com',
    v2ex: 'site:v2ex.com',
    linkedin: 'site:linkedin.com',
    facebook: 'site:facebook.com',
    instagram: 'site:instagram.com',
    xueqiu: 'site:xueqiu.com',
});

const AUTHENTICATED_PLATFORMS = Object.freeze([
    'x', 'reddit', 'xiaohongshu', 'facebook', 'instagram', 'linkedin', 'xueqiu',
]);

function safeChildEnv() {
    // The MCP bearer token and any optional provider keys must never be passed
    // to yt-dlp or the Agent-Reach CLI subprocesses.
    return {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: '/tmp/agent-reach-home',
        TMPDIR: '/tmp',
        TMP: '/tmp',
        TEMP: '/tmp',
        LANG: 'C.UTF-8',
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        DO_NOT_TRACK: 'true',
        GH_TELEMETRY: 'false',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    };
}

function isBlockedHostname(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') ||
        host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa') ||
        host.endsWith('.localdomain') || !host.includes('.') && isIP(host) === 0) return true;

    const family = isIP(host);
    if (family === 4) {
        const octets = host.split('.').map(Number);
        const [a, b] = octets;
        return a === 0 || a === 10 || a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127) ||
            a >= 224 ||
            (a === 198 && (b === 18 || b === 19 || b === 51)) ||
            (a === 203 && b === 0);
    }
    if (family === 6) {
        const ip = host.toLowerCase();
        if (ip === '::' || ip === '::1' || ip.startsWith('::ffff:') || ip.startsWith('fc') || ip.startsWith('fd') ||
            ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') ||
            ip.startsWith('feb') || ip.startsWith('ff')) return true;
        return false;
    }
    return false;
}

export function validatePublicHttpUrl(raw) {
    let url;
    try { url = new URL(String(raw || '').trim()); } catch { throw new Error('Provide an absolute public http(s) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Only public http(s) URLs without embedded credentials are supported.');
    }
    if (isBlockedHostname(url.hostname)) throw new Error('Private and internal network addresses cannot be read.');
    url.hash = '';
    return url.href;
}

export function validateYoutubeUrl(raw) {
    let url;
    try { url = new URL(String(raw || '').trim()); } catch { throw new Error('Provide a valid YouTube video URL.'); }
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    if (!['youtube.com', 'youtube-nocookie.com', 'youtu.be'].includes(host) ||
        !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        (host === 'youtu.be' && url.pathname.length < 2) ||
        (host !== 'youtu.be' && !url.pathname.startsWith('/watch') && !url.pathname.startsWith('/shorts/') && !url.pathname.startsWith('/live/'))) {
        throw new Error('Only a single public YouTube video URL is supported.');
    }
    url.hash = '';
    return url.href;
}

export function buildPlatformQuery(query, platform) {
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery || cleanQuery.length > 400) throw new Error('Search query must be between 1 and 400 characters.');
    if (!AGENT_REACH_PLATFORMS.includes(platform)) throw new Error('Unsupported platform filter.');
    const filter = SITE_FILTERS[platform];
    return filter ? `${cleanQuery} ${filter}` : cleanQuery;
}

function parseDoctorOutput(output) {
    const text = String(output || '').trim();
    try { return JSON.parse(text); } catch { /* try extracting a JSON object */ }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try { return JSON.parse(text.slice(start, end + 1)); } catch { /* return bounded raw text */ }
    }
    return { raw: text.slice(0, 12_000), parse_error: true };
}

function validateGitHubCoordinates(ownerValue, repoValue) {
    const owner = String(ownerValue || '').trim();
    const repo = String(repoValue || '').trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
        throw new Error('Enter a valid public GitHub owner or organization name.');
    }
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/.test(repo) || repo === '.' || repo === '..') {
        throw new Error('Enter a valid public GitHub repository name.');
    }
    return { owner, repo };
}

function validateGitHubRef(rawRef) {
    if (rawRef == null || String(rawRef).trim() === '') return undefined;
    const ref = String(rawRef).trim();
    if (ref.length > 255 || /[\u0000-\u001f\u007f]/.test(ref)) throw new Error('GitHub ref must be 1–255 printable characters.');
    return ref;
}

function validateGitHubPath(rawPath) {
    const path = String(rawPath || '').trim().replace(/^\/+|\/+$/g, '');
    if (!path) return '';
    if (path.length > 500 || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) {
        throw new Error('GitHub file path is invalid or too long.');
    }
    const parts = path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('GitHub file path cannot contain empty, dot, or parent segments.');
    return parts.map(encodeURIComponent).join('/');
}

function githubApiUrl(path, query = {}) {
    const url = new URL(path, GITHUB_API_ROOT);
    if (url.origin !== GITHUB_API_ROOT) throw new Error('GitHub API route must remain on api.github.com.');
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.href;
}

function githubApiError(status) {
    if (status === 404) return 'GitHub repository or pull request was not found or is not public.';
    if (status === 403 || status === 429) return 'GitHub API rate limit reached or public access was refused. Try again later.';
    if (status === 401) return 'GitHub public API denied this request.';
    return `GitHub API returned HTTP ${status}.`;
}

async function fetchGitHubJson(url, { fetchImpl = globalThis.fetch } = {}) {
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'SANDBOX_RUNNER_CI/1.0',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
        });
    } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('GitHub API request timed out.');
        throw new Error('GitHub public API is unavailable from this service.');
    }
    const { text, truncated } = await readCapped(response, GITHUB_API_MAX_BYTES, GITHUB_API_MAX_BYTES);
    if (truncated) throw new Error('GitHub API response exceeded the service size limit.');
    if (!response.ok) throw new Error(githubApiError(response.status));
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('GitHub API returned an invalid JSON response.'); }
    return {
        data,
        hasNext: /<[^>]+>;\s*rel="next"/.test(response.headers?.get?.('link') || ''),
        rateLimitRemaining: response.headers?.get?.('x-ratelimit-remaining') ?? null,
    };
}

function githubTextFile(data) {
    if (Array.isArray(data)) {
        const entries = data.slice(0, 100).map(entry => ({
            name: entry.name,
            path: entry.path,
            type: entry.type,
            size: entry.size,
            url: entry.html_url,
        }));
        return { kind: 'directory', entries, truncated: data.length > entries.length };
    }
    if (!data || data.type !== 'file') {
        return { kind: data?.type || 'unknown', path: data?.path || null, note: 'This GitHub path is not a regular file or directory.' };
    }
    if (data.encoding !== 'base64' || typeof data.content !== 'string') {
        return { kind: 'file', path: data.path, size: data.size, content: null, truncated: false, note: 'GitHub did not return file text (the file may exceed the API size limit).'};
    }
    const content = Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
    if (content.includes('\0') || /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) {
        return { kind: 'file', path: data.path, size: data.size, content: null, truncated: false, note: 'Binary file content is not returned.' };
    }
    return {
        kind: 'file',
        path: data.path,
        size: data.size,
        content: content.slice(0, MAX_READ_CHARS),
        truncated: content.length > MAX_READ_CHARS,
    };
}

export async function readGitHubRepo(ownerValue, repoValue, { path, ref, fetchImpl = globalThis.fetch } = {}) {
    const { owner, repo } = validateGitHubCoordinates(ownerValue, repoValue);
    const safeRef = validateGitHubRef(ref);
    const encodedPath = validateGitHubPath(path);
    const repoBase = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const metadataResponse = await fetchGitHubJson(githubApiUrl(repoBase), { fetchImpl });
    const metadata = metadataResponse.data;
    let document;
    try {
        const route = encodedPath ? `${repoBase}/contents/${encodedPath}` : `${repoBase}/readme`;
        const response = await fetchGitHubJson(githubApiUrl(route, { ref: safeRef }), { fetchImpl });
        document = githubTextFile(response.data);
        document.has_more_entries = response.hasNext || undefined;
    } catch (error) {
        if (!encodedPath && error instanceof Error && error.message.includes('not found')) {
            document = { kind: 'readme', content: null, note: 'This public repository has no README at the selected ref.' };
        } else throw error;
    }
    return {
        backend: 'GitHub public REST API',
        scope: 'Public repositories only; no login, token, or cookies are used.',
        repository: {
            full_name: metadata.full_name,
            url: metadata.html_url,
            description: metadata.description,
            default_branch: metadata.default_branch,
            visibility: metadata.visibility || (metadata.private ? 'private' : 'public'),
            language: metadata.language,
            stars: metadata.stargazers_count,
            forks: metadata.forks_count,
            open_issues: metadata.open_issues_count,
            topics: metadata.topics || [],
            license: metadata.license?.spdx_id || metadata.license?.name || null,
            updated_at: metadata.updated_at,
        },
        document,
        rate_limit_remaining: metadataResponse.rateLimitRemaining,
        read_only: true,
    };
}

function githubCommentSummary(comment) {
    const body = String(comment.body || '');
    return {
        id: comment.id,
        user: comment.user?.login || null,
        created_at: comment.created_at || comment.submitted_at,
        updated_at: comment.updated_at,
        url: comment.html_url,
        path: comment.path,
        line: comment.line ?? comment.original_line ?? null,
        state: comment.state,
        body: body.slice(0, 3_000),
        truncated: body.length > 3_000,
    };
}

export async function readGitHubPullRequest(ownerValue, repoValue, numberValue, { fetchImpl = globalThis.fetch } = {}) {
    const { owner, repo } = validateGitHubCoordinates(ownerValue, repoValue);
    const number = Number(numberValue);
    if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) throw new Error('Pull request number must be a positive integer.');
    const repoBase = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const prResponse = await fetchGitHubJson(githubApiUrl(`${repoBase}/pulls/${number}`), { fetchImpl });
    const [issueComments, reviews, reviewComments, files] = await Promise.all([
        fetchGitHubJson(githubApiUrl(`${repoBase}/issues/${number}/comments`, { per_page: GITHUB_PAGE_SIZE, page: 1 }), { fetchImpl }),
        fetchGitHubJson(githubApiUrl(`${repoBase}/pulls/${number}/reviews`, { per_page: GITHUB_PAGE_SIZE, page: 1 }), { fetchImpl }),
        fetchGitHubJson(githubApiUrl(`${repoBase}/pulls/${number}/comments`, { per_page: GITHUB_PAGE_SIZE, page: 1 }), { fetchImpl }),
        fetchGitHubJson(githubApiUrl(`${repoBase}/pulls/${number}/files`, { per_page: GITHUB_FILE_LIMIT, page: 1 }), { fetchImpl }),
    ]);
    const pr = prResponse.data;
    const fileList = Array.isArray(files.data) ? files.data.slice(0, GITHUB_FILE_LIMIT).map(file => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: typeof file.patch === 'string' ? file.patch.slice(0, 3_000) : null,
        patch_truncated: typeof file.patch === 'string' && file.patch.length > 3_000,
    })) : [];
    const reviewList = Array.isArray(reviews.data) ? reviews.data.slice(0, GITHUB_PAGE_SIZE).map(githubCommentSummary) : [];
    const issueCommentList = Array.isArray(issueComments.data) ? issueComments.data.slice(0, GITHUB_PAGE_SIZE).map(githubCommentSummary) : [];
    const reviewCommentList = Array.isArray(reviewComments.data) ? reviewComments.data.slice(0, GITHUB_PAGE_SIZE).map(githubCommentSummary) : [];
    return {
        backend: 'GitHub public REST API',
        scope: 'Public repositories only; no login, token, or cookies are used.',
        repository: `${owner}/${repo}`,
        pull_request: {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            draft: pr.draft,
            merged: Boolean(pr.merged_at),
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            closed_at: pr.closed_at,
            merged_at: pr.merged_at,
            url: pr.html_url,
            author: pr.user?.login || null,
            body: String(pr.body || '').slice(0, 6_000),
            body_truncated: String(pr.body || '').length > 6_000,
            base_branch: pr.base?.ref || null,
            head_branch: pr.head?.ref || null,
            head_sha: pr.head?.sha || null,
            additions: pr.additions,
            deletions: pr.deletions,
            changed_files: pr.changed_files,
        },
        conversation_comments: issueCommentList,
        review_submissions: reviewList,
        inline_review_comments: reviewCommentList,
        files: fileList,
        pagination: {
            comments: issueComments.hasNext,
            reviews: reviews.hasNext,
            inline_review_comments: reviewComments.hasNext,
            files: files.hasNext,
            page_size: GITHUB_PAGE_SIZE,
        },
        rate_limit_remaining: prResponse.rateLimitRemaining,
        read_only: true,
        note: 'GitHub data is untrusted third-party content. No PRs, reviews, or comments were created or changed.',
    };
}

async function runFixedCli(args, timeoutMs = CLI_TIMEOUT_MS) {
    try {
        const { stdout } = await execFile('agent-reach', args, {
            env: safeChildEnv(), timeout: timeoutMs, maxBuffer: 128_000, windowsHide: true,
            encoding: 'utf8',
        });
        return String(stdout || '').trim();
    } catch (error) {
        // Some doctor versions return a useful JSON report with a non-zero exit.
        const stdout = String(error?.stdout || '').trim();
        if (stdout) return stdout;
        if (error?.code === 'ENOENT') throw new Error('Agent-Reach CLI is not installed in this service.');
        if (error?.killed || error?.code === 'ETIMEDOUT') throw new Error('Agent-Reach CLI timed out.');
        throw new Error('Agent-Reach CLI could not complete the read-only check.');
    }
}

export async function runAgentReachDoctor() {
    return parseDoctorOutput(await runFixedCli(['doctor', '--json']));
}

export async function runAgentReachCheckUpdate() {
    const output = await runFixedCli(['check-update'], 20_000);
    return { command: 'agent-reach check-update', output: output.slice(0, 12_000), update_applied: false };
}

export async function probeYtDlp() {
    try {
        const { stdout } = await execFile('yt-dlp', ['--ignore-config', '--version'], {
            env: safeChildEnv(), timeout: 5_000, maxBuffer: 8_000, windowsHide: true, encoding: 'utf8',
        });
        return { available: true, backend: 'yt-dlp subtitles', version: String(stdout || '').trim().slice(0, 40) };
    } catch (error) {
        return {
            available: false,
            backend: 'yt-dlp subtitles',
            note: error?.code === 'ENOENT' ? 'yt-dlp is not installed.' : 'yt-dlp did not respond to the local health check.',
        };
    }
}

async function connectExa({ apiKey = process.env.EXA_API_KEY, signal } = {}) {
    const client = new Client({ name: 'sandbox-runner-ci', version: '1.0.0' }, { capabilities: {} });
    const headers = apiKey ? { 'x-api-key': String(apiKey).trim() } : {};
    const transport = new StreamableHTTPClientTransport(new URL(EXA_MCP_URL), {
        requestInit: { headers },
    });
    await client.connect(transport, { timeout: SEARCH_TIMEOUT_MS, maxTotalTimeout: SEARCH_TIMEOUT_MS, signal });
    return { client, transport };
}

export async function probeExaSearch(options = {}) {
    let client;
    const signal = AbortSignal.timeout(SEARCH_TOTAL_TIMEOUT_MS);
    try {
        ({ client } = await connectExa({ ...options, signal }));
        const { tools = [] } = await client.listTools({}, { timeout: SEARCH_TIMEOUT_MS, maxTotalTimeout: SEARCH_TIMEOUT_MS, signal });
        return { available: tools.some(tool => tool.name === 'web_search_exa'), backend: 'Exa hosted MCP' };
    } catch {
        return { available: false, backend: 'Exa hosted MCP', note: 'Could not verify the remote tool list.' };
    } finally {
        await client?.close().catch(() => {});
    }
}

export async function searchManyWithExa(queries, numResults = 3, options = {}) {
    let client;
    const signal = AbortSignal.timeout(SEARCH_TOTAL_TIMEOUT_MS);
    try {
        ({ client } = await connectExa({ ...options, signal }));
        const { tools = [] } = await client.listTools({}, { timeout: SEARCH_TIMEOUT_MS, maxTotalTimeout: SEARCH_TIMEOUT_MS, signal });
        if (!tools.some(tool => tool.name === 'web_search_exa')) throw new Error('Search tool not listed.');
        const results = await Promise.all(queries.map(async query => {
            try {
                const result = await client.callTool(
                    { name: 'web_search_exa', arguments: { query, numResults } },
                    undefined,
                    { timeout: SEARCH_TIMEOUT_MS, maxTotalTimeout: SEARCH_TIMEOUT_MS, signal },
                );
                if (result?.isError) throw new Error('Search tool returned an error.');
                const content = Array.isArray(result?.content)
                    ? result.content.filter(block => block?.type === 'text').map(block => String(block.text || '')).join('\n')
                    : '';
                const structured = result?.structuredContent;
                const text = structured && typeof structured === 'object' ? JSON.stringify(structured, null, 2) : content;
                if (!text) throw new Error('Search returned no text results.');
                return { query, content: text.slice(0, 6_000), truncated: text.length > 6_000 };
            } catch {
                return { query, content: null, error: 'Exa could not complete this platform search.', truncated: false };
            }
        }));
        if (results.every(result => result.error)) throw new Error('Every Exa platform search failed.');
        return { available: true, backend: 'Exa hosted MCP', results };
    } catch {
        throw new Error('Exa search is unavailable or rate-limited. Check the Exa MCP connection and try again later.');
    } finally {
        await client?.close().catch(() => {});
    }
}

export async function searchWithExa(query, numResults = 3, options = {}) {
    const batch = await searchManyWithExa([query], numResults, options);
    return { backend: batch.backend, ...batch.results[0] };
}

async function readCapped(response, maxBytes = MAX_READ_BYTES, maxChars = MAX_READ_CHARS) {
    const reader = response.body?.getReader?.();
    if (!reader) {
        const text = await response.text();
        const bytes = Buffer.byteLength(text, 'utf8');
        return { text: text.slice(0, maxChars), truncated: bytes > maxBytes || text.length > maxChars };
    }
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    let truncated = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            text += decoder.decode(value, { stream: true });
            if (bytes >= maxBytes || text.length >= maxChars) { truncated = true; break; }
        }
        text += decoder.decode();
    } finally {
        if (truncated) await reader.cancel().catch(() => {});
    }
    if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
    return { text, truncated };
}

export async function readWithJina(rawUrl, { fetchImpl = globalThis.fetch } = {}) {
    const url = validatePublicHttpUrl(rawUrl);
    const response = await fetchImpl(`https://r.jina.ai/${url}`, {
        headers: { Accept: 'text/plain', 'User-Agent': 'SANDBOX_RUNNER_CI/1.0' },
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        redirect: 'follow',
    });
    if (!response.ok) throw new Error(`Jina Reader returned HTTP ${response.status}.`);
    const { text, truncated } = await readCapped(response);
    return {
        url,
        backend: 'Jina Reader',
        status: response.status,
        text,
        truncated,
        note: 'Public webpage text only. Cookies and account sessions are not sent.',
    };
}

export function cleanVtt(source) {
    const lines = String(source || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    const output = [];
    for (const raw of lines) {
        const line = raw.trim().replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        if (!line || line === 'WEBVTT' || /^Kind:/i.test(line) || /^Language:/i.test(line) ||
            /^NOTE(?:\s|$)/.test(line) || /^\d+$/.test(line) || /-->/.test(line)) continue;
        if (line !== output.at(-1)) output.push(line);
    }
    return output.join('\n');
}

function normalizeLanguages(value) {
    const languages = String(value || 'en,th').split(',').map(part => part.trim()).filter(Boolean);
    if (!languages.length || languages.length > 6 || languages.some(lang => !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(lang))) {
        throw new Error('Use a comma-separated list of language codes such as en,th.');
    }
    return [...new Set(languages)].join(',');
}

export async function fetchYoutubeTranscript(rawUrl, languages = 'en,th') {
    const url = validateYoutubeUrl(rawUrl);
    const subLanguages = normalizeLanguages(languages);
    const outputDir = await mkdtemp(join(tmpdir(), 'agent-reach-youtube-'));
    try {
        try {
            await execFile('yt-dlp', [
                '--ignore-config', '--no-warnings', '--no-progress', '--no-playlist',
                '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', subLanguages,
                '--sub-format', 'vtt', '--js-runtimes', 'node',
                '--output', join(outputDir, '%(id)s.%(ext)s'), url,
            ], {
                env: safeChildEnv(), timeout: YOUTUBE_TIMEOUT_MS, maxBuffer: 64_000,
                windowsHide: true, encoding: 'utf8',
            });
        } catch (error) {
            if (error?.code === 'ENOENT') throw new Error('yt-dlp is not installed in this service.');
            if (error?.killed || error?.code === 'ETIMEDOUT') throw new Error('YouTube transcript retrieval timed out.');
            throw new Error('No public YouTube subtitles were retrieved for the requested languages.');
        }
        const files = (await readdir(outputDir)).filter(file => file.toLowerCase().endsWith('.vtt')).sort();
        if (!files.length) throw new Error('No public YouTube subtitles were found for the requested languages.');
        const file = files[0];
        const filePath = join(outputDir, file);
        const metadata = await stat(filePath);
        if (!metadata.isFile() || metadata.size > MAX_TRANSCRIPT_BYTES) throw new Error('The transcript exceeded the service limit.');
        const rawTranscript = await readFile(filePath, 'utf8');
        const transcript = cleanVtt(rawTranscript).slice(0, MAX_READ_CHARS);
        if (!transcript) throw new Error('The video subtitle file was empty.');
        const language = file.match(/\.([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?)\.vtt$/)?.[1] || null;
        return {
            url,
            backend: 'yt-dlp subtitles',
            language,
            transcript,
            truncated: rawTranscript.length > MAX_READ_CHARS,
            note: 'Public subtitles only; no account cookies or browser session are used.',
        };
    } finally {
        await rm(outputDir, { recursive: true, force: true });
    }
}

function toolText(value) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const truncated = serialized.length > MAX_TOOL_OUTPUT;
    const text = truncated ? `${serialized.slice(0, MAX_TOOL_OUTPUT)}\n[Result truncated by SANDBOX_RUNNER_CI.]` : serialized;
    return { content: [{ type: 'text', text }] };
}

function toolError(error) {
    const message = error instanceof Error ? error.message : 'The read-only tool failed.';
    return { isError: true, content: [{ type: 'text', text: message.slice(0, 800) }] };
}

function readOnlyAnnotations(title) {
    return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
}

export function createAgentReachMcpServer(overrides = {}) {
    const dependencies = {
        doctor: runAgentReachDoctor,
        checkUpdate: runAgentReachCheckUpdate,
        probeSearch: probeExaSearch,
        searchMany: searchManyWithExa,
        search: searchWithExa,
        read: readWithJina,
        githubRepo: readGitHubRepo,
        githubPullRequest: readGitHubPullRequest,
        transcript: fetchYoutubeTranscript,
        probeYtDlp,
        ...overrides,
    };
    const server = new McpServer({ name: 'SANDBOX_RUNNER_CI', version: '1.0.0' });

    server.registerTool('agent_reach_doctor', {
        title: 'Check Agent-Reach backends',
        description: 'Run the official agent-reach doctor --json inside this service container and report this bridge’s available read-only backends. This reports the remote service, not the user’s computer. No cookies or account sessions are read.',
        inputSchema: {},
        annotations: readOnlyAnnotations('Agent-Reach doctor (read-only)'),
    }, async () => {
        try {
            const [doctor, exa, ytdlp] = await Promise.all([
                getDoctorSnapshot(dependencies.doctor, true),
                dependencies.probeSearch(),
                dependencies.probeYtDlp ? dependencies.probeYtDlp() : Promise.resolve({ available: true, backend: 'yt-dlp subtitles', note: 'Checked when used.' }),
            ]);
            return toolText({
                service: 'SANDBOX_RUNNER_CI',
                execution_environment: 'Remote service container; this is not the user’s local environment.',
                command: 'agent-reach doctor --json',
                doctor,
                bridge_backends: {
                    web_search: exa,
                    web_read: { available: true, backend: 'Jina Reader', note: 'Checked when a public URL is read.' },
                    github_public_read: { available: true, backend: 'GitHub public REST API', note: 'Public repositories only; checked when requested. Unauthenticated API rate limits apply.' },
                    youtube_transcripts: ytdlp,
                    platform_specific_logged_in_sessions: {
                        available: false,
                        platforms: AUTHENTICATED_PLATFORMS,
                        reason: 'This remote service has no user browser session and does not accept or store cookies. Exa may return public indexed pages only.',
                    },
                },
                policy: { read_only: true, arbitrary_command_execution: false, cookies_accepted: false },
            });
        } catch (error) { return toolError(error); }
    });

    server.registerTool('agent_reach_search', {
        title: 'Search public web sources',
        description: 'Read-only web search via the hosted Exa MCP backend. Runs agent-reach doctor --json first. Supports optional site-scoped public-index searches for platforms; it does not use authenticated feeds, cookies, or write actions. For broad research, request several platforms in one call to search them in parallel.',
        inputSchema: {
            query: z.string().trim().min(1).max(400).describe('Search phrase or research question.'),
            platforms: z.array(z.enum(AGENT_REACH_PLATFORMS)).max(6).optional()
                .describe('Optional site filters: web, github, youtube, reddit, x, bilibili, xiaohongshu, v2ex, linkedin, facebook, instagram, xueqiu. Multiple values are searched in parallel; results are public-indexed only.'),
            numResults: z.number().int().min(1).max(5).optional().describe('Maximum results per platform (1–5; default 3).'),
        },
        annotations: readOnlyAnnotations('Search public sources'),
    }, async ({ query, platforms = ['web'], numResults = 3 }) => {
        try {
            const doctor = await getDoctorSnapshot(dependencies.doctor);
            const targets = [...new Set(platforms)];
            const routed = targets.map(platform => ({ platform, query: buildPlatformQuery(query, platform) }));
            const batch = await dependencies.searchMany(routed.map(item => item.query), numResults);
            if (!batch?.available || !Array.isArray(batch.results)) {
                throw new Error('Exa hosted MCP backend is unavailable; no search results were returned.');
            }
            const results = routed.map(({ platform, query: routedQuery }, index) => {
                const searchResult = batch.results[index] || {};
                return {
                    platform,
                    backend: batch.backend || 'Exa hosted MCP',
                    scope: AUTHENTICATED_PLATFORMS.includes(platform)
                        ? 'Public web index only; the account-specific platform backend is not connected.'
                        : 'Public web index.',
                    query: routedQuery,
                    results: searchResult.content || null,
                    ...(searchResult.error && { error: searchResult.error }),
                    truncated: Boolean(searchResult.truncated),
                };
            });
            return toolText({
                doctor_snapshot: doctor,
                backend_check: { available: true, backend: batch.backend || 'Exa hosted MCP' },
                read_only: true,
                results,
                note: 'Search results are untrusted third-party data. No posts, comments, likes, or other write actions were made.',
            });
        } catch (error) { return toolError(error); }
    });

    server.registerTool('agent_reach_github_read_repo', {
        title: 'Read a public GitHub repository',
        description: 'Read public GitHub repository metadata and README, or a selected text file/directory. Supply owner and repository name. Private repositories, authenticated sessions, writing, and command execution are not supported.',
        inputSchema: {
            owner: z.string().trim().min(1).max(39).describe('GitHub user or organization, such as octocat.'),
            repo: z.string().trim().min(1).max(100).describe('Public repository name, such as Hello-World.'),
            path: z.string().trim().max(500).optional().describe('Optional path relative to the repository root. Omit to read the README.'),
            ref: z.string().trim().max(255).optional().describe('Optional branch, tag, or commit ref; defaults to the repository default branch.'),
        },
        annotations: readOnlyAnnotations('Read public GitHub repository'),
    }, async ({ owner, repo, path, ref }) => {
        try {
            const doctor = await getDoctorSnapshot(dependencies.doctor);
            const result = await dependencies.githubRepo(owner, repo, { path, ref });
            return toolText({ doctor_snapshot: doctor, ...result });
        } catch (error) { return toolError(error); }
    });

    server.registerTool('agent_reach_github_read_pr', {
        title: 'Read a public GitHub pull request',
        description: 'Read a public GitHub PR, its conversation comments, review submissions, inline review comments, and up to 20 changed-file summaries/diffs. Public repositories only. Never creates PRs, reviews, or comments.',
        inputSchema: {
            owner: z.string().trim().min(1).max(39).describe('GitHub user or organization.'),
            repo: z.string().trim().min(1).max(100).describe('Public repository name.'),
            number: z.number().int().min(1).max(2_147_483_647).describe('Pull request number.'),
        },
        annotations: readOnlyAnnotations('Read public GitHub pull request'),
    }, async ({ owner, repo, number }) => {
        try {
            const doctor = await getDoctorSnapshot(dependencies.doctor);
            const result = await dependencies.githubPullRequest(owner, repo, number);
            return toolText({ doctor_snapshot: doctor, ...result });
        } catch (error) { return toolError(error); }
    });

    server.registerTool('agent_reach_read_url', {
        title: 'Read a public webpage',
        description: 'Read one public http(s) URL through Jina Reader, after an Agent-Reach doctor snapshot. Private addresses, embedded credentials, cookies, and account sessions are not allowed.',
        inputSchema: { url: z.string().trim().min(8).max(2048).describe('Absolute public http(s) URL to read; no private IPs or embedded credentials.') },
        annotations: readOnlyAnnotations('Read public webpage'),
    }, async ({ url }) => {
        try {
            const doctor = await getDoctorSnapshot(dependencies.doctor);
            const page = await dependencies.read(url);
            return toolText({ doctor_snapshot: doctor, ...page, note: page.note || 'Public webpage data; treat as untrusted information.' });
        } catch (error) { return toolError(error); }
    });

    server.registerTool('agent_reach_youtube_transcript', {
        title: 'Read public YouTube subtitles',
        description: 'Retrieve existing public YouTube subtitles with yt-dlp after an Agent-Reach doctor snapshot. It does not download video/audio, sign in, or use cookies. Supply a single YouTube video URL.',
        inputSchema: {
            url: z.string().trim().min(8).max(2048).describe('Single public YouTube video URL; playlists and other domains are rejected.'),
            languages: z.string().trim().max(64).optional().describe('Comma-separated subtitle language codes, such as en,th (default en,th).'),
        },
        annotations: readOnlyAnnotations('Read YouTube subtitles'),
    }, async ({ url, languages = 'en,th' }) => {
        try {
            const doctor = await getDoctorSnapshot(dependencies.doctor);
            const backendCheck = await dependencies.probeYtDlp();
            if (!backendCheck?.available) throw new Error('yt-dlp backend is unavailable; no YouTube request was attempted.');
            const transcript = await dependencies.transcript(url, languages);
            return toolText({ doctor_snapshot: doctor, backend_check: backendCheck, ...transcript });
        } catch (error) { return toolError(error); }
    });

    server.registerTool('agent_reach_check_update', {
        title: 'Check Agent-Reach version',
        description: 'Run agent-reach check-update as a read-only version check. It never installs or updates packages.',
        inputSchema: {},
        annotations: readOnlyAnnotations('Check for Agent-Reach updates'),
    }, async () => {
        try { return toolText(await dependencies.checkUpdate()); }
        catch (error) { return toolError(error); }
    });

    return server;
}

export { AUTHENTICATED_PLATFORMS, EXA_MCP_URL, SITE_FILTERS };
