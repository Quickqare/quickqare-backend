/**
 * 🔴 dotenv MUST be first
 */
require("dotenv").config();

const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");

const { setSocketIO } = require("./socket/emitters");
const { ensureBootstrapAdmin } = require("./services/adminBootstrap.service");
const { initCronJobs } = require("./services/cron.service");

const Booking = require("./models/Booking");
const Partner = require("./models/Partner");

const app = express();

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
const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    const isConfiguredOrigin = allowedOrigins.includes(origin);
    const isLocalOrigin =
      /^http:\/\/localhost:\d+$/.test(origin) ||
      /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
    const isNetlifyOrigin =
      /^https:\/\/[a-zA-Z0-9-]+\.netlify\.app$/.test(origin) ||
      /^https:\/\/[a-zA-Z0-9-]+\.netlify\.live$/.test(origin);
    const isQuickQareOrigin =
      /^https:\/\/[a-zA-Z0-9-]+\.quickqare\.in$/.test(origin);

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

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

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
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("MongoDB connected");
    try {
      await ensureBootstrapAdmin();
    } catch (error) {
      console.error("[admin-bootstrap] failed:", error);
    }
    initCronJobs();
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
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
app.use("/api/coupons", require("./routes/coupon.routes"));
app.use("/api/coupon", require("./routes/coupon.routes"));
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
const jwt = require("jsonwebtoken");
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next();
  try {
    const partnerSecret = process.env.PARTNER_JWT_SECRET || process.env.JWT_SECRET;
    const userSecret = process.env.JWT_SECRET;
    let payload;
    try { payload = jwt.verify(token, partnerSecret); } catch (_) {
      try { payload = jwt.verify(token, userSecret); } catch (__) { return next(); }
    }
    // Partner tokens are signed { id, role: "partner" } — check role+id first,
    // then fall back to a legacy partnerId field if ever used.
    if (payload?.role === "partner" && (payload?.id || payload?.partnerId)) {
      socket.verifiedPartnerId = String(payload?.id || payload?.partnerId);
    } else if (payload?.userId || payload?.sub) {
      socket.verifiedUserId = String(payload?.userId || payload?.sub);
    }
  } catch (_) { /* non-fatal — allow unauthenticated */ }
  next();
});

// Short-lived dedup set: prevents double-fire of acceptJob on flaky networks.
// Key = `${partnerId}:${bookingId}`, cleared after 5 s.
const acceptJobDedup = new Set();

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
  ====================== */
  socket.on("acknowledgeJob", async ({ bookingId }) => {
    try {
      if (!socket.partnerId) {
        socket.emit("error", { event: "acknowledgeJob", message: "Authentication required" });
        return;
      }

      const booking = await Booking.findById(bookingId).select("partner status user");
      if (!booking) return;

      const pid = String(socket.partnerId);
      const isAssigned = booking.partner?.toString() === pid;
      if (!isAssigned) {
        socket.emit("error", { event: "acknowledgeJob", message: "Not assigned to this booking" });
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

      console.log(`[ack] Booking ${bookingId} acknowledged by partner ${pid}`);
    } catch (err) {
      console.error("acknowledgeJob error:", err);
    }
  });

  /* ======================
     PARTNER ACCEPT JOB
     ASSIGNED or CONFIRMED → PARTNER_ACCEPTED
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

      const booking = await Booking.findById(bookingId);
      if (!booking) return;

      if (!["ASSIGNED", "CONFIRMED"].includes(booking.status)) return;

      const pid = String(socket.partnerId);
      const isAssigned =
        booking.partner?.toString() === pid ||
        (booking.additionalPartners || []).some((p) => p.toString() === pid);
      if (!isAssigned) {
        socket.emit("error", { event: "acceptJob", message: "Not assigned to this booking" });
        return;
      }

      booking.ackReceivedAt = booking.ackReceivedAt ?? new Date();
      booking.status = "PARTNER_ACCEPTED";
      await booking.save();

      const { cancelAckTimeout } = require("./services/ackTimeout.service");
      await cancelAckTimeout(bookingId);

      await Partner.findByIdAndUpdate(socket.partnerId, {
        $inc: { activeJobs: 1 },
      });

      io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: booking._id.toString(),
        status: "PARTNER_ACCEPTED",
      });

      io.to(`partner_${socket.partnerId}`).emit("job_accepted_confirmation", {
        bookingId: booking._id.toString(),
      });

      console.log(`[socket] Booking ${bookingId} accepted by partner ${pid}`);
    } catch (err) {
      console.error("acceptJob error:", err);
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

      const booking = await Booking.findById(bookingId).select("status partner additionalPartners user");
      if (!booking) return;

      if (!["ASSIGNED", "CONFIRMED"].includes(booking.status)) return;

      const pid = String(socket.partnerId);
      const isAssigned =
        booking.partner?.toString() === pid ||
        (booking.additionalPartners || []).some((p) => p.toString() === pid);
      if (!isAssigned) {
        socket.emit("error", { event: "rejectJob", message: "Not assigned to this booking" });
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

      console.log(`[socket] Booking ${bookingId} rejected by partner ${pid}, reassigning`);
    } catch (err) {
      console.error("rejectJob error:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});

/* ======================
   START SERVER
====================== */

const PORT = process.env.PORT || 4000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
