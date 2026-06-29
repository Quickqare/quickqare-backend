const express = require("express");
const router = express.Router();
const ReferralSettings = require("../../../models/ReferralSettings");
const Referral = require("../../../models/Referral");
const UserWallet = require("../../../models/UserWallet");
const UserWalletTransaction = require("../../../models/UserWalletTransaction");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const { PERMISSIONS } = require("../../constants/permissions");

// Every endpoint here exposes customer wallet balances, PII (name/phone), or
// referral reward configuration. The whole router used to be mounted with NO
// auth at all — a critical broken-access-control + unauthenticated-write hole.
// Require a valid admin session on every route from here down.
router.use(authenticateAdmin);

// Whitelist of fields a referral-settings write is allowed to touch. Prevents
// mass-assignment of arbitrary/internal fields via Object.assign(settings, req.body).
const REFERRAL_SETTINGS_FIELDS = [
  "referrerRewardAmount",
  "newUserDiscountAmount",
  "minOrderAmount",
  "couponExpiryDays",
  "maxReferralsPerUser",
  "isEnabled",
  "couponDescription",
];

const pickReferralSettings = (body = {}) =>
  REFERRAL_SETTINGS_FIELDS.reduce((acc, key) => {
    if (body[key] !== undefined) acc[key] = body[key];
    return acc;
  }, {});

// Get referral settings
router.get("/referral-settings", authorize(PERMISSIONS.ANALYTICS_READ), async (req, res) => {
  try {
    let settings = await ReferralSettings.findOne();
    if (!settings) {
      settings = await ReferralSettings.create({});
    }
    return res.json({ success: true, data: settings });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Update referral settings
router.put("/referral-settings", authorize(PERMISSIONS.SETTINGS_MANAGE), async (req, res) => {
  try {
    const updateData = pickReferralSettings(req.body);
    let settings = await ReferralSettings.findOne();

    if (!settings) {
      settings = await ReferralSettings.create(updateData);
    } else {
      settings.set(updateData);
      await settings.save();
    }

    return res.json({ success: true, data: settings });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get referrals list
router.get("/", authorize(PERMISSIONS.ANALYTICS_READ), async (req, res) => {
  try {
    const { page = 1, limit = 20, status, referrerId, referredId } = req.query;

    const query = {};
    if (status) query.status = status;
    if (referrerId) query.referrerId = referrerId;
    if (referredId) query.referredId = referredId;

    const referrals = await Referral.find(query)
      .populate("referrerId", "name phone")
      .populate("referredId", "name phone")
      .populate("couponId", "code discountValue expiresAt")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Referral.countDocuments(query);

    return res.json({
      success: true,
      data: {
        referrals,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get referral stats
router.get("/referral-stats", authorize(PERMISSIONS.ANALYTICS_READ), async (req, res) => {
  try {
    const stats = await Referral.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalRewards: { $sum: "$referrerRewardAmount" }
        }
      }
    ]);

    const result = {
      totalReferrals: 0,
      pendingReferrals: 0,
      completedReferrals: 0,
      expiredReferrals: 0,
      invalidReferrals: 0,
      totalRewardsDistributed: 0,
    };

    stats.forEach(stat => {
      result.totalReferrals += stat.count;
      if (stat._id === "PENDING") result.pendingReferrals = stat.count;
      if (stat._id === "COMPLETED") {
        result.completedReferrals = stat.count;
        result.totalRewardsDistributed = stat.totalRewards;
      }
      if (stat._id === "EXPIRED") result.expiredReferrals = stat.count;
      if (stat._id === "INVALID") result.invalidReferrals = stat.count;
    });

    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get user wallets
router.get("/user-wallets", authorize(PERMISSIONS.ANALYTICS_READ), async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const wallets = await UserWallet.find()
      .populate("userId", "name phone")
      .sort({ lastUpdated: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await UserWallet.countDocuments();

    return res.json({
      success: true,
      data: {
        wallets,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Get user wallet transactions
router.get("/user-wallet-transactions", authorize(PERMISSIONS.ANALYTICS_READ), async (req, res) => {
  try {
    const { page = 1, limit = 20, userId } = req.query;

    const query = {};
    if (userId) query.userId = userId;

    const transactions = await UserWalletTransaction.find(query)
      .populate("userId", "name phone")
      .populate("referralId")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await UserWalletTransaction.countDocuments(query);

    return res.json({
      success: true,
      data: {
        transactions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
