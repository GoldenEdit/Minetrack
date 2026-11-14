# ---- build stage: compile the frontend bundle ----
FROM node:22-bookworm-slim AS build

WORKDIR /usr/src/minetrack
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- runtime stage: production deps + built assets only ----
FROM node:22-bookworm-slim

# tini for signal handling/zombie reaping, sqlite3 CLI for debugging
RUN apt-get update \
 && apt-get install --quiet --yes --no-install-recommends tini sqlite3 \
 && apt-get clean --quiet --yes \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/minetrack
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
COPY --from=build /usr/src/minetrack/dist ./dist

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "node", "main.js"]
