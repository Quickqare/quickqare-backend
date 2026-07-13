const Partner = require("../models/Partner");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const AdminSetting = require("../admin/models/AdminSetting");
const Service = require("../models/service.model");
const Category = require("../models/Category");
const {
  sendOtp: sendOtpViaMsg91,
  verifyOtp: verifyOtpViaMsg91,
  verifyAccessToken: verifyMsg91AccessToken,
  phoneMatchesVerified,
} = require("../services/msg91Otp.service");

const PARTNER_TOKEN_TTL = String(process.env.PARTNER_JWT_TTL || "90d");
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

// Phone-binding enforcement for the MSG91 access-token flows (register / login
// exchange / password reset). The MSG91 token only proves that *some* phone
// completed OTP — without binding it to the claimed number, a valid token for
// one phone could be replayed to log in as, or reset the password of, ANY
// partner (account takeover). Mirrors the customer flow in userOtp.controller.js.
//   "enforce" (default) — reject when the verified phone differs from the claim.
//   "off"               — skip the check (emergency kill-switch).
const PHONE_BINDING_MODE = String(process.env.MSG91_PHONE_BINDING || "enforce").toLowerCase();

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

// True when the exchange must be REJECTED (verified phone ≠ claimed phone).
// Fails OPEN (returns false) when no phone can be recovered from MSG91, so a
// change in MSG91's response format degrades protection and logs loudly rather
// than locking every partner out.
const isPhoneBindingMismatch = (verification, phone) => {
  if (PHONE_BINDING_MODE === "off") return false;
  const verifiedPhones = verification?.verifiedPhones || [];
  if (verifiedPhones.length === 0) {
    console.error(
      "[partner-auth] MSG91 phone binding could not be checked — no phone in token/response. Allowing for",
      lastFour(phone)
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
      phone,
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

    if (!name || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: "name, phone and password are required",
      });
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
      partner: safePartner,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* =====================================================
   LOGIN PARTNER
===================================================== */
exports.loginPartner = async (req, res) => {
  try {
    const { phone, password } = req.body;

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

    const settings = await AdminSetting.findOne();
    if (settings?.partnerSubscriptionRequired && !partner.subscriptionActive) {
      return res.status(403).json({
        message: "Subscription required to access partner app",
      });
    }

    // Keep partner discoverable for assignment right after login.
    partner.isOnline = true;
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
      partner: safePartner,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* =====================================================
   SEND PARTNER OTP
===================================================== */
exports.sendPartnerOtp = async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, message: "Phone number is required" });
    }

    const partner = await Partner.findOne({ phone }).select("_id isBlocked");
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
      message: error.message || "Failed to send OTP",
    });
  }
};

/* =====================================================
   VERIFY PARTNER OTP
===================================================== */
exports.verifyPartnerOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: "Phone and OTP are required" });
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

    partner.isOnline = true;
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
      partner: safePartner,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "OTP verification failed",
    });
  }
};

exports.exchangePartnerMsg91AccessToken = async (req, res) => {
  try {
    const { phone, accessToken } = req.body;

    if (!phone || !accessToken) {
      return res.status(400).json({
        success: false,
        message: "Phone number and MSG91 access token are required",
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

    const settings = await AdminSetting.findOne();
    if (settings?.partnerSubscriptionRequired && !partner.subscriptionActive) {
      return res.status(403).json({
        success: false,
        message: "Subscription required to access partner app",
      });
    }

    partner.isOnline = true;
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
      partner: safePartner,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "MSG91 verification failed",
    });
  }
};

exports.resetPartnerPasswordWithMsg91 = async (req, res) => {
  try {
    const { phone, accessToken, newPassword } = req.body;

    if (!phone || !accessToken || !newPassword) {
      return res.status(400).json({
        success: false,
        message:
          "Phone number, MSG91 access token and new password are required",
      });
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
      message: error.message || "Unable to reset password",
    });
  }
};

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

    req.partner.password = String(newPassword);
    await req.partner.save();

    return res.json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Unable to reset password",
    });
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

    req.partner.isOnline = isOnline;
    await req.partner.save();

    res.json({
      success: true,
      message: `Partner is now ${isOnline ? "ONLINE" : "OFFLINE"}`,
      isOnline: req.partner.isOnline,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
