FROM node:20-slim

# Install ffmpeg + curl (yt-dlp needs curl to download)
RUN apt-get update && apt-get install -y \
    ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp Linux binary (replaces yt-dlp.exe on Windows)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
# --ignore-scripts prevents youtube-dl-exec from downloading its own binary
RUN npm ci --omit=dev --ignore-scripts

COPY . .

RUN mkdir -p downloads/subs downloads/audio_tmp

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=ffmpeg

EXPOSE 5000

CMD ["node", "server.js"]
