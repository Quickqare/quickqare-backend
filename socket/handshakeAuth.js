// Optional JWT auth on the socket.io handshake — clients that send a valid
// token get socket.verifiedPartnerId / socket.verifiedUserId attached.
// Clients without a token still connect (backward compat), but joinUserRoom /
// joinPartnerRoom in index.js silently ignore unverified sockets.
//
// Mobile clients pass the JWT in the handshake auth payload; the web app can't
// read its httpOnly cookie, so fall back to the cookie sent on the handshake
// (socket.io client must set withCredentials: true for the browser to send it).
const jwt = require("jsonwebtoken");
const { readCookie, USER_TOKEN_COOKIE } = require("../utils/authCookie");

function handshakeAuth(socket, next) {
  const token =
    socket.handshake.auth?.token ||
    readCookie(socket.handshake.headers?.cookie, USER_TOKEN_COOKIE);
  if (!token) return next();
  try {
    // Partner and user tokens are BOTH signed with JWT_SECRET (see partnerAuth /
    // userAuth and their controllers). No separate PARTNER_JWT_SECRET is used
    // anywhere on the HTTP side; an earlier fallback to one here implied a
    // secret separation that never existed, so it's removed to avoid the false
    // impression that setting PARTNER_JWT_SECRET changes anything. Role dispatch
    // below distinguishes partner vs user tokens.
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET); } catch (_) { return next(); }
    // Partner tokens are signed { id, role: "partner" } — check role+id first,
    // then fall back to a legacy partnerId field if ever used.
    // User tokens are signed { id, role: "user" } (userOtp.controller) — the
    // userId/sub fallbacks are kept only for any legacy tokens still in the wild.
    if (payload?.role === "partner" && (payload?.id || payload?.partnerId)) {
      socket.verifiedPartnerId = String(payload?.id || payload?.partnerId);
    } else if (payload?.role === "user" && payload?.id) {
      socket.verifiedUserId = String(payload.id);
    } else if (payload?.userId || payload?.sub) {
      socket.verifiedUserId = String(payload?.userId || payload?.sub);
    }
  } catch (_) { /* non-fatal — allow unauthenticated */ }
  next();
}

module.exports = { handshakeAuth };
