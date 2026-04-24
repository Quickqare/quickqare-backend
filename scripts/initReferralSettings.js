const mongoose = require("mongoose");
const ReferralSettings = require("../models/ReferralSettings");

async function initReferralSettings() {
  try {
    console.log("Initializing referral settings...");

    // Check if settings already exist
    const existing = await ReferralSettings.findOne();
    if (existing) {
      console.log("Referral settings already exist");
      return;
    }

    // Create default settings
    const settings = new ReferralSettings({
      referrerRewardAmount: 50,
      newUserDiscountAmount: 100,
      minOrderAmount: 0,
      couponExpiryDays: 30,
      maxReferralsPerUser: 10,
      isEnabled: true,
      couponDescription: "Referral discount for new users",
    });

    await settings.save();
    console.log("Referral settings initialized successfully");
  } catch (error) {
    console.error("Error initializing referral settings:", error);
  }
}

// Run if called directly
if (require.main === module) {
  mongoose.connect(process.env.MONGO_URI)
    .then(() => {
      console.log("Connected to MongoDB");
      return initReferralSettings();
    })
    .then(() => {
      console.log("Done");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { initReferralSettings };