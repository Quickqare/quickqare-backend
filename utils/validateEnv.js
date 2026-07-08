const logger = require("./logger");

// Boot-time environment validation. Split by blast radius:
//
//   REQUIRED    — the app is non-functional without these, so refuse to start.
//                 Better to fail the deploy with a clear message than to boot
//                 "healthy" and 500 the first customer who logs in.
//   RECOMMENDED — each gates ONE feature that already fails closed in its own
//                 handler (payments, OTP). Missing = warn loudly but keep
//                 serving the rest of the API, so e.g. a missing payment key
//                 doesn't take down browsing/booking.
//
// Admin JWT secrets are validated separately by admin/utils/tokens
// (assertAdminSecrets) which has its own must-differ rules.
const REQUIRED = ["MONGO_URI", "JWT_SECRET"];
const RECOMMENDED = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "MSG91_AUTH_KEY",
  "MSG91_TEMPLATE_ID",
];

const isBlank = (value) => !value || !String(value).trim();

// Returns nothing; exits the process if a REQUIRED var is missing.
const validateEnv = () => {
  const missingRecommended = RECOMMENDED.filter((key) => isBlank(process.env[key]));
  if (missingRecommended.length) {
    logger.warn(
      "[env] Missing recommended config — the related feature will fail until it is set: " +
        missingRecommended.join(", ")
    );
  }

  const missingRequired = REQUIRED.filter((key) => isBlank(process.env[key]));
  if (missingRequired.length) {
    logger.error(
      "[env] FATAL — required environment variable(s) missing: " +
        missingRequired.join(", ") +
        ". Refusing to start."
    );
    process.exit(1);
  }

  logger.info("[env] Required configuration present");
};

module.exports = { validateEnv, REQUIRED, RECOMMENDED };
