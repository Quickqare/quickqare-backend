const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

/* =====================================================
   GLOBAL FLOOR LIMITER
   Applied once to every /api route in index.js as a broad abuse ceiling.
   Deliberately generous (a real user's booking flow, or an admin clicking
   through the dashboard, must never hit it) — the strict controls live in the
   per-endpoint limiters below. Its only job is to stop a scripted flood of the
   many endpoints that would otherwise have no limiter at all.

   NOTE: in-memory store — per process. Fine for a single container; switch to
   rate-limit-redis before running multiple replicas or this silently stops
   working across them.
===================================================== */
exports.globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // Per IP (~66/min sustained at the default). Tunable via env without a code
  // change — raise it if legitimate users behind a shared/carrier-NAT IP ever
  // trip it, lower it to tighten the floor.
  max: Number(process.env.GLOBAL_RATE_LIMIT_MAX || 1000),

  standardHeaders: true,
  legacyHeaders: false,

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many requests. Please slow down.",
    });
  },
});

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
    return phone || ipKeyGenerator(req);
  },

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Please wait 60 seconds before requesting another OTP.",
    });
  },
});

/* =====================================================
   BOOKING CREATE LIMITER (PER USER)
   POST /api/booking/create reserves real slot capacity for ~10 min per
   PENDING_PAYMENT booking. Keyed on the authenticated user (must be mounted
   AFTER userAuth) so a single account can't script a flood of unpaid bookings
   that lock out slot inventory for everyone else. Falls back to IP if req.user
   is somehow absent. Pairs with the per-user concurrent-unpaid cap enforced in
   the createBooking controller.
===================================================== */
exports.bookingCreateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: Number(process.env.BOOKING_CREATE_RATE_LIMIT_MAX || 10),

  standardHeaders: true,
  legacyHeaders: false,

  keyGenerator: (req) =>
    req.user?._id ? `booking-create:${req.user._id}` : ipKeyGenerator(req),

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many booking attempts. Please slow down.",
    });
  },
});

/* =====================================================
   AVAILABLE-SLOTS LIMITER (PER IP)
   GET/POST /api/booking/available-slots is UNAUTHENTICATED and runs a
   per-slot-window partner-eligibility query — the most expensive anonymous
   endpoint in the API. The global floor is too loose to protect it; cap it
   per IP. 60/min comfortably covers a real customer scrubbing through dates.
===================================================== */
exports.slotsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: Number(process.env.SLOTS_RATE_LIMIT_MAX || 60),

  standardHeaders: true,
  legacyHeaders: false,

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many slot lookups. Please slow down.",
    });
  },
});

/* =====================================================
   MAPS LIMITER (REVERSE GEOCODE / ADDRESS SEARCH)
   These routes are unauthenticated and proxy Google Maps
   (billed per request). The controller caches results, but
   an uncached / scripted flood could still run up billing.
   Cap per IP. 30/min comfortably covers a real user typing
   into a debounced address box while blocking abuse.
===================================================== */
exports.mapsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,             // per IP

  standardHeaders: true,
  legacyHeaders: false,

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many location lookups. Please slow down.",
    });
  },
});

/* =====================================================
   PER-PHONE LOGIN LIMITER (PARTNER PASSWORD LOGIN)
   authLimiter is IP-keyed, so an attacker rotating IPs
   could grind one account's password indefinitely. This
   limiter keys on the target phone number instead: the
   account itself locks after too many failed attempts,
   no matter where they come from. Successful logins
   don't count, so a legit partner is never locked out
   by their own typos plus a later correct password.
===================================================== */
exports.phoneLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // max 10 failed logins per phone

  standardHeaders: true,
  legacyHeaders: false,

  skipSuccessfulRequests: true,

  keyGenerator: (req) => {
    const phone = String(req.body?.phone || "").replace(/\s+/g, "").replace(/^\+/, "");
    return `login:${phone || ipKeyGenerator(req)}`;
  },

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many failed login attempts for this account. Try again in 15 minutes.",
    });
  },
});

/* =====================================================
   PER-PHONE OTP VERIFY LIMITER
   authLimiter on /verify-otp is IP-keyed, so an attacker
   rotating IPs could grind a 4-digit OTP (10,000 possible
   codes) for one phone number indefinitely within its
   validity window. This limiter keys on the target phone
   instead, same pattern as phoneLoginLimiter.
   5 attempts caps a brute-force at 5/10,000 (0.05%) odds
   per active OTP while still covering a couple of genuine
   typos. Successful verifications don't count, so a legit
   partner who fumbles once or twice then gets it right is
   never locked out.
===================================================== */
exports.phoneOtpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                   // max 5 failed OTP verify attempts per phone

  standardHeaders: true,
  legacyHeaders: false,

  skipSuccessfulRequests: true,

  keyGenerator: (req) => {
    const phone = String(req.body?.phone || "").replace(/\s+/g, "").replace(/^\+/, "");
    return `otp-verify:${phone || ipKeyGenerator(req)}`;
  },

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many failed OTP attempts for this number. Try again in 15 minutes.",
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
    return `hourly:${phone || ipKeyGenerator(req)}`;
  },

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many OTP requests for this number. Try again in an hour.",
    });
  },
});
