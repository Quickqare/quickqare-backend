require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const { getUniqueReferralCode } = require("../utils/referral");

async function fixMissingReferralCodes() {
  try {
    // Connect to MongoDB using the URI from your .env file
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB Atlas");

    // Find users who don't have a referral code
    const users = await User.find({
      $or: [
        { referralCode: { $exists: false } },
        { referralCode: null },
        { referralCode: "" },
      ],
    });

    console.log(`🔍 Found ${users.length} users without a referral code.`);

    // Generate and save a new code for each user
    for (const user of users) {
      user.referralCode = await getUniqueReferralCode();
      await user.save();
      console.log(`✅ Updated user ${user.phone} with code: ${user.referralCode}`);
    }

    console.log("🎉 Database update complete!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error connecting to MongoDB or updating database:", error.message);
    if (error.message.includes("bad auth") || error.message.includes("timeout") || error.message.includes("querySrv")) {
      console.log("💡 Hint: Check your MongoDB Atlas Network Access (IP Whitelist) and Database User credentials.");
    }
    process.exit(1);
  }
}

fixMissingReferralCodes();
