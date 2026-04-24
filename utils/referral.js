const User = require("../models/User");
const Referral = require("../models/Referral");
const ReferralSettings = require("../models/ReferralSettings");
const UserWallet = require("../models/UserWallet");
const UserWalletTransaction = require("../models/UserWalletTransaction");
const Coupon = require("../models/coupon");

// Generate unique referral code
exports.generateReferralCode = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

// Get unique referral code
exports.getUniqueReferralCode = async () => {
  let code;
  let attempts = 0;
  do {
    code = this.generateReferralCode();
    attempts++;
    if (attempts > 10) {
      throw new Error("Unable to generate unique referral code");
    }
  } while (await User.findOne({ referralCode: code }));
  return code;
};

// Validate referral code
exports.validateReferralCode = async (referralCode, excludeUserId = null) => {
  if (!referralCode) return null;

  const referrer = await User.findOne({
    referralCode,
    status: "ACTIVE",
    ...(excludeUserId && { _id: { $ne: excludeUserId } })
  });

  if (!referrer) {
    throw new Error("Invalid referral code");
  }

  // Check if referrer has reached max referrals
  const settings = await ReferralSettings.findOne();
  if (settings) {
    const referralCount = await Referral.countDocuments({
      referrerId: referrer._id,
      status: { $in: ["PENDING", "COMPLETED"] }
    });
    if (referralCount >= settings.maxReferralsPerUser) {
      throw new Error("Referrer has reached maximum referral limit");
    }
  }

  return referrer;
};

// Create referral record
exports.createReferral = async (referrerId, referredId) => {
  const existingReferral = await Referral.findOne({
    referrerId,
    referredId
  });

  if (existingReferral) {
    throw new Error("Referral already exists between these users");
  }

  return await Referral.create({
    referrerId,
    referredId,
    status: "PENDING"
  });
};

// Process referral reward when first booking is completed
exports.processReferralReward = async (userId, bookingId) => {
  try {
    // Check if user has completed first booking
    const completedBookings = await require("../models/Booking").countDocuments({
      user: userId,
      status: "COMPLETED"
    });

    if (completedBookings > 1) return; // Not first booking

    // Find pending referral
    const referral = await Referral.findOne({
      referredId: userId,
      status: "PENDING"
    }).populate("referrerId");

    if (!referral) return;

    // Get settings
    const settings = await ReferralSettings.findOne();
    if (!settings || !settings.isEnabled) return;

    // Check min order amount
    const booking = await require("../models/Booking").findById(bookingId);
    if (!booking || booking.totalAmount < settings.minOrderAmount) return;

    // Create coupon for new user
    const couponCode = `REF${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + settings.couponExpiryDays);

    const coupon = await Coupon.create({
      code: couponCode,
      discountType: "flat",
      discountValue: settings.newUserDiscountAmount,
      minAmount: 0,
      maxDiscount: settings.newUserDiscountAmount,
      expiryDate,
      isActive: true,
      description: settings.couponDescription,
      usageLimit: 1,
      perUserLimit: 1,
      applicableCategories: [],
      createdBy: "system"
    });

    // Credit referrer's wallet
    let userWallet = await UserWallet.findOne({ userId: referral.referrerId });
    if (!userWallet) {
      userWallet = await UserWallet.create({ userId: referral.referrerId });
    }

    userWallet.balance += settings.referrerRewardAmount;
    userWallet.totalEarnings += settings.referrerRewardAmount;
    userWallet.lastUpdated = new Date();
    await userWallet.save();

    // Create transaction record
    await UserWalletTransaction.create({
      userId: referral.referrerId,
      amount: settings.referrerRewardAmount,
      type: "credit",
      reason: "referral_reward",
      referralId: referral._id,
      description: `Referral reward for user ${userId}`,
    });

    // Update referral
    referral.status = "COMPLETED";
    referral.rewardGiven = true;
    referral.couponId = coupon._id;
    referral.referrerRewardAmount = settings.referrerRewardAmount;
    referral.completedAt = new Date();
    await referral.save();

    // Update user has completed first booking
    await User.findByIdAndUpdate(userId, { hasCompletedFirstBooking: true });

    console.log(`Referral reward processed for user ${userId}`);
  } catch (error) {
    console.error("Error processing referral reward:", error);
  }
};

module.exports = exports;