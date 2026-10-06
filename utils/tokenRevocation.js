// Logout for stateless JWTs: a signed-out token is recorded (as a hash) until
// its own expiry, and the customer/partner auth middlewares + the socket
// handshake refuse it. See models/RevokedToken.js.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const RevokedToken = require("../models/RevokedToken");

// Tokens without an exp claim (none are minted today) are remembered for the
// longest TTL any customer/partner token can have.
const FALLBACK_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

// `exp` is the verified token's exp claim (seconds since epoch).
async function revokeToken(token, exp) {
  if (!token) return;
  const expiresAt =
    Number.isFinite(Number(exp)) && Number(exp) > 0
      ? new Date(Number(exp) * 1000)
      : new Date(Date.now() + FALLBACK_TTL_MS);
  if (expiresAt.getTime() <= Date.now()) return; // already dead — nothing to remember

  await RevokedToken.updateOne(
    { tokenHash: hashToken(token) },
    { $setOnInsert: { tokenHash: hashToken(token), expiresAt } },
    { upsert: true }
  );
}

async function isTokenRevoked(token) {
  if (!token) return false;
  return Boolean(await RevokedToken.exists({ tokenHash: hashToken(token) }));
}

// Logout helper: revoke a token the caller presented, but only one we really
// signed (an unverifiable/expired string is ignored — nothing to protect).
async function revokeIfValid(token) {
  if (!token) return false;
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return false;
  }
  await revokeToken(token, decoded?.exp);
  return true;
}

// Close any open Socket.IO connections that authenticated with this token, so
// live booking/job events stop at sign-out too (socket/handshakeAuth keeps the
// handshake token on socket.authToken).
function disconnectSocketsUsingToken(token) {
  const io = global.io;
  if (!io || !token) return 0;
  let closed = 0;
  for (const socket of io.of("/").sockets.values()) {
    if (socket.authToken === token) {
      socket.disconnect(true);
      closed += 1;
    }
  }
  return closed;
}

module.exports = {
  hashToken,
  revokeToken,
  revokeIfValid,
  isTokenRevoked,
  disconnectSocketsUsingToken,
};
