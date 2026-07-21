# Pinned to a specific patch release for reproducible builds (the floating
# `node:20-alpine` tag silently moves to a new Node/Alpine patch on every rebuild).
#
# HARDEN FURTHER (recommended before launch): pin by immutable digest so a
# compromised/retagged upstream can't slip in, and scan the image in CI:
#   docker buildx imagetools inspect node:20.18.1-alpine   # copy the sha256 digest
#   FROM node:20.18.1-alpine@sha256:<digest>
#   docker scout cves <image>        # or: trivy image <image>
FROM node:20.18.1-alpine

# All calendar-day business logic (cake minLeadDays, baker daily caps,
# partner unavailableDates) uses server-local time. Alpine defaults to UTC,
# which shifts "today"/"tomorrow" by 5.5h for IST customers — e.g. between
# midnight and 05:30 IST a UTC clock still says "yesterday", letting same-day
# cake orders through the advance-only gate. tzdata makes the zone available
# to the OS; TZ makes Node's Date use it.
RUN apk add --no-cache tzdata
ENV TZ=Asia/Kolkata

WORKDIR /app

# Install prod deps first for better Docker layer caching.
# .npmrc (omit=optional) MUST be copied before npm ci runs, or the image would
# pull in firebase-admin's optional @google-cloud/firestore|storage deps and
# their vulnerable transitive chain back in (see .npmrc for why).
#
# --omit=optional is ALSO passed explicitly here, not left to .npmrc alone:
# npm's CLI --omit flag replaces the config value instead of merging with it,
# so `npm ci --omit=dev` on its own silently re-installs the optional deps
# .npmrc was supposed to exclude (verified empirically — do not remove either
# --omit flag).
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --omit=optional

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

