FROM node:16-bullseye

ARG TINI_VER="v0.19.0"

# install tini
ADD https://github.com/krallin/tini/releases/download/$TINI_VER/tini /sbin/tini
RUN chmod +x /sbin/tini

# install sqlite3
# Bullseye security packages 404; install from the main archive.
RUN sed -i '/debian-security/d' /etc/apt/sources.list                \
 && apt-get update                                                   \
 && apt-get install    --quiet --yes --no-install-recommends sqlite3 \
 && apt-get clean      --quiet --yes                                 \
 && apt-get autoremove --quiet --yes                                 \
 && rm -rf /var/lib/apt/lists/*

# Install dependencies before copying the app so edits to servers.json,
# HTML, and other source files do not rebuild native modules.
WORKDIR /usr/src/minetrack
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# run as non root
# RUN addgroup --gid 10043 --system minetrack \
#  && adduser  --uid 10042 --system --ingroup minetrack --no-create-home --gecos "" minetrack \
#  && chown -R minetrack:minetrack /usr/src/minetrack
# USER minetrack

EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--", "node", "main.js"]
