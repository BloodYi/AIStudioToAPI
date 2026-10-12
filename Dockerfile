# Single-stage build with Node.js 24
FROM node:24-slim

ARG TARGETARCH
ARG MIHOMO_VERSION=v1.19.31
ARG MIHOMO_SHA256_AMD64=04cf9f09671704f839ddbee2e93069dc831a4123a75281e725d1d96ab9ac1afc
ARG MIHOMO_SHA256_ARM64=9e0f11afbf38426b8bd88fdc594678f8161c57eccb4e1b77acb12b493904f1d4

WORKDIR /app

# Install system dependencies required for Playwright/Camoufox browser, VNC, and dev tools (git)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xvfb \
    x11vnc \
    websockify \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install a pinned Mihomo release for both supported image architectures.
RUN case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
        amd64) MIHOMO_ASSET="mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz"; MIHOMO_SHA256="${MIHOMO_SHA256_AMD64}" ;; \
        arm64) MIHOMO_ASSET="mihomo-linux-arm64-${MIHOMO_VERSION}.gz"; MIHOMO_SHA256="${MIHOMO_SHA256_ARM64}" ;; \
        *) echo "Unsupported Mihomo architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${MIHOMO_ASSET}" -o /tmp/mihomo.gz \
    && echo "${MIHOMO_SHA256}  /tmp/mihomo.gz" | sha256sum -c - \
    && gzip -dc /tmp/mihomo.gz > /usr/local/bin/mihomo \
    && chmod 0755 /usr/local/bin/mihomo \
    && mkdir -p /usr/share/licenses/mihomo \
    && curl -fsSL "https://raw.githubusercontent.com/MetaCubeX/mihomo/${MIHOMO_VERSION}/LICENSE" -o /usr/share/licenses/mihomo/LICENSE \
    && printf '%s\n' "Source: https://github.com/MetaCubeX/mihomo/tree/${MIHOMO_VERSION}" > /usr/share/licenses/mihomo/SOURCE \
    && rm /tmp/mihomo.gz \
    && mihomo -v

# Copy package manifests and install all dependencies (including dev for build tools)
# Layer is cached unless package.json changes
COPY package*.json ./
RUN npm install --no-audit --no-fund --ignore-scripts \
    && npm cache clean --force

# Download and extract Camoufox browser binary
# Layer is cached unless CAMOUFOX_URL argument changes
# Automatically selects architecture-specific binary if URL not provided
ARG CAMOUFOX_URL
RUN ARCH=$(uname -m) && \
    if [ -z "$CAMOUFOX_URL" ]; then \
    if [ "$ARCH" = "x86_64" ]; then \
    CAMOUFOX_URL="https://github.com/daijro/camoufox/releases/download/v135.0.1-beta.24/camoufox-135.0.1-beta.24-lin.x86_64.zip"; \
    elif [ "$ARCH" = "aarch64" ]; then \
    CAMOUFOX_URL="https://github.com/daijro/camoufox/releases/download/v135.0.1-beta.24/camoufox-135.0.1-beta.24-lin.arm64.zip"; \
    else \
    echo "Unsupported architecture: $ARCH" && exit 1; \
    fi; \
    fi && \
    mkdir -p camoufox-linux && \
    curl -sSL ${CAMOUFOX_URL} -o camoufox.zip && \
    unzip -q camoufox.zip -d /tmp/cf || true && \
    if [ -f /tmp/cf/camoufox ]; then \
    mv /tmp/cf/* camoufox-linux/; \
    else \
    mv /tmp/cf/*/* camoufox-linux/; \
    fi && \
    rm -rf /tmp/cf camoufox.zip && \
    chmod +x /app/camoufox-linux/camoufox

# Copy application source code with proper ownership
# Layer is rebuilt when source code changes
COPY --chown=node:node LICENSE ./
COPY --chown=node:node main.js ./
COPY --chown=node:node vite.config.js ./
COPY --chown=node:node vite.public.config.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node configs ./configs
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node ui ./ui
COPY --chown=node:node ui-public ./ui-public

# Build frontend assets with Vite
# VERSION is passed from docker build-args for version display in UI
ARG VERSION
RUN VERSION=${VERSION} npm run build:ui

# Remove dev dependencies after build to reduce image size
RUN npm prune --omit=dev && npm cache clean --force

# TODO: Temporarily use the root user, and in the future we will switch to the node user
USER root

# Expose application ports
EXPOSE 7860 7861

# Configure runtime environment
ENV NODE_ENV=production \
    CHECK_UPDATE=false \
    CAMOUFOX_EXECUTABLE_PATH=/app/camoufox-linux/camoufox \
    MIHOMO_PATH=/usr/local/bin/mihomo

VOLUME ["/app/data"]

# Health check for container orchestration platforms
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "const port = process.env.PORT || 7860; require('http').get('http://localhost:' + port + '/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1));" || exit 1

# Start the application server
CMD ["node", "main.js"]
