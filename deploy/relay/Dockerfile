# relay 镜像：构建上下文为仓库根目录。
#   docker build -f deploy/relay/Dockerfile .
# 运行阶段保留 relay.mjs 和许可文本，不安装 node_modules。

FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/relay/package.json packages/relay/
RUN pnpm install --frozen-lockfile --filter @claude-remote/relay
COPY packages/relay packages/relay
RUN pnpm --filter @claude-remote/relay build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8790
# relay 从 ../package.json 读版本号，供 /healthz 返回
COPY --from=build /src/packages/relay/package.json ./package.json
COPY --from=build /src/packages/relay/dist/relay.mjs ./dist/relay.mjs
COPY LICENSE ./LICENSE
COPY --from=build /src/packages/relay/node_modules/ws/LICENSE ./licenses/ws-LICENSE
LABEL org.opencontainers.image.licenses="MIT"
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8790/healthz >/dev/null || exit 1
CMD ["node", "dist/relay.mjs"]
