# ---- build stage: compile the frontend bundle ----
FROM node:22-trixie-slim AS build

WORKDIR /usr/src/minetrack
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- runtime stage: production deps + built assets only ----
FROM node:22-trixie-slim

# Coolify's HTTP health check runs curl/wget inside the container and the slim
# image ships neither.
RUN apt-get update \
 && apt-get install --quiet --yes --no-install-recommends curl \
 && apt-get clean --quiet --yes \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/minetrack
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
COPY --from=build /usr/src/minetrack/dist ./dist

EXPOSE 8080

# Container-level health check for plain docker/compose; uses node so it has no extra deps.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# PID 1 signal handling is provided by `init: true` in docker-compose.yml
# (or `docker run --init`), so no tini install is needed in the image.
CMD ["node", "main.js"]
