const User = require("../models/User");
const Referral = require("../models/Referral");
const UserWallet = require("../models/UserWallet");
const UserWalletTransaction = require("../models/UserWalletTransaction");
const mongoose = require("mongoose");

// Get user's referral code
exports.getReferralCode = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("referralCode");

    if (!user.referralCode) {
      // Generate if not exists (for existing users)
      const { getUniqueReferralCode } = require("../utils/referral");
      user.referralCode = await getUniqueReferralCode();
      await user.save();
    }

    res.json({
      success: true,
      referralCode: user.referralCode,
    });
  } catch (error) {
    console.error("Get referral code error:", error);
    res.status(500).json({ message: "Failed to get referral code" });
  }
};

// Get referral stats
exports.getReferralStats = async (req, res) => {
  try {
    const userId = req.user.id;

    const stats = await Referral.aggregate([
      { $match: { referrerId: new mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalRewards: { $sum: "$referrerRewardAmount" }
        }
      }
    ]);

    const wallet = await UserWallet.findOne({ userId }).select("balance totalEarnings");

    const result = {
      totalReferrals: 0,
      pendingReferrals: 0,
      completedReferrals: 0,
      totalRewards: 0,
      walletBalance: wallet ? wallet.balance : 0,
      totalEarnings: wallet ? wallet.totalEarnings : 0,
    };

    stats.forEach(stat => {
      result.totalReferrals += stat.count;
      if (stat._id === "PENDING") result.pendingReferrals = stat.count;
      if (stat._id === "COMPLETED") {
        result.completedReferrals = stat.count;
        result.totalRewards = stat.totalRewards;
      }
    });

    res.json({
      success: true,
      stats: result,
    });
  } catch (error) {
    console.error("Get referral stats error:", error);
    res.status(500).json({ message: "Failed to get referral stats" });
  }
};

// Get referral history
exports.getReferralHistory = async (req, res) => {
  try {
    const referrals = await Referral.find({ referrerId: req.user.id })
      .populate("referredId", "name phone")
      .populate("couponId", "code discountValue expiryDate")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      referrals,
    });
  } catch (error) {
    console.error("Get referral history error:", error);
    res.status(500).json({ message: "Failed to get referral history" });
  }
};