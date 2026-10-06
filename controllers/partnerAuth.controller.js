const Partner = require("../models/Partner");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const AdminSetting = require("../admin/models/AdminSetting");
const Service = require("../models/service.model");
const Category = require("../models/Category");
const {
  sendOtp: sendOtpViaMsg91,
  verifyOtp: verifyOtpViaMsg91,
  issuePhoneProof,
  verifyAccessToken: verifyMsg91AccessToken,
  phoneMatchesVerified,
} = require("../services/msg91Otp.service");
// Every partner lookup/create keys on the canonical number (utils/phone) — the
// same one MSG91 verifies — so reformatting a phone can't open a second account.
const { toNationalPhone, INVALID_PHONE_MESSAGE } = require("../utils/phone");
const { isQuietHours } = require("../utils/partnerHours");
const { partnerWithSignedSelfie } = require("../utils/sensitiveFileUrl");
const { revokeIfValid, disconnectSocketsUsingToken } = require("../utils/tokenRevocation");

const PARTNER_TOKEN_TTL = String(process.env.PARTNER_JWT_TTL || "90d");
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

// Phone-binding enforcement for the MSG91 access-token flows (register / login
// exchange / password reset). The MSG91 token only proves that *some* phone
// completed OTP — without binding it to the claimed number, a valid token for
// one phone could be replayed to log in as, or reset the password of, ANY
// partner (account takeover). Mirrors the customer flow in userOtp.controller.js.
//   "strict"  (default) — reject on a mismatch AND when no phone can be
//                         recovered (fail closed).
//   "enforce"           — reject on a mismatch but ALLOW when no phone can be
//                         recovered (fail open; emergency use only — takeover
//                         is possible while set).
//   "off"               — skip the check (emergency kill-switch).
const PHONE_BINDING_MODE = String(process.env.MSG91_PHONE_BINDING || "strict").toLowerCase();

const lastFour = (value) => {
  const d = String(value || "").replace(/\D/g, "");
  return d ? `…${d.slice(-4)}` : "(none)";
};

// Same policy registerPartnerValidator enforces — reset must not be a way to
// downgrade to a weaker password. Returns an error message, or null when valid.
const passwordPolicyError = (password) => {
  const value = String(password || "");
  if (value.length < 8) {
    return "Password must be at least 8 characters";
  }
  if (!/^(?=.*[A-Z])(?=.*\d)/.test(value)) {
    return "Password must contain at least one uppercase letter and one number";
  }
  return null;
};

// True when the exchange must be REJECTED: the verified phone differs from the
// claim, or (strict, the default) no phone could be recovered at all — an
// unbindable token must not unlock an arbitrary partner's account.
const isPhoneBindingMismatch = (verification, phone) => {
  if (PHONE_BINDING_MODE === "off") return false;
  const verifiedPhones = verification?.verifiedPhones || [];
  if (verifiedPhones.length === 0) {
    if (PHONE_BINDING_MODE === "strict") {
      console.error(
        "[partner-auth] MSG91 phone binding could not be checked — no phone in token/response. Rejecting for",
        lastFour(phone)
      );
      return true;
    }
    console.error(
      "[partner-auth] MSG91 phone binding could not be checked — no phone in token/response. " +
        "ALLOWING for %s because MSG91_PHONE_BINDING=%s (fail-open) — takeover is possible while set.",
      lastFour(phone),
      PHONE_BINDING_MODE
    );
    return false;
  }
  if (!phoneMatchesVerified(verifiedPhones, phone)) {
    console.warn(
      "[partner-auth] MSG91 phone binding mismatch — rejected. claimed=%s verified=%s",
      lastFour(phone),
      verifiedPhones.map(lastFour).join(",")
    );
    return true;
  }
  return false;
};

/* =====================================================
   REGISTER PARTNER (UPDATED FOR PRODUCTION)
   - Supports multiple service categories
   - Backward compatible
===================================================== */
exports.registerPartner = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      gender,
      dateOfBirth,
      serviceCategory, // OLD (string)
      serviceCategories, // NEW (array of categories)
      serviceIds, // SMART ONBOARDING (array of specific service IDs)
      skillTier, // AC only: 2 = Technician, 1 = Non-Technician
      mehendiSpecializations, // Mehendi subcategory names partner can perform
      latitude,
      longitude,
      accessToken, // MSG91 access token — phone must be verified before account is created
    } = req.body;

    if (!name || !req.body.phone || !password) {
      return res.status(400).json({
        success: false,
        message: "name, phone and password are required",
      });
    }

    const phone = toNationalPhone(req.body.phone);
    if (!phone) {
      return res.status(400).json({ success: false, message: INVALID_PHONE_MESSAGE });
    }

    // Phone OTP verification is mandatory — account cannot be created without it
    if (!accessToken) {
      return res.status(400).json({
        success: false,
        message: "Phone verification is required. Please verify your phone number with OTP before creating an account.",
      });
    }

    // Never honoured in production — same rule as MSG91_SKIP_ACCESS_TOKEN_VERIFY
    // in the login/reset flows. Without the gate, a leftover test flag on the
    // server would let anyone register partners with an unverified phone.
    const skipServerVerify =
      !IS_PRODUCTION &&
      String(process.env.SKIP_MSG91_SERVER_VERIFY || "").toLowerCase() === "true";

    if (!skipServerVerify) {
      const verification = await verifyMsg91AccessToken(accessToken);
      if (isPhoneBindingMismatch(verification, phone)) {
        return res.status(401).json({
          success: false,
          message: "Phone number does not match the verified OTP",
        });
      }
    }

    const existing = await Partner.findOne({ phone });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: "Partner already exists",
      });
    }

    // --- SMART ONBOARDING: RESOLVE SPECIFIC CAPABILITIES ---
    let resolvedServices = [];
    let resolvedCategories = serviceCategories || [];
    
    if (Array.isArray(serviceIds) && serviceIds.length > 0) {
      const uniqueServiceIds = [...new Set(serviceIds)];
      const validServices = await Service.find({
        _id: { $in: uniqueServiceIds },
        isActive: true,
      });

      // Save exact capabilities (e.g. Bridal Mehendi, Window AC Repair)
      resolvedServices = validServices.map((service) => ({
        serviceId: service._id,
        isActive: true,
        name: service.name,
        category: service.category,
        subCategory: service.subCategory,
      }));

      // Automatically deduce the main categories from the selected services
      const categoryIds = validServices
        .map((service) => (service.category ? String(service.category) : null))
        .filter(Boolean);
        
      if (categoryIds.length > 0) {
        const uniqueCategoryIds = [...new Set(categoryIds)];
        const categories = await Category.find({ _id: { $in: uniqueCategoryIds } }).lean();
        resolvedCategories = categories.map(c => c.name);
      }
    } else if (serviceCategory && resolvedCategories.length === 0) {
      resolvedCategories = [serviceCategory];
    }

    // AC skill tier — only "2" (Technician) is meaningful; everything else
    // (Non-Technician, Mehendi, missing) stays at tier 1.
    const resolvedSkillTier = Number(skillTier) === 2 ? 2 : 1;

    const resolvedMehendiSpecializations =
      Array.isArray(mehendiSpecializations) && mehendiSpecializations.length > 0
        ? mehendiSpecializations.map((s) => String(s).trim()).filter(Boolean)
        : [];

    const partner = await Partner.create({
      name,
      phone,
      email,
      password,
      gender: String(gender || "").trim().toUpperCase(),
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,

      // NEW production system
      serviceCategories: resolvedCategories,
      services: resolvedServices, // Save specific skills to DB
      skillTier: resolvedSkillTier,
      mehendiSpecializations: resolvedMehendiSpecializations,

      // backward compatibility
      serviceCategory: serviceCategory || null,

      location: {
        type: "Point",
        coordinates: [longitude || 0, latitude || 0],
      },
    });

    const token = jwt.sign(
      { id: partner._id, role: "partner" },
      process.env.JWT_SECRET,
      { expiresIn: PARTNER_TOKEN_TTL }
    );

    // `select: false` on password only applies to queries — the document
    // returned by create() still carries the hash, so strip it like login does.
    const safePartner = partner.toObject();
    delete safePartner.password;

    res.status(201).json({
      success: true,
      message: "Partner registered successfully",
      token,
      partner: await partnerWithSignedSelfie(safePartner),
    });
  } catch (error) {
    console.error("registerPartner error:", error);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};

/* =====================================================
   LOGIN PARTNER
===================================================== */
exports.loginPartner = async (req, res) => {
  try {
    const { password } = req.body;
    // An unparseable phone ("") matches no partner → the same generic
    // "Invalid credentials" as an unknown number.
    const phone = toNationalPhone(req.body.phone);

    const partner = await Partner.findOne({ phone }).select("+password");
    if (!partner) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(
      String(password || ""),
      String(partner.password || "")
    );
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // Reject a blocked partner at login itself (defense in depth). The
    // partnerAuth middleware already blocks every authenticated request from a
    // blocked partner, but issuing a token here at all is misleading and lets a
    // blocked account hold a valid session. Mirrors the check in sendPartnerOtp.
    if (partner.isBlocked) {
      return res.status(403).json({ message: "Your account has been blocked" });
    }

    const settings = await AdminSetting.findOne();
    if (settings?.partnerSubscriptionRequired && !partner.subscriptionActive) {
      return res.status(403).json({
        message: "Subscription required to access partner app",
      });
    }

    // Login switches urgent jobs on — except at night (quiet hours), when the
    // switch stays off until the partner turns it on in the morning.
    partner.isOnline = !isQuietHours();
    partner.lastOnlineAt = new Date();
    await partner.save();

    const token = jwt.sign(
      { id: partner._id, role: "partner" },
      process.env.JWT_SECRET,
      { expiresIn: PARTNER_TOKEN_TTL }
    );

    const safePartner = partner.toObject();
    delete safePartner.password;

    res.json({
      success: true,
      token,
      partner: await partnerWithSignedSelfie(safePartner),
    });
  } catch (error) {
    console.error("loginPartner error:", error);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};

/* =====================================================
   SEND PARTNER OTP
===================================================== */
exports.sendPartnerOtp = async (req, res) => {
  try {
    const { purpose } = req.body;

    if (!req.body.phone) {
      return res.status(400).json({ success: false, message: "Phone number is required" });
    }

    const phone = toNationalPhone(req.body.phone);
    if (!phone) {
      return res.status(400).json({ success: false, message: INVALID_PHONE_MESSAGE });
    }

    const partner = await Partner.findOne({ phone }).select("_id isBlocked");

    // Signup verifies the phone BEFORE the account exists, so this send must work
    // for an unknown number — but not for a registered one (fail before the SMS
    // is spent; register would reject it as "Partner already exists" anyway).
    if (purpose === "register") {
      if (partner) {
        return res.status(409).json({ success: false, message: "Partner already exists" });
      }
      await sendOtpViaMsg91(phone);
      return res.json({ success: true, message: "OTP sent successfully" });
    }

    if (!partner) {
      return res.status(404).json({ success: false, message: "Partner not found" });
    }

    if (partner.isBlocked) {
      return res.status(403).json({ success: false, message: "Partner account is blocked" });
    }

    await sendOtpViaMsg91(phone);

    return res.json({
      success: true,
      message: "OTP sent successfully",
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode && error.statusCode < 500 ? error.message : "Failed to send OTP",
    });
  }
};

/* =====================================================
   VERIFY PARTNER OTP
===================================================== */
exports.verifyPartnerOtp = async (req, res) => {
  try {
    const { otp } = req.body;

    if (!req.body.phone || !otp || typeof otp !== "string") {
      return res.status(400).json({ success: false, message: "Phone and OTP are required" });
    }

    const phone = toNationalPhone(req.body.phone);
    if (!phone) {
      return res.status(400).json({ success: false, message: INVALID_PHONE_MESSAGE });
    }

    await verifyOtpViaMsg91(phone, otp);

    const partner = await Partner.findOne({ phone }).select("+password");
    if (!partner) {
      return res.status(404).json({ success: false, message: "Partner not found" });
    }

    if (partner.isBlocked) {
      return res.status(403).json({ success: false, message: "Partner account is blocked" });
    }

    const settings = await AdminSetting.findOne();
    if (settings?.partnerSubscriptionRequired && !partner.subscriptionActive) {
      return res.status(403).json({
        success: false,
        message: "Subscription required to access partner app",
      });
    }

    // Login switches urgent jobs on — except at night (quiet hours), when the
    // switch stays off until the partner turns it on in the morning.
    partner.isOnline = !isQuietHours();
    partner.lastOnlineAt = new Date();
    await partner.save();

    const token = jwt.sign(
      { id: partner._id, role: "partner" },
      process.env.JWT_SECRET,
      { expiresIn: PARTNER_TOKEN_TTL }
    );

    const safePartner = partner.toObject();
    delete safePartner.password;

    return res.json({
      success: true,
      token,
      partner: await partnerWithSignedSelfie(safePartner),
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode && error.statusCode < 500 ? error.message : "OTP verification failed",
    });
  }
};

/* =====================================================
   VERIFY PARTNER PHONE (no session)
   Returns a signed proof of the phone for register / password reset, which
   accept it in the `accessToken` field.
===================================================== */
exports.verifyPartnerPhone = async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || typeof phone !== "string" || !otp || typeof otp !== "string") {
      return res.status(400).json({ success: false, message: "Phone and OTP are required" });
    }

    await verifyOtpViaMsg91(phone, otp);

    return res.json({ success: true, accessToken: issuePhoneProof(phone) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode && error.statusCode < 500 ? error.message : "OTP verification failed",
    });
  }
};

exports.exchangePartnerMsg91AccessToken = async (req, res) => {
  try {
    const { accessToken } = req.body;

    if (!req.body.phone || !accessToken) {
      return res.status(400).json({
        success: false,
        message: "Phone number and MSG91 access token are required",
      });
    }

    const phone = toNationalPhone(req.body.phone);
    if (!phone) {
      return res.status(400).json({ success: false, message: INVALID_PHONE_MESSAGE });
    }

    const skipServerVerify =
      !IS_PRODUCTION &&
      String(process.env.MSG91_SKIP_ACCESS_TOKEN_VERIFY || "").toLowerCase() ===
        "true";

    if (!skipServerVerify) {
      const verification = await verifyMsg91AccessToken(accessToken);
      if (isPhoneBindingMismatch(verification, phone)) {
        return res.status(401).json({
          success: false,
          message: "Phone number does not match the verified OTP",
        });
      }
    }

    const partner = await Partner.findOne({ phone }).select("+password");
    if (!partner) {
      return res
        .status(404)
        .json({ success: false, message: "Partner not found" });
    }

    if (partner.isBlocked) {
      return res
        .status(403)
        .json({ success: false, message: "Partner account is blocked" });
    }

    const settings = await AdminSetting.findOne();
    if (settings?.partnerSubscriptionRequired && !partner.subscriptionActive) {
      return res.status(403).json({
        success: false,
        message: "Subscription required to access partner app",
      });
    }

    // Login switches urgent jobs on — except at night (quiet hours), when the
    // switch stays off until the partner turns it on in the morning.
    partner.isOnline = !isQuietHours();
    partner.lastOnlineAt = new Date();
    await partner.save();

    const token = jwt.sign(
      { id: partner._id, role: "partner" },
      process.env.JWT_SECRET,
      { expiresIn: PARTNER_TOKEN_TTL }
    );

    const safePartner = partner.toObject();
    delete safePartner.password;

    return res.json({
      success: true,
      token,
      partner: await partnerWithSignedSelfie(safePartner),
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode && error.statusCode < 500 ? error.message : "MSG91 verification failed",
    });
  }
};

exports.resetPartnerPasswordWithMsg91 = async (req, res) => {
  try {
    const { accessToken, newPassword } = req.body;

    if (!req.body.phone || !accessToken || !newPassword) {
      return res.status(400).json({
        success: false,
        message:
          "Phone number, MSG91 access token and new password are required",
      });
    }

    const phone = toNationalPhone(req.body.phone);
    if (!phone) {
      return res.status(400).json({ success: false, message: INVALID_PHONE_MESSAGE });
    }

    const policyError = passwordPolicyError(newPassword);
    if (policyError) {
      return res.status(400).json({
        success: false,
        message: policyError,
      });
    }

    const skipServerVerify =
      !IS_PRODUCTION &&
      String(process.env.MSG91_SKIP_ACCESS_TOKEN_VERIFY || "").toLowerCase() ===
        "true";

    if (!skipServerVerify) {
      const verification = await verifyMsg91AccessToken(accessToken);
      if (isPhoneBindingMismatch(verification, phone)) {
        return res.status(401).json({
          success: false,
          message: "Phone number does not match the verified OTP",
        });
      }
    }

    const partner = await Partner.findOne({ phone }).select("+password");
    if (!partner) {
      return res
        .status(404)
        .json({ success: false, message: "Partner not found" });
    }

    if (partner.isBlocked) {
      return res
        .status(403)
        .json({ success: false, message: "Partner account is blocked" });
    }

    partner.password = String(newPassword);
    await partner.save();

    return res.json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode && error.statusCode < 500 ? error.message : "Unable to reset password",
    });
  }
};

// POST /reset-password (behind partnerAuth). A bearer token alone is not enough
// to change the password: tokens live 90 days, and a copied/stolen one used to
// be able to set a new password — which, via passwordChangedAt, also signs the
// real partner out everywhere (account takeover). The caller must prove they
// are the partner NOW by one of:
//   - a fresh sign-in (token issued within RECENT_SIGN_IN_WINDOW_MS — e.g. the
//     "forgot password → log in with OTP → set new password" flow),
//   - currentPassword, or
//   - accessToken: a phone-OTP proof (/verify-phone) for the account's phone.
const RECENT_SIGN_IN_WINDOW_MS = 15 * 60 * 1000;

async function confirmPartnerIdentity(req) {
  const { currentPassword, accessToken } = req.body || {};
  const issuedAtMs = Number(req.partnerTokenIssuedAt || 0) * 1000;
  if (issuedAtMs > 0 && Date.now() - issuedAtMs <= RECENT_SIGN_IN_WINDOW_MS) {
    return { ok: true };
  }

  if (currentPassword) {
    const withHash = await Partner.findById(req.partner._id).select("+password");
    const matches = await bcrypt.compare(String(currentPassword), String(withHash?.password || ""));
    return matches
      ? { ok: true }
      : { ok: false, status: 400, code: "CURRENT_PASSWORD_INVALID", message: "Current password is incorrect" };
  }

  if (accessToken) {
    const verification = await verifyMsg91AccessToken(accessToken);
    if (isPhoneBindingMismatch(verification, req.partner.phone)) {
      return {
        ok: false,
        status: 401,
        code: "PHONE_VERIFICATION_MISMATCH",
        message: "Phone number does not match the verified OTP",
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    status: 403,
    code: "REAUTH_REQUIRED",
    message: "For your security, enter your current password or verify your phone with OTP to change your password.",
  };
}

exports.resetPartnerPassword = async (req, res) => {
  try {
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({
        success: false,
        message: "New password is required",
      });
    }

    const policyError = passwordPolicyError(newPassword);
    if (policyError) {
      return res.status(400).json({
        success: false,
        message: policyError,
      });
    }

    const identity = await confirmPartnerIdentity(req);
    if (!identity.ok) {
      return res.status(identity.status).json({
        success: false,
        code: identity.code,
        message: identity.message,
      });
    }

    req.partner.password = String(newPassword);
    await req.partner.save();

    return res.json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (error) {
    // e.g. an invalid/expired phone-OTP proof from verifyMsg91AccessToken (4xx).
    const clientError = error.statusCode && error.statusCode < 500;
    return res.status(clientError ? error.statusCode : 500).json({
      success: false,
      message: clientError ? error.message : "Unable to reset password",
    });
  }
};

/* =====================================================
   LOGOUT
   POST /api/partner/auth/logout — revokes the presented token server-side
   (it would otherwise stay valid for the rest of its 90-day life) and closes
   live sockets that used it. Works with an already-invalid token too: there
   is simply nothing left to revoke.
===================================================== */
exports.logoutPartner = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token =
      authHeader && authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
    if (token) {
      await revokeIfValid(token);
      disconnectSocketsUsingToken(token);
    }
    return res.json({ success: true });
  } catch (error) {
    console.error("logoutPartner error:", error.message);
    return res.status(500).json({ success: false, message: "Logout failed. Please try again." });
  }
};

/* =====================================================
   SET PARTNER ONLINE / OFFLINE
===================================================== */
exports.setPartnerStatus = async (req, res) => {
  try {
    const { isOnline } = req.body;

    if (typeof isOnline !== "boolean") {
      return res.status(400).json({
        message: "isOnline must be true or false",
      });
    }

    // isOnline is the "Available for urgent jobs" switch (it only gates jobs
    // starting within 30 minutes). Urgent jobs pause at night: during quiet
    // hours it can't be switched on — the night reset would undo it anyway.
    const quietHours = isQuietHours();
    req.partner.isOnline = isOnline && !quietHours;
    await req.partner.save();

    res.json({
      success: true,
      message:
        isOnline && quietHours
          ? "Urgent jobs are paused at night (10 PM–7 AM). Switch them on again in the morning."
          : `Urgent jobs ${req.partner.isOnline ? "on" : "off"}`,
      isOnline: req.partner.isOnline,
      quietHours,
    });
  } catch (error) {
    console.error("setPartnerStatus error:", error);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};
