# granny-ro-js — portable test environment.
#
# Default `npm test` (80 bake-free tests) needs zero host setup ; the
# image bakes in Node 20 LTS, Wine + qemu-i386 (cross-arch DLL load),
# mingw-w64 (shim build), Python 3 (clean-room oracle), and a pinned
# Rasetsuu/blendergranny checkout.
#
# Full live-oracle path (`npm run bake + test:live`) additionally needs
# the user's `data.grf` + `granny2.dll` mounted via docker-compose
# (see docker-compose.yml + .env.example).
#
# Image rebuild cost : ~3 min cold (mostly apt + git clone), seconds
# warm (cached). Works on amd64 and aarch64 hosts.

FROM node:20.18.1-bookworm-slim

# i386 arch for 32-bit Wine + qemu-user-static for cross-arch on aarch64.
# Package versions are pinned to the bookworm-slim snapshot at image
# build time ; bump by re-running `apt-cache madison <pkg>` inside a
# fresh `node:20.18.1-bookworm-slim` shell.
RUN dpkg --add-architecture i386 \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        wine \
        wine32:i386 \
        qemu-user-static \
        binfmt-support \
        gcc-mingw-w64-i686 \
        python3 \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin the blendergranny revision so the Python oracle is reproducible.
# Bump deliberately (not from `main`) — historical sections may stop
# decoding correctly if upstream changes the bit-packing convention.
ARG BLENDERGRANNY_SHA=aec91bbd8e244d82277d1f5435dc20feff3086f9
RUN git clone https://github.com/Rasetsuu/blendergranny /blendergranny \
    && cd /blendergranny \
    && git checkout ${BLENDERGRANNY_SHA} \
    && rm -rf .git

WORKDIR /granny-ro-js

# Two-step COPY for layer caching : deps first, then source.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build the Wine shim from vendored MIT C source. The matching
# granny2.dll is RAD copyright and is NOT in the image — it's supplied
# at runtime via the RO_FOLDER mount (see docker-compose.yml).
RUN mkdir -p /shim \
    && i686-w64-mingw32-gcc -static -O2 -o /shim/gr2_decompress.exe shim/gr2_decompress.c

ENV BLENDERGRANNY_PATH=/blendergranny \
    GR2_DECOMPRESS_EXE=/shim/gr2_decompress.exe

CMD ["npm", "test"]
