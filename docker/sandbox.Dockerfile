FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV BEEP_SANDBOX_WORKSPACE=/workspace
ENV HOME=/home/beep
ENV TMPDIR=/tmp
ENV PATH=/runtime/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
    jq \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash beep

WORKDIR /runtime

COPY runtime/bin/beep-sandbox-tool-runner /runtime/bin/beep-sandbox-tool-runner
COPY runtime/src/sandbox-tool-executor.mjs /runtime/src/sandbox-tool-executor.mjs
COPY runtime/src/sandbox-tool-protocol.mjs /runtime/src/sandbox-tool-protocol.mjs

RUN chmod 0555 /runtime /runtime/bin /runtime/src \
  && chmod 0555 /runtime/bin/beep-sandbox-tool-runner \
  && chmod 0444 /runtime/src/sandbox-tool-executor.mjs /runtime/src/sandbox-tool-protocol.mjs \
  && mkdir -p /workspace \
  && chown -R beep:beep /workspace /home/beep

USER beep
WORKDIR /workspace

CMD ["sleep", "infinity"]
