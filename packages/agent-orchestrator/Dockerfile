# syntax=docker/dockerfile:1
# Build context is the REPO ROOT (pnpm workspace root), not this directory:
#   docker build -f packages/agent-orchestrator/Dockerfile .
FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Honours "packageManager": "pnpm@11.1.3" from the root package.json.
RUN corepack enable
WORKDIR /repo

FROM base AS build
# CI=true is REQUIRED: without it, the `--prod` prune step below dies with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY.
ENV CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/agent-orchestrator/package.json packages/agent-orchestrator/package.json
RUN pnpm install --frozen-lockfile --filter @apo/agent-orchestrator...
COPY packages/agent-orchestrator/tsconfig.json packages/agent-orchestrator/tsconfig.json
COPY packages/agent-orchestrator/src packages/agent-orchestrator/src
RUN pnpm --filter @apo/agent-orchestrator build
RUN pnpm install --frozen-lockfile --filter @apo/agent-orchestrator... --prod

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages/agent-orchestrator/node_modules /repo/packages/agent-orchestrator/node_modules
COPY --from=build /repo/packages/agent-orchestrator/package.json /repo/packages/agent-orchestrator/package.json
COPY --from=build /repo/packages/agent-orchestrator/dist /repo/packages/agent-orchestrator/dist
COPY packages/agent-orchestrator/drizzle /repo/packages/agent-orchestrator/drizzle
WORKDIR /repo/packages/agent-orchestrator
USER node
EXPOSE 3200
CMD ["node", "dist/main.js"]
