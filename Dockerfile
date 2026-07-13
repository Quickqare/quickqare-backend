# Pinned to a specific patch release for reproducible builds (the floating
# `node:20-alpine` tag silently moves to a new Node/Alpine patch on every rebuild).
#
# HARDEN FURTHER (recommended before launch): pin by immutable digest so a
# compromised/retagged upstream can't slip in, and scan the image in CI:
#   docker buildx imagetools inspect node:20.18.1-alpine   # copy the sha256 digest
#   FROM node:20.18.1-alpine@sha256:<digest>
#   docker scout cves <image>        # or: trivy image <image>
FROM node:20.18.1-alpine

WORKDIR /app

# Install prod deps first for better Docker layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Run as the built-in non-root `node` user (uid 1000) so a compromise of the
# app process can't act as root inside the container. Ensure the app dir —
# including the optional local uploads dir used when USE_LOCAL_UPLOADS=true —
# is owned by node so it can still write there.
RUN mkdir -p uploads && chown -R node:node /app

ENV NODE_ENV=production

# Backend uses PORT from .env (default in your .env.example is 4000)
EXPOSE 4000

USER node

# Run node directly (not "npm start") so Node is PID 1 and receives Docker's
# SIGTERM directly on `docker stop` / redeploy — npm as PID 1 is known to not
# reliably forward signals to the child process it spawns, which would prevent
# the graceful-shutdown handler in index.js from ever running.
CMD ["node", "index.js"]

