FROM node:22-bookworm-slim

ARG AGENT_REACH_REF=a19a171fa980a0785849596492e0af4db800c82f
ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp/agent-reach-home \
    TMPDIR=/tmp

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

RUN python3 -m venv /opt/agent-reach-venv \
    && /opt/agent-reach-venv/bin/pip install --no-cache-dir \
       "git+https://github.com/Panniantong/Agent-Reach.git@${AGENT_REACH_REF}"
ENV PATH="/opt/agent-reach-venv/bin:${PATH}"

COPY services/agent-reach-mcp ./services/agent-reach-mcp
RUN useradd --system --uid 10001 --home-dir /tmp/agent-reach-home --create-home agentreach \
    && chown -R agentreach:agentreach /app /tmp/agent-reach-home

USER 10001:10001
EXPOSE 10000
CMD ["node", "services/agent-reach-mcp/server.mjs"]
