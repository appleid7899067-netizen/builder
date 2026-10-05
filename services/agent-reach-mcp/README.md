# SANDBOX_RUNNER_CI — read-only Agent-Reach MCP bridge

This service exposes a **remote Streamable HTTP MCP endpoint** for Builder at `/mcp`. It wraps only read/search operations; it is not a general shell runner. The upstream Agent-Reach MCP integration is a local stdio server that exposes status only, while Builder's connector accepts remote Streamable HTTP, so this is a small custom bridge—not an official hosted Agent-Reach service. It calls the official CLI only for its read-only doctor and update checks, and routes supported reads/searches through the backends listed below.

## Tools exposed

- `agent_reach_doctor` — runs the upstream `agent-reach doctor --json` inside the Render container and reports the bridge backends. The report is about the remote container, not the user's computer.
- `agent_reach_search` — public web search through Exa's hosted MCP. Optional platform filters (GitHub, YouTube, Reddit, X, Bilibili, Xiaohongshu, V2EX, LinkedIn, Facebook, Instagram, Xueqiu) use public indexed pages only.
- `agent_reach_read_url` — reads a public HTTP(S) page with Jina Reader.
- `agent_reach_youtube_transcript` — extracts existing public subtitles with `yt-dlp`; it does not download video/audio.
- `agent_reach_check_update` — checks the upstream Agent-Reach version; it does not install or update anything.

There is no arbitrary command-execution tool and no write/action tool. The service does not accept, store, or forward user cookies or browser sessions. Authenticated platform backends (for example account feeds or private Reddit/Xiaohongshu content) therefore remain unavailable from this remote service. Exa may still find public, indexed pages for those sites; the result labels that limitation.

## Deploy to Render

The dedicated Blueprint file is `render.agent-reach.yaml` so it won't change the Builder app's existing deployment definition. In Render, create a Blueprint from this repository and set **Blueprint Path** to `render.agent-reach.yaml`. The service is named `sandbox-runner-ci`; Render will supply its public hostname and `PORT`.

The Blueprint uses Render's `generateValue: true` for `MCP_BEARER_TOKEN`, so Render creates a private random secret automatically. Do not copy it into Git. After the first deploy, copy that generated value from the service's Environment tab into Builder's bearer-token field. `PORT` is supplied by Render automatically.

`EXA_API_KEY` is optional. Exa's hosted MCP works without a key on its free tier; adding your own Exa key can raise its rate limits. If used, add it only as a Render secret.

After the service is live, use its HTTPS hostname and append `/mcp`, for example `https://<your-render-host>.onrender.com/mcp`. In Builder's **MCP connections**, add:

- Name: `SANDBOX_RUNNER_CI`
- Server URL: the deployed `https://…/mcp` URL
- Bearer token: the same `MCP_BEARER_TOKEN` value set in Render

The MCP endpoint requires HTTPS and a bearer token. `/healthz` is a public, non-sensitive health check. Builder keeps bearer tokens only in memory, not in its saved MCP connection list, so you may need to re-enter the token after a page reload. Render's free plan may sleep when idle, so the first MCP connection after inactivity can be slower.

## Local smoke test

```bash
npm ci
MCP_BEARER_TOKEN="$(openssl rand -hex 32)" PORT=10000 node services/agent-reach-mcp/server.mjs
```

The same read-only MCP tools are served at `http://localhost:10000/mcp` for local testing. Do not use a production bearer token in local development.
