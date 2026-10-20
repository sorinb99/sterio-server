FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg flac ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /data /music && chown node:node /data /music
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
ENV NODE_ENV=production PORT=7766 MUSIC_DIR=/music DATA_DIR=/data
USER node
EXPOSE 7766 7767
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "const c=require('./src/config.mjs').config; const p=c.tlsCert?'https':'http'; fetch(p+'://127.0.0.1:'+c.port+c.basePath+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.mjs"]
