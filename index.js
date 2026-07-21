/**
 * 🔴 dotenv MUST be first
 */
require("dotenv").config();

const logger = require("./utils/logger");
const { validateEnv } = require("./utils/validateEnv");

/**
 * Process-level safety nets — must be registered before any async code.
 * Prevents Node.js 15+ from crashing the entire process on an unhandled
 * promise rejection (e.g. from a cron job, socket handler, or service).
 * PM2 autorestart is a last resort, not a substitute for catching these.
 */
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Promise Rejection", { reason: String(reason), stack: reason?.stack });
  // Do NOT call process.exit() — log and keep the server alive.
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception — exiting for clean PM2 restart", { error: err.message, stack: err.stack });
  // Uncaught exceptions leave the process in an undefined state.
  // Exit so PM2 can restart cleanly rather than running corrupted.
  process.exit(1);
});

// Fail fast on a misconfigured deploy: refuse to boot if core secrets/config
// (MONGO_URI, JWT_SECRET) are missing, instead of serving 500s at first use.
validateEnv();

const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const qs = require("qs");

const { sanitizeMongo, sanitizeInPlace } = require("./middlewares/sanitizeMongo");
const { globalLimiter } = require("./middlewares/rateLimiter");

const { setSocketIO } = require("./socket/emitters");
const { ensureBootstrapAdmin } = require("./services/adminBootstrap.service");
const { initCronJobs } = require("./services/cron.service");
const { notifyCustomerOfBookingStatus } = require("./services/pushNotification.service");

const Booking = require("./models/Booking");
const Partner = require("./models/Partner");

const app = express();

// Validate admin auth secrets at boot. Non-fatal (won't take down the
// customer/partner APIs) — admin login fails closed if these are missing.
require("./admin/utils/tokens").assertAdminSecrets();

const parseAllowedOrigins = () => {
  const raw = String(process.env.CORS_ALLOWED_ORIGINS || "").trim();
  if (!raw) return [];

  const origins = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return origins;
};

const allowedOrigins = parseAllowedOrigins();

const IS_PRODUCTION =
  String(process.env.NODE_ENV || "").toLowerCase() === "production";

// The exact Netlify site slug for this app (e.g. "quickqare-web" for
// quickqare-web.netlify.app), if it's served from Netlify. When set, we trust
// that site and its Netlify deploy previews ("<context>--<slug>.netlify.app"),
// and NOTHING else on netlify.app / netlify.live. When unset (the default), no
// *.netlify.app origin is trusted unless listed explicitly in
// CORS_ALLOWED_ORIGINS.
//
// This replaces a substring match ("*quickqare*.netlify.app") that trusted any
// attacker-registered Netlify site whose name merely contained "quickqare"
// (e.g. quickqare-phish.netlify.app), from which authenticated cross-origin
// requests against this API were possible.
const NETLIFY_SITE_SLUG = String(process.env.NETLIFY_SITE_SLUG || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "");
const netlifyOriginRe = NETLIFY_SITE_SLUG
  ? new RegExp(
      `^https://([a-z0-9-]+--)?${NETLIFY_SITE_SLUG}\\.netlify\\.(app|live)$`,
      "i"
    )
  : null;

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    const isConfiguredOrigin = allowedOrigins.includes(origin);
    // localhost is trusted only outside production (dev machines / CI). In prod,
    // a page an attacker gets running on the victim's own localhost must not be
    // a trusted, credentialed CORS origin.
    const isLocalOrigin =
      !IS_PRODUCTION &&
      (/^http:\/\/localhost:\d+$/.test(origin) ||
        /^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
    const isNetlifyOrigin = netlifyOriginRe ? netlifyOriginRe.test(origin) : false;
    const isQuickQareOrigin =
      /^https:\/\/[a-zA-Z0-9-]+\.quickqare\.in$/.test(origin) ||
      origin === "https://quickqare.in" ||
      origin === "https://www.quickqare.in";

    if (isConfiguredOrigin || isLocalOrigin || isNetlifyOrigin || isQuickQareOrigin) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin ${origin}`));
  },
  credentials: true,
};

/* ======================
   GLOBAL MIDDLEWARE
====================== */

app.set("trust proxy", 1); // important for rate limit + deployment

// Sanitising query parser: parse the query string with qs (Express's default
// "extended" parser) then strip any MongoDB operator ($..) / dotted keys before
// req.query is ever read. Doing it here — not in a middleware — is the only
// effective place, because Express re-derives req.query from the URL on each
// access, so mutating it in a middleware wouldn't stick.
app.set("query parser", (str) => sanitizeInPlace(qs.parse(str)));

app.use(helmet());
app.use(cors(corsOptions));

// Razorpay webhook MUST be mounted before express.json() so its handler
// receives the raw request body — signature verification runs over the exact
// bytes Razorpay sent, which a JSON re-serialize would break.
const { handleRazorpayWebhook } = require("./controllers/razorpayWebhook.controller");
app.post(
  "/api/payment/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  handleRazorpayWebhook
);

app.use(express.json({ limit: "1mb" }));

// NoSQL-injection guard on parsed bodies/params (defense-in-depth). Runs after
// express.json so req.body is populated, and after the raw webhook mount above
// so the webhook's raw Buffer body is never touched.
app.use(sanitizeMongo);

// Global rate-limit floor across the whole API. Per-endpoint limiters
// (auth/OTP/payment/maps) still stack on top with their stricter caps — this is
// only a ceiling that stops a broad flood of otherwise-unlimited endpoints
// (booking, addresses, profile reads, …). Scoped to /api so /health and
// /uploads are never throttled.
app.use("/api", globalLimiter);

// Filenames are timestamp-unique, never rewritten — safe to cache forever.
app.use("/uploads", express.static(path.join(__dirname, "uploads"), { maxAge: "365d", immutable: true }));

app.get("/health", async (_req, res) => {
  const mongoReadyState = mongoose.connection.readyState;
  const isMongoConnected = mongoReadyState === 1;

  res.status(isMongoConnected ? 200 : 503).json({
    success: isMongoConnected,
    status: isMongoConnected ? "ok" : "degraded",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    mongo: {
      connected: isMongoConnected,
      readyState: mongoReadyState,
    },
  });
});

/* ======================
   DATABASE
====================== */

mongoose
  .connect(process.env.MONGO_URI, {
    // Fail a request fast when the DB is unreachable instead of hanging on the
    // 30s default — a slow/blipping Mongo would otherwise pile up requests on
    // the single event loop and cascade into apparent full-app slowness.
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000),
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 45000),
    // Explicit pool bound (Mongoose default is 100). Tunable per deployment.
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 50),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 5),
  })
  .then(async () => {
    logger.info("MongoDB connected");
    try {
      await ensureBootstrapAdmin();
    } catch (error) {
      logger.error("[admin-bootstrap] failed", { error: error.message, stack: error.stack });
    }
    initCronJobs();
  })
  .catch((err) => {
    logger.error("MongoDB connection error — exiting", { error: err.message, stack: err.stack });
    process.exit(1);
  });

/* ======================
   ROUTES
====================== */
app.use("/api/auth", require("./routes/userOtp.routes"));
app.use("/api/user", require("./routes/user.routes"));
app.use("/api/complaints", require("./routes/complaint.routes"));
app.use("/api/referral", require("./routes/referral.routes"));
app.use("/api/booking", require("./routes/booking.routes"));
app.use("/api/partner/auth", require("./routes/partnerAuth.routes"));
app.use("/api/partner", require("./routes/partner.routes"));
app.use("/api/partner", require("./routes/technicianHelper.routes"));
app.use("/api/coupons", require("./routes/coupon.routes"));
app.use("/api/payment", require("./routes/payment.routes"));
app.use("/api/services", require("./routes/service.routes"));
app.use("/api/maps", require("./routes/maps.routes"));
app.use("/api/partner/profile", require("./routes/partnerProfile.routes"));
app.use("/api/zones", require("./routes/zone.routes"));
app.use("/api/upload", require("./routes/uploadRoutes"));
app.use("/api/banners", require("./routes/banner.routes"));
app.use("/api/policies", require("./routes/policy.routes"));
app.use("/api/ratings", require("./routes/rating.routes"));
app.use("/api/app-config", require("./routes/appConfig.routes"));
app.use("/api/addresses", require("./routes/address.routes"));
app.use("/api/offers", require("./routes/offer.routes"));
app.use("/api/v1/admin", require("./admin/routes/v1"));

/* ======================
   ERROR HANDLER
====================== */

const errorHandler = require("./middlewares/errorHandler");
app.use(errorHandler);

/* ======================
   SOCKET.IO SETUP
====================== */

const server = http.createServer(app);

const io = require("socket.io")(server, {
  cors: corsOptions,
});

global.io = io;
setSocketIO(io);

// Optional JWT auth on handshake — clients that send a token get
// socket.verifiedPartnerId / socket.verifiedUserId attached.
// Clients without a token still connect (backward compat).
const { handshakeAuth } = require("./socket/handshakeAuth");
io.use(handshakeAuth);

// Short-lived dedup sets: prevent double-fire of acceptJob / rejectJob on flaky
// networks. Key = `${partnerId}:${bookingId}`, cleared after 5 s.
const acceptJobDedup = new Set();
const rejectJobDedup = new Set();

io.on("connection", (socket) => {

  /* ======================
     USER ROOM
     Require a verified token — unauthenticated clients cannot join user rooms,
     which prevents leaking live partner-location events to unknown listeners.
  ====================== */
  socket.on("joinUserRoom", (userId) => {
    if (!socket.verifiedUserId) return;
    if (socket.verifiedUserId !== String(userId)) return;
    socket.join(`user_${userId}`);
  });

  /* ======================
     PARTNER ROOM
  ====================== */
  socket.on("joinPartnerRoom", (partnerId) => {
    if (!socket.verifiedPartnerId || socket.verifiedPartnerId !== String(partnerId)) return;
    socket.join(`partner_${partnerId}`);
    socket.partnerId = String(partnerId);
  });

  /* ======================
     PARTNER ACKNOWLEDGE JOB
     Additional team members may also send this (previously only the primary
     partner was accepted — a helper/team member's ack got a hard "Not
     assigned" error even though they legitimately hold the job). But only the
     PRIMARY's ack is allowed to flip the shared ackReceivedAt / cancel the ACK
     timer: scheduleAckTimeout is anchored to the primary partner alone
     (assignBooking calls scheduleAckTimeout(booking._id, primaryPartner._id)),
     so letting a team member's ack satisfy that shared field would silently
     suppress the reassignment-on-timeout check for a primary who never
     actually acknowledged. A team member's ack is acknowledged as a courtesy
     no-op instead, mirroring acceptJobCore's non-primary branch.
  ====================== */
  socket.on("acknowledgeJob", async ({ bookingId }) => {
    try {
      if (!socket.partnerId) {
        socket.emit("error", { event: "acknowledgeJob", message: "Authentication required" });
        return;
      }

      const booking = await Booking.findById(bookingId).select(
        "partner additionalPartners status user"
      );
      if (!booking) return;

      const pid = String(socket.partnerId);
      const isPrimary = booking.partner?.toString() === pid;
      const isAdditional = (booking.additionalPartners || []).some(
        (p) => p.toString() === pid
      );
      if (!isPrimary && !isAdditional) {
        socket.emit("error", { event: "acknowledgeJob", message: "Not assigned to this booking" });
        return;
      }

      if (!isPrimary) {
        socket.emit("ack_confirmed", { bookingId: String(bookingId) });
        return;
      }

      await Booking.findByIdAndUpdate(bookingId, { ackReceivedAt: new Date() });

      const { cancelAckTimeout } = require("./services/ackTimeout.service");
      await cancelAckTimeout(bookingId);

      io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: booking._id.toString(),
        status: booking.status,
        partnerAcknowledged: true,
      });

      logger.info("[ack] Booking acknowledged", { bookingId, partnerId: pid });
    } catch (err) {
      logger.error("acknowledgeJob error", { error: err.message, stack: err.stack });
    }
  });

  /* ======================
     PARTNER ACCEPT JOB
     ASSIGNED or CONFIRMED → PARTNER_ACCEPTED
     Delegates to acceptJobCore — the exact function the HTTP accept endpoint
     uses — so the two paths can never diverge (they used to: HTTP → CONFIRMED
     with no ack/timer/push, socket → PARTNER_ACCEPTED with all of them).
     Only the PRIMARY partner's accept flips the booking; a team member's
     accept is acknowledged without changing global state.
  ====================== */
  socket.on("acceptJob", async ({ bookingId }) => {
    try {
      if (!socket.partnerId) {
        socket.emit("error", { event: "acceptJob", message: "Authentication required" });
        return;
      }

      // Dedup: ignore rapid duplicate fires from the same partner+booking
      const dedupKey = `${socket.partnerId}:${bookingId}`;
      if (acceptJobDedup.has(dedupKey)) return;
      acceptJobDedup.add(dedupKey);
      setTimeout(() => acceptJobDedup.delete(dedupKey), 5000);

      const { acceptJobCore } = require("./services/partnerLifecycle.service");
      const result = await acceptJobCore(bookingId, socket.partnerId);

      if (!result.ok && result.code === "NOT_ASSIGNED") {
        socket.emit("error", { event: "acceptJob", message: "Not assigned to this booking" });
        return;
      }
      if (!result.ok) return; // not found / already moved on / race lost — no-op

      if (!result.statusChanged) {
        // Additional team member — confirm receipt without flipping the booking.
        socket.emit("job_accepted_confirmation", { bookingId: String(bookingId) });
        return;
      }

      logger.info("[socket] Booking accepted by partner", {
        bookingId,
        partnerId: String(socket.partnerId),
      });
    } catch (err) {
      logger.error("acceptJob error", { error: err.message, stack: err.stack });
    }
  });

  /* ======================
     PARTNER REJECT JOB
     ASSIGNED or CONFIRMED → SEARCHING → REASSIGN
     Delegates to reassignBooking() so weekly cancel penalty, ack-timeout cancel,
     and operational-state sync are handled in one place.
  ====================== */
  socket.on("rejectJob", async ({ bookingId }) => {
    try {
      if (!socket.partnerId) {
        socket.emit("error", { event: "rejectJob", message: "Authentication required" });
        return;
      }

      // Dedup rapid duplicate fires (same as acceptJob): without it, two
      // rejectJob events racing before the status flips to SEARCHING could both
      // pass the ASSIGNED/CONFIRMED guard below and record two strikes / run two
      // reassignments for one rejection.
      const dedupKey = `${socket.partnerId}:${bookingId}`;
      if (rejectJobDedup.has(dedupKey)) return;
      rejectJobDedup.add(dedupKey);
      setTimeout(() => rejectJobDedup.delete(dedupKey), 5000);

      const booking = await Booking.findById(bookingId).select("status partner additionalPartners user");
      if (!booking) return;

      if (!["ASSIGNED", "CONFIRMED"].includes(booking.status)) return;

      const pid = String(socket.partnerId);
      const isPrimary = booking.partner?.toString() === pid;
      const isAdditional = (booking.additionalPartners || []).some((p) => p.toString() === pid);
      if (!isPrimary && !isAdditional) {
        socket.emit("error", { event: "rejectJob", message: "Not assigned to this booking" });
        return;
      }

      // ADDITIONAL team member rejecting: remove only them — the primary and
      // the rest of the team keep the job. Previously one member's reject
      // released the whole booking (primary included) back to SEARCHING.
      if (!isPrimary) {
        const {
          removeTeamMemberFromBooking,
          recordPartnerStrike,
        } = require("./services/partnerLifecycle.service");
        const removal = await removeTeamMemberFromBooking(
          bookingId,
          socket.partnerId,
          "Rejected team assignment"
        );
        if (removal.removed) {
          await recordPartnerStrike(socket.partnerId, {
            strikes: booking.status === "CONFIRMED" ? 2 : 1,
          });
        }
        logger.info("[socket] Team member rejected assignment — removed from team", {
          bookingId,
          partnerId: pid,
        });
        return;
      }

      // Cancel the pending ACK timeout so reassignBooking isn't called twice (here + ackTimeout)
      try {
        const { cancelAckTimeout } = require("./services/ackTimeout.service");
        await cancelAckTimeout(bookingId);
      } catch (_) { /* non-fatal */ }

      // Notify the customer immediately while reassignment runs in the background
      io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: booking._id.toString(),
        status: "SEARCHING",
      });

      // reassignBooking handles: rejectedPartners push, weekly cancel penalty + auto-suspend,
      // partner operational state sync, and recursive assignBooking call.
      const { reassignBooking } = require("./services/assignmentEngine");
      await reassignBooking(bookingId, socket.partnerId);

      logger.info("[socket] Booking rejected by partner, reassigning", { bookingId, partnerId: pid });
    } catch (err) {
      logger.error("rejectJob error", { error: err.message, stack: err.stack });
    }
  });

  socket.on("disconnect", () => {
    logger.debug("Socket disconnected", { socketId: socket.id });
  });
});

/* ======================
   START SERVER
====================== */

const PORT = process.env.PORT || 4000;

server.listen(PORT, "0.0.0.0", () => {
  logger.info(`Server started`, { port: PORT, env: process.env.NODE_ENV || "development" });
});

/* ======================
   GRACEFUL SHUTDOWN
   Docker sends SIGTERM on `docker stop` / `docker-compose down` / every
   redeploy, then SIGKILL ~10s later if the process hasn't exited. Without this,
   in-flight requests (including a payment verification mid-flight) get cut off
   instantly instead of finishing.
====================== */

let shuttingDown = false;

const gracefulShutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`${signal} received — shutting down gracefully`);

  // Stop accepting new connections; existing requests are allowed to finish.
  server.close(() => {
    logger.info("HTTP server closed");

    io.close(() => {
      mongoose.connection
        .close(false)
        .then(() => {
          logger.info("MongoDB connection closed — shutdown complete");
          process.exit(0);
        })
        .catch((err) => {
          logger.error("Error closing MongoDB connection", { error: err.message });
          process.exit(1);
        });
    });
  });

  // Safety net: if something (a stuck socket, a long-running request) never
  // resolves, force-exit before Docker's SIGKILL would anyway — this way we
  // still log that it happened instead of dying silently.
  setTimeout(() => {
    logger.error("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 10_000).unref();
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown); // Ctrl+C during local development
