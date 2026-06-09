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
    curl \
    git \
    jq \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash beep

WORKDIR /runtime

COPY runtime/bin/beep-sandbox-tool-runner /runtime/bin/beep-sandbox-tool-runner
COPY runtime/src/sandbox-tool-executor.mjs /runtime/src/sandbox-tool-executor.mjs
COPY runtime/src/sandbox-tool-protocol.mjs /runtime/src/sandbox-tool-protocol.mjs

RUN chmod +x /runtime/bin/beep-sandbox-tool-runner \
  && mkdir -p /workspace \
  && chown -R beep:beep /runtime /workspace /home/beep

USER beep
WORKDIR /workspace

CMD ["sleep", "infinity"]
