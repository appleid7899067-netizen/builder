import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAgentReachMcpServer } from './tools.mjs';

const MAX_BODY_BYTES = 256_000;
const MCP_PATH = '/mcp';
const HEALTH_PATH = '/healthz';
const CORS_HEADERS = Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID',
    'Access-Control-Expose-Headers': 'MCP-Session-Id, MCP-Protocol-Version, WWW-Authenticate',
    'Access-Control-Max-Age': '86400',
});

function sendJson(res, status, payload) {
    if (res.headersSent) return;
    res.writeHead(status, {
        ...CORS_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
}

function hasValidBearerToken(header, expected) {
    const match = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
    if (!match) return false;
    const provided = Buffer.from(match[1], 'utf8');
    const wanted = Buffer.from(expected, 'utf8');
    return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

async function readJsonBody(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
        throw Object.assign(new Error('MCP requests must use application/json.'), { statusCode: 415 });
    }
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
        throw Object.assign(new Error('MCP request is too large.'), { statusCode: 413 });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw Object.assign(new Error('MCP request is too large.'), { statusCode: 413 });
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('MCP request must contain valid JSON.'), { statusCode: 400 }); }
}

export function createAgentReachHttpServer({ token = process.env.MCP_BEARER_TOKEN, createMcpServer = createAgentReachMcpServer } = {}) {
    if (typeof token !== 'string' || token.trim().length < 32) {
        throw new Error('Set MCP_BEARER_TOKEN to a random secret of at least 32 characters.');
    }
    token = token.trim();

    const httpServer = createServer(async (req, res) => {
        for (const [header, value] of Object.entries(CORS_HEADERS)) res.setHeader(header, value);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');

        let pathname;
        try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
        catch { sendJson(res, 400, { error: 'Invalid request path.' }); return; }

        if (req.method === 'OPTIONS' && pathname === MCP_PATH) {
            res.writeHead(204, CORS_HEADERS);
            res.end();
            return;
        }
        if (pathname === HEALTH_PATH && req.method === 'GET') {
            sendJson(res, 200, { status: 'ok', service: 'SANDBOX_RUNNER_CI', read_only: true });
            return;
        }
        if (pathname !== MCP_PATH) {
            sendJson(res, 404, { error: 'Not found.' });
            return;
        }
        if (!hasValidBearerToken(req.headers.authorization, token)) {
            res.setHeader('WWW-Authenticate', 'Bearer');
            sendJson(res, 401, { error: 'Unauthorized.' });
            return;
        }
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST, OPTIONS');
            sendJson(res, 405, { error: 'This stateless MCP endpoint supports POST and OPTIONS only.' });
            return;
        }

        let body;
        try { body = await readJsonBody(req); }
        catch (error) {
            sendJson(res, error?.statusCode || 400, { error: error?.message || 'Invalid MCP request.' });
            return;
        }

        let mcpServer;
        let transport;
        try {
            mcpServer = createMcpServer();
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true,
            });
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, body);
        } catch {
            // Request bodies and provider errors may contain sensitive data. Do not
            // log them, and return a fixed message rather than echoing server output.
            sendJson(res, 500, { error: 'The MCP request could not be completed.' });
        } finally {
            await mcpServer?.close().catch(() => {});
            await transport?.close().catch(() => {});
        }
    });

    return httpServer;
}

function start() {
    let httpServer;
    try { httpServer = createAgentReachHttpServer(); }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
        return;
    }
    const port = Number(process.env.PORT) || 10000;
    httpServer.listen(port, '0.0.0.0', () => {
        console.log(`SANDBOX_RUNNER_CI MCP listening on 0.0.0.0:${port}`);
    });
    const stop = () => httpServer.close(() => process.exit(0));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start();
