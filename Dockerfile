# 单阶段构建：node:20-slim 内完成 TypeScript 编译，产出单一容器即可对外应答
FROM node:20-slim

WORKDIR /app

# 先装依赖，利用层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝源码并编译到 dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 运行期不再需要开发依赖与测试代码，清理掉
RUN npm prune --omit=dev && npm cache clean --force

# 时变负荷层的持久化目录（JSON 文件存储）。
# 镜像内预置目录并交给 node 用户，挂载卷后数据可在容器重建后保留：
#   docker volume create mm1k-data
#   docker run --rm -p 8080:8080 \
#     -v mm1k-data:/app/data \
#     -e DATA_DIR=/app/data mm1k-capacity-service
# 不挂载时数据写在容器临时层，容器删除即丢失（老的三个接口本来就无状态）。
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
ENV DATA_DIR=/app/data

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "dist/server.js"]
