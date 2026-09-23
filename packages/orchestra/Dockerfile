# syntax=docker/dockerfile:1
# Build context is the REPO ROOT (pnpm workspace root), not this directory:
#   docker build -f packages/orchestra/Dockerfile .
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
COPY packages/orchestra/package.json packages/orchestra/package.json
RUN pnpm install --frozen-lockfile --filter @apo/orchestra...
COPY packages/orchestra/tsconfig.json packages/orchestra/tsconfig.json
COPY packages/orchestra/src packages/orchestra/src
RUN pnpm --filter @apo/orchestra build
RUN pnpm install --frozen-lockfile --filter @apo/orchestra... --prod

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages/orchestra/node_modules /repo/packages/orchestra/node_modules
COPY --from=build /repo/packages/orchestra/package.json /repo/packages/orchestra/package.json
COPY --from=build /repo/packages/orchestra/dist /repo/packages/orchestra/dist
COPY packages/orchestra/drizzle /repo/packages/orchestra/drizzle
COPY packages/orchestra/public /repo/packages/orchestra/public
WORKDIR /repo/packages/orchestra
USER node
EXPOSE 3300
CMD ["node", "dist/main.js"]
