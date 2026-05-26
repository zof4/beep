FROM node:22-bookworm-slim

ARG BEEP_RUNTIME_UPDATE_EPOCH=manual

ENV NODE_ENV=production
ENV BEEP_NO_API_KEY=1
ENV BEEP_STATE_DIR=/state
ENV BEEP_WORKSPACE_DIR=/workspace
ENV BEEP_LCM_DIR=/lcm
ENV BEEP_LCM_ROOT=/opt/lossless-claw
ENV BEEP_LCM_DB=/lcm/beep-lcm.sqlite
ENV CODEX_HOME=/state/codex
ENV HOME=/state/home
ENV XDG_CACHE_HOME=/state/xdg-cache
ENV XDG_CONFIG_HOME=/state/xdg-config
ENV NPM_CONFIG_CACHE=/state/npm-cache
ENV PATH=/runtime/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    bubblewrap \
    ca-certificates \
    curl \
    git \
    jq \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN echo "Beep runtime dependency update epoch: ${BEEP_RUNTIME_UPDATE_EPOCH}" \
  && npm install -g @openai/codex@latest \
  && codex --version

WORKDIR /opt/pi

COPY vendor/pi/package.json vendor/pi/package-lock.json /opt/pi/
COPY vendor/pi/tsconfig.json vendor/pi/tsconfig.base.json /opt/pi/
COPY vendor/pi/packages /opt/pi/packages

RUN npm ci --include=dev --ignore-scripts --prefix /opt/pi

RUN cd /opt/pi/packages/ai \
  && ../../node_modules/.bin/tsgo -p tsconfig.build.json \
  && cd /opt/pi/packages/tui \
  && ../../node_modules/.bin/tsgo -p tsconfig.build.json \
  && cd /opt/pi/packages/agent \
  && ../../node_modules/.bin/tsgo -p tsconfig.build.json \
  && cd /opt/pi/packages/coding-agent \
  && ../../node_modules/.bin/tsgo -p tsconfig.build.json \
  && npm run copy-assets

WORKDIR /opt/lossless-claw

COPY vendor/lossless-claw/package.json vendor/lossless-claw/package-lock.json vendor/lossless-claw/tsconfig.json vendor/lossless-claw/index.ts /opt/lossless-claw/
COPY vendor/lossless-claw/src /opt/lossless-claw/src

RUN mkdir -p /opt/lossless-claw/node_modules \
  && ln -s /opt/pi/node_modules/@earendil-works /opt/lossless-claw/node_modules/@earendil-works

RUN useradd --create-home --shell /bin/bash beep

WORKDIR /runtime

COPY runtime/ /runtime/

RUN mkdir -p /workspace /lcm /history /state \
  && chmod +x /runtime/bin/* \
  && chown -R beep:beep /runtime /workspace /lcm /history /state /opt/pi /opt/lossless-claw

USER beep

CMD ["node", "/runtime/src/smoke-runtime.mjs"]
