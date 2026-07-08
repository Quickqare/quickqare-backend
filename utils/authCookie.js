// Helpers for carrying the customer JWT in an httpOnly cookie (web app), while
// the mobile apps keep sending the same JWT via the Authorization: Bearer header.
// See middlewares/userAuth.js (reads either) and userOtp.controller (sets it).
//
// Web and the API are same-site (quickqare.in <-> api.quickqare.in), so the
// cookie uses SameSite=Lax: the browser sends it on same-site requests but never
// on cross-site ones, which neutralises CSRF without needing a CSRF token.

const USER_TOKEN_COOKIE = "qq_token";

const IS_PRODUCTION =
  String(process.env.NODE_ENV || "").toLowerCase() === "production";

// Mirrors the USER_JWT_TTL default ("90d") used when signing the token, so the
// cookie doesn't expire on a different schedule than the JWT it carries. If the
// JWT TTL is shortened via env, the token simply 401s first and the client
// re-authenticates — the stale cookie is harmless.
const USER_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// Read a single cookie value out of a raw Cookie header. We only ever need one
// cookie, so this avoids pulling in cookie-parser. Works for both Express
// (req.headers.cookie) and socket.io (socket.handshake.headers.cookie).
function readCookie(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== "string") return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

const baseCookieOptions = () => ({
  httpOnly: true, // not readable by JS — defeats XSS token theft
  secure: IS_PRODUCTION, // HTTPS-only in prod; dev runs over http://localhost
  sameSite: "lax",
  path: "/",
});

function setUserAuthCookie(res, token) {
  res.cookie(USER_TOKEN_COOKIE, token, {
    ...baseCookieOptions(),
    maxAge: USER_TOKEN_TTL_MS,
  });
}

// clearCookie must use the same attributes (minus maxAge) the cookie was set
// with, or some browsers refuse to clear it.
function clearUserAuthCookie(res) {
  res.clearCookie(USER_TOKEN_COOKIE, baseCookieOptions());
}

module.exports = {
  USER_TOKEN_COOKIE,
  readCookie,
  setUserAuthCookie,
  clearUserAuthCookie,
};
