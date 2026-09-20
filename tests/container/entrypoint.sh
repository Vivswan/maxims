#!/bin/sh
# The copy goes through a temp archive rather than a pipe: a file the container user cannot read
# makes the producing tar fail, and only an unpiped failure stops the run under set -e.
# node_modules is excluded because the host's may hold binaries for another platform; the image's
# own install, resolved from the same lockfile, is linked in instead. .env, .claude, and .git stay
# on the host: a developer's checkout carries a token file there, one worktree per open branch,
# and a history no test reads.
# The two directories are overridable so the copy can run against a fixture tree without a
# container (tests/container/entrypoint.test.ts).
set -eu

repo=${ENTRYPOINT_REPO:-/repo}
work=${ENTRYPOINT_WORK:-/work}

if [ -d "$repo" ]; then
  archive=$(mktemp)
  tar -C "$repo" \
    --exclude=./node_modules --exclude=./dist \
    --exclude=./.env --exclude=./.claude --exclude=./.git \
    -cf "$archive" .
  tar -C "$work" -xf "$archive"
  rm -f "$archive"
  ln -s /deps/node_modules "$work/node_modules"
fi

exec "$@"
