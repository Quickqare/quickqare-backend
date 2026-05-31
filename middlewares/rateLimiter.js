const rateLimit = require("express-rate-limit");

/* =====================================================
   GENERAL API LIMITER
   Protects all APIs from abuse
===================================================== */
exports.apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // limit each IP

  standardHeaders: true, // send RateLimit headers
  legacyHeaders: false, // disable X-RateLimit headers

  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many requests. Please slow down.",
    });
  },
});

/* =====================================================
   AUTH LIMITER (LOGIN / OTP / REGISTER)
   Strong protection against brute force
===================================================== */
exports.authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,

  standardHeaders: true,
  legacyHeaders: false,

  // don't count successful requests (only failed attempts)
  skipSuccessfulRequests: true,

  message: {
    success: false,
    message: "Too many login attempts. Try again later.",
  },

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many authentication attempts. Try later.",
    });
  },
});

/* =====================================================
   PER-PHONE OTP LIMITER
   Prevents SMS bombing / MSG91 bill abuse.
   Keyed on the phone number from the request body,
   independent of IP — rotating IPs can't bypass it.

   Rules:
     - Max 1 OTP per 60 seconds per phone number
     - Max 5 OTPs per hour per phone number

   NOTE: Uses express-rate-limit's default in-memory
   store, which is per-process. Fine for a single
   Docker container. If you ever run multiple replicas,
   swap to a Redis store (rate-limit-redis).
===================================================== */
exports.phoneOtpLimiter = rateLimit({
  windowMs: 60 * 1000, // 60-second cooldown window
  max: 1,              // max 1 OTP per 60 seconds per phone

  standardHeaders: true,
  legacyHeaders: false,

  keyGenerator: (req) => {
    // Normalise: strip spaces, leading +, ensure string so
    // an empty/missing phone falls back to IP (authLimiter catches it anyway).
    const phone = String(req.body?.phone || "").replace(/\s+/g, "").replace(/^\+/, "");
    return phone || req.ip;
  },

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Please wait 60 seconds before requesting another OTP.",
    });
  },
});

// Secondary hourly cap — prevents someone retrying every 60s for hours.
exports.phoneOtpHourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                    // max 5 OTPs per phone per hour

  standardHeaders: true,
  legacyHeaders: false,

  keyGenerator: (req) => {
    const phone = String(req.body?.phone || "").replace(/\s+/g, "").replace(/^\+/, "");
    return `hourly:${phone || req.ip}`;
  },

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many OTP requests for this number. Try again in an hour.",
    });
  },
});
