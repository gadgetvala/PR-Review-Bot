# The review sandbox.
#
# Holds the pull request code and a Claude credential. Deliberately holds no
# GitHub token, no cloud credential and no host mount beyond the throwaway
# workspace, which is what makes it safe to run the repository's own scripts.
FROM node:24-slim

# git for the diff; ripgrep because Claude Code's search is far slower without
# it; ca-certificates for the model API.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@latest \
  && npm cache clean --force

# Never run the agent as root: `--permission-mode bypassPermissions` refuses to
# start as root, and a rogue postinstall script should not own the container.
USER node

ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    CI=1 \
    HOME=/home/node

# The repository under review is mounted at /work/repo. cwd stays outside it so
# a CLAUDE.md added by the pull request is never auto-discovered as
# instructions for the agent reviewing that pull request.
WORKDIR /work/review

# No ENTRYPOINT: the runner passes the full `sh -c <script>` command, and an
# entrypoint would wrap it into `sh -c sh -c <script>`.
CMD ["claude", "--version"]
