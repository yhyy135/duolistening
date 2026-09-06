# Two stages, because the frontend build needs Vite and the runtime does not.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-slim
WORKDIR /app

# ffmpeg/ffprobe measure, cut and normalise audio; yt-dlp fetches it from YouTube.
# yt-dlp ships a self-contained build, which keeps Python out of the image — it is
# also the fastest-moving dependency here, so pin it and bump deliberately.
ARG YT_DLP_VERSION=2026.08.19
# TARGETARCH comes from the builder; yt-dlp names its two Linux builds differently.
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates curl; \
    case "${TARGETARCH}" in \
      amd64) asset=yt-dlp_linux ;; \
      arm64) asset=yt-dlp_linux_aarch64 ;; \
      *) echo "no yt-dlp build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${asset}"; \
    chmod 755 /usr/local/bin/yt-dlp; \
    yt-dlp --version; \
    apt-get purge -y curl; apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The server is run straight from TypeScript (Node strips the types), so the sources
# are the program — dist/web is only the browser half.
COPY tsconfig.json ./
COPY src ./src
COPY --from=build /app/dist ./dist

# Everything that outlives the container. Mount a volume here, or point
# DUOLISTENING_S3_BUCKET at a bucket and this stays empty.
ENV DUOLISTENING_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000
CMD ["node", "src/server/main.ts"]
