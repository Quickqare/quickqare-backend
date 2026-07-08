const jwt = require("jsonwebtoken");

const ACCESS_TTL_SECONDS = Number(process.env.ADMIN_ACCESS_TTL_SECONDS || 900);
const REFRESH_TTL_SECONDS = Number(process.env.ADMIN_REFRESH_TTL_SECONDS || 60 * 60 * 24 * 7);
const CHALLENGE_TTL_SECONDS = Number(process.env.ADMIN_2FA_CHALLENGE_TTL_SECONDS || 300);

// Admin tokens MUST use dedicated secrets. We deliberately do NOT fall back to
// the shared user/partner JWT_SECRET: sharing it would mean a leak of the much
// more widely-exposed user secret could also forge admin tokens. These throw so
// admin auth fails closed — the rest of the API (customer/partner) is unaffected
// because it never calls these.
const getAccessSecret = () => {
  const secret = process.env.ADMIN_JWT_ACCESS_SECRET;
  if (!secret) throw new Error("ADMIN_JWT_ACCESS_SECRET is not configured");
  return secret;
};

const getRefreshSecret = () => {
  const secret = process.env.ADMIN_JWT_REFRESH_SECRET;
  if (!secret) throw new Error("ADMIN_JWT_REFRESH_SECRET is not configured");
  return secret;
};

const signAccessToken = ({ adminUserId, role, sessionId }) => {
  return jwt.sign(
    { type: "access", sub: adminUserId, role, sid: sessionId },
    getAccessSecret(),
    { expiresIn: ACCESS_TTL_SECONDS }
  );
};

const signRefreshToken = ({ adminUserId, role, sessionId }) => {
  return jwt.sign(
    { type: "refresh", sub: adminUserId, role, sid: sessionId },
    getRefreshSecret(),
    { expiresIn: REFRESH_TTL_SECONDS }
  );
};

const signChallengeToken = ({ adminUserId, sessionId }) => {
  return jwt.sign(
    { type: "admin_2fa_challenge", sub: adminUserId, sid: sessionId },
    getAccessSecret(),
    { expiresIn: CHALLENGE_TTL_SECONDS }
  );
};

// Non-fatal boot check. Logs a clear warning if the admin secrets are missing,
// shared with the user secret, or identical to each other. Intentionally does
// NOT crash the process — that would take down the customer/partner APIs too;
// instead admin login fails closed (the getters above throw) until fixed.
const assertAdminSecrets = () => {
  const access = process.env.ADMIN_JWT_ACCESS_SECRET;
  const refresh = process.env.ADMIN_JWT_REFRESH_SECRET;
  const userSecret = process.env.JWT_SECRET;
  const problems = [];

  if (!access) problems.push("ADMIN_JWT_ACCESS_SECRET is missing");
  if (!refresh) problems.push("ADMIN_JWT_REFRESH_SECRET is missing");
  if (access && userSecret && access === userSecret)
    problems.push("ADMIN_JWT_ACCESS_SECRET must differ from JWT_SECRET");
  if (refresh && userSecret && refresh === userSecret)
    problems.push("ADMIN_JWT_REFRESH_SECRET must differ from JWT_SECRET");
  if (access && refresh && access === refresh)
    problems.push("ADMIN_JWT_ACCESS_SECRET and ADMIN_JWT_REFRESH_SECRET should differ");

  if (problems.length) {
    console.error(
      "[admin-secrets] SECURITY WARNING — admin login will fail until fixed:\n  - " +
        problems.join("\n  - ")
    );
  }
  return problems;
};

module.exports = {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  CHALLENGE_TTL_SECONDS,
  getAccessSecret,
  getRefreshSecret,
  signAccessToken,
  signRefreshToken,
  signChallengeToken,
  assertAdminSecrets,
};
