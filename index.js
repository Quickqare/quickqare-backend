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
const { assignBooking } = require("./services/assignmentEngine");
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

    if (isConfiguredOrigin || isLocalOrigin) {
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
    if (payload?.partnerId) socket.verifiedPartnerId = String(payload.partnerId);
    if (payload?.userId || payload?.sub) socket.verifiedUserId = String(payload?.userId || payload?.sub);
  } catch (_) { /* non-fatal — allow unauthenticated */ }
  next();
});

io.on("connection", (socket) => {

  /* ======================
     USER ROOM
  ====================== */
  socket.on("joinUserRoom", (userId) => {
    if (socket.verifiedUserId && socket.verifiedUserId !== String(userId)) return;
    socket.join(`user_${userId}`);
  });

  /* ======================
     PARTNER ROOM
  ====================== */
  socket.on("joinPartnerRoom", (partnerId) => {
    // If the handshake token was verified, only allow joining the correct room.
    if (socket.verifiedPartnerId && socket.verifiedPartnerId !== String(partnerId)) return;
    socket.join(`partner_${partnerId}`);
    socket.partnerId = String(partnerId);
  });

  /* ======================
     PARTNER ACCEPT JOB
     ASSIGNED → PARTNER_ACCEPTED
  ====================== */
  socket.on("acceptJob", async ({ bookingId }) => {
    try {
      if (!socket.partnerId) return;

      const booking = await Booking.findById(bookingId);
      if (!booking) return;

      if (booking.status !== "ASSIGNED") return;

      // Verify this partner is actually assigned to this booking —
      // prevents a spoofed partnerId from accepting someone else's job.
      const pid = String(socket.partnerId);
      const isAssigned =
        booking.partner?.toString() === pid ||
        (booking.additionalPartners || []).some((p) => p.toString() === pid);
      if (!isAssigned) return;

      booking.status = "PARTNER_ACCEPTED";
      // partner field already set by assignment engine — do not overwrite
      await booking.save();

      // increase partner load
      await Partner.findByIdAndUpdate(socket.partnerId, {
        $inc: { activeJobs: 1 },
      });

      // notify user
      io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: booking._id.toString(),
        status: "PARTNER_ACCEPTED",
      });

      // confirm to partner
      io.to(`partner_${socket.partnerId}`).emit(
        "job_accepted_confirmation",
        {
          bookingId: booking._id.toString(),
        }
      );

      console.log("✅ Booking accepted:", bookingId);
    } catch (err) {
      console.error("acceptJob error:", err);
    }
  });

  /* ======================
     PARTNER REJECT JOB
     → SEARCHING → REASSIGN
  ====================== */
  socket.on("rejectJob", async ({ bookingId }) => {
    try {
      if (!socket.partnerId) return;

      const booking = await Booking.findById(bookingId);
      if (!booking) return;

      if (booking.status !== "ASSIGNED") return;

      // Verify this partner is actually assigned before allowing rejection.
      const pid = String(socket.partnerId);
      const isAssigned =
        booking.partner?.toString() === pid ||
        (booking.additionalPartners || []).some((p) => p.toString() === pid);
      if (!isAssigned) return;

      booking.status = "SEARCHING";
      booking.partner = null;

      // prevent reassigning same partner
      booking.rejectedPartners.push(socket.partnerId);

      await booking.save();

      // notify user
      io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: booking._id.toString(),
        status: "SEARCHING",
      });

      // re-run assignment engine
      await assignBooking(booking._id);

      console.log("🔄 Booking reassigned:", bookingId);
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
