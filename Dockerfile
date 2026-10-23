# Build stage: bundle and obfuscate the server into build/ (no source ships).
FROM node:24-trixie-slim AS build
WORKDIR /src
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm install --no-audit --no-fund && node scripts/build.mjs

# Runtime: only the protected build, ffmpeg and flac.
FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg flac ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /data /music && chown node:node /data /music
WORKDIR /app
COPY --from=build --chown=node:node /src/build ./
ENV NODE_ENV=production PORT=7766 MUSIC_DIR=/music DATA_DIR=/data
USER node
EXPOSE 7766 7767
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "src/healthcheck.mjs"]
CMD ["node", "src/index.mjs"]
