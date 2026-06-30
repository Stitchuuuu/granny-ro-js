# granny-ro-js — portable test environment.
#
# Default `npm test` (the JS-only contract + unit tests) needs zero host
# setup ; the image bakes in Node 20 LTS, Wine + qemu-i386 (cross-arch
# DLL load), and mingw-w64 (shim build).
#
# Full live wine path (`npm run bake + test:live`) additionally needs
# the user's `data.grf` + `granny2.dll` mounted via docker-compose
# (see docker-compose.yml + .env.example).
#
# Image rebuild cost : ~2 min cold (mostly apt), seconds warm.
# Works on amd64 and aarch64 hosts.

FROM node:20.18.1-bookworm-slim

# i386 arch for 32-bit Wine + qemu-user-static for cross-arch on aarch64.
RUN dpkg --add-architecture i386 \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        wine \
        wine32:i386 \
        qemu-user-static \
        binfmt-support \
        gcc-mingw-w64-i686 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /granny-ro-js

# Two-step COPY for layer caching : deps first, then source.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build the Wine shims from vendored MIT C source. The matching
# granny2.dll is RAD copyright and is NOT in the image — it's supplied
# at runtime via the RO_FOLDER mount (see docker-compose.yml).
#   - gr2_decompress.exe    section-level Oodle0 decode
#   - gr2_igc_export.exe    IGC texture bake
RUN mkdir -p /shim \
    && i686-w64-mingw32-gcc -static -O2 -o /shim/gr2_decompress.exe shim/gr2_decompress.c \
    && i686-w64-mingw32-gcc -static -O2 -o /shim/gr2_igc_export.exe  shim/gr2_igc_export.c

ENV GR2_DECOMPRESS_EXE=/shim/gr2_decompress.exe \
    GR2_IGC_EXPORT_EXE=/shim/gr2_igc_export.exe

CMD ["npm", "test"]
