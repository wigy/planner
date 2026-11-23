# The UI is built in the first stage. The server runs its TypeScript directly and
# needs only its one runtime dependency (rrule) from node_modules.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server server
COPY shared shared
COPY --from=build /app/dist dist
# Mount the data directory here. The node user is uid 1000, so files it writes
# into a bind mount stay owned by the host user of the same uid.
ENV PLANNER_DATA=/data NODE_NO_WARNINGS=1
USER node
EXPOSE 8920
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8920/health || exit 1
CMD ["node", "server/index.ts"]
