FROM node:20-alpine

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

