# Linux image for the container test tier: bun, node, git, and every tier-1 harness CLI that
# installs from npm without credentials. Nothing here is a secret; the runner mounts the
# repository read-only at /repo and the entrypoint copies it to a writable /work per run.
#
# Base images are pinned to exact tags. bun 1.4.2 matches .bun-version; node 22.23.2 is the
# current 22.x line. Bump both tags together with the repository toolchain.
FROM oven/bun:1.4.2-debian AS bun

FROM node:22.23.2-bookworm-slim

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Harness CLIs, versions as published on npm on 2026-09-20. Each installs anonymously; the two
# postinstall scripts (claude-code, opencode-ai) only unpack the platform binary shipped as an
# optional dependency. Cursor, Cline, and dsh have no anonymous npm install, so they are absent.
RUN npm install -g \
  @anthropic-ai/claude-code@2.1.278 \
  @openai/codex@0.155.1 \
  @google/gemini-cli@0.60.0 \
  @github/copilot@1.0.86 \
  opencode-ai@1.18.31 \
  && npm cache clean --force

# The repository's dependencies are installed once at build time because runs have no network.
# The entrypoint links this directory into /work.
COPY package.json bun.lock /deps/
RUN cd /deps && bun install --frozen-lockfile

# useradd without --create-home so HOME starts empty: no skeleton dotfiles, nothing a harness
# could read as prior configuration.
RUN useradd --uid 1001 --no-create-home --home-dir /home/tester --shell /bin/sh tester \
  && mkdir -p /home/tester /work \
  && chown tester:tester /home/tester /work /deps /deps/node_modules

COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 755 /usr/local/bin/entrypoint

USER tester
ENV HOME=/home/tester
WORKDIR /work
ENTRYPOINT ["entrypoint"]
CMD ["bun", "run", "test"]
