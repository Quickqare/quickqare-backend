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
