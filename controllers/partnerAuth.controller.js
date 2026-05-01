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
} = require("../services/msg91Otp.service");

const PARTNER_TOKEN_TTL = String(process.env.PARTNER_JWT_TTL || "90d");
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

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
      latitude,
      longitude,
    } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: "name, phone and password are required",
      });
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

    res.status(201).json({
      success: true,
      message: "Partner registered successfully",
      token,
      partner,
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
      await verifyMsg91AccessToken(accessToken);
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

    if (String(newPassword).length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long",
      });
    }

    const skipServerVerify =
      !IS_PRODUCTION &&
      String(process.env.MSG91_SKIP_ACCESS_TOKEN_VERIFY || "").toLowerCase() ===
        "true";

    if (!skipServerVerify) {
      await verifyMsg91AccessToken(accessToken);
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
