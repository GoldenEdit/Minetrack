# ---- build stage: compile the frontend bundle ----
FROM node:22-trixie-slim AS build

WORKDIR /usr/src/minetrack
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- runtime stage: production deps + built assets only ----
FROM node:22-trixie-slim

WORKDIR /usr/src/minetrack
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
COPY --from=build /usr/src/minetrack/dist ./dist

EXPOSE 8080

# PID 1 signal handling is provided by `init: true` in docker-compose.yml
# (or `docker run --init`), so no tini install is needed in the image.
CMD ["node", "main.js"]
