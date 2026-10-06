const jwt = require("jsonwebtoken");
const Partner = require("../models/Partner");
const { isTokenRevoked } = require("../utils/tokenRevocation");

// lastActiveAt is written at most this often per partner (any authenticated
// request counts), so app activity costs ~one small write per few minutes.
const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/* =====================================================
   PARTNER AUTH MIDDLEWARE (PRODUCTION SAFE)
===================================================== */
module.exports = async (req, res, next) => {
  try {
    /* =====================
       CHECK AUTH HEADER
    ===================== */
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authorization token required",
      });
    }

    /* =====================
       EXTRACT TOKEN
    ===================== */
    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Invalid authorization format",
      });
    }

    /* =====================
       VERIFY TOKEN
    ===================== */
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== "partner") {
      return res.status(403).json({
        success: false,
        message: "Partner access required",
      });
    }

    /* =====================
       FIND PARTNER
    ===================== */
    const partner = await Partner.findById(decoded.id).select("-password");

    if (!partner) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }

    /* =====================
       BLOCKED PARTNER CHECK
    ===================== */
    if (partner.isBlocked || partner.isDeleted) {
      return res.status(403).json({
        success: false,
        message: "Your account has been blocked",
      });
    }

    /* =====================
       SESSION REVOKED BY PASSWORD CHANGE
       Tokens live 90 days; a password reset must end sessions on every other
       device (e.g. a lost or shared phone), not leave them working.
    ===================== */
    if (
      partner.passwordChangedAt &&
      Number(decoded.iat) * 1000 < new Date(partner.passwordChangedAt).getTime()
    ) {
      return res.status(401).json({
        success: false,
        message: "Your password was changed. Please log in again.",
      });
    }

    /* =====================
       APP ACTIVITY
       Any use of the app counts as activity, and it also ends an inactivity
       pause (partnerDuty.pauseInactivePartners / app-removed) — opening the
       app again is all a paused partner has to do.
    ===================== */
    const lastActiveMs = partner.lastActiveAt ? new Date(partner.lastActiveAt).getTime() : 0;
    if (partner.inactivePausedAt || Date.now() - lastActiveMs > ACTIVITY_WRITE_INTERVAL_MS) {
      const activity = { lastActiveAt: new Date(), inactivePausedAt: null, inactivePauseReason: "" };
      try {
        await Partner.updateOne({ _id: partner._id }, { $set: activity });
        partner.set(activity);
      } catch (activityErr) {
        // Bookkeeping only — never fail the request (or log the partner out) over it.
        console.error("Partner activity write failed:", activityErr.message);
      }
    }

    /* =====================
       SIGNED OUT (LOGOUT)
       A token handed back at POST /api/partner/auth/logout stays dead even
       though its signature and expiry are still valid.
    ===================== */
    if (await isTokenRevoked(token)) {
      return res.status(401).json({
        success: false,
        message: "Your session has ended. Please log in again.",
      });
    }

    /* =====================
       ATTACH PARTNER CONTEXT
       partnerTokenIssuedAt lets sensitive actions (password change) require
       a recent sign-in.
    ===================== */
    req.partner = partner;
    req.partnerTokenIssuedAt = Number(decoded.iat) || 0;

    next();
  } catch (error) {
    console.error("Partner auth error:", error);

    return res.status(401).json({
      success: false,
      message: "Unauthorized partner",
    });
  }
};