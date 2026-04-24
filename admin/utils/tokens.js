const jwt = require("jsonwebtoken");

const ACCESS_TTL_SECONDS = Number(process.env.ADMIN_ACCESS_TTL_SECONDS || 900);
const REFRESH_TTL_SECONDS = Number(process.env.ADMIN_REFRESH_TTL_SECONDS || 60 * 60 * 24 * 7);
const CHALLENGE_TTL_SECONDS = Number(process.env.ADMIN_2FA_CHALLENGE_TTL_SECONDS || 300);

const getAccessSecret = () => process.env.ADMIN_JWT_ACCESS_SECRET || process.env.JWT_SECRET;
const getRefreshSecret = () => process.env.ADMIN_JWT_REFRESH_SECRET || process.env.JWT_SECRET;

const signAccessToken = ({ adminUserId, role }) => {
  return jwt.sign(
    { type: "access", sub: adminUserId, role },
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

module.exports = {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  CHALLENGE_TTL_SECONDS,
  getAccessSecret,
  getRefreshSecret,
  signAccessToken,
  signRefreshToken,
  signChallengeToken,
};
