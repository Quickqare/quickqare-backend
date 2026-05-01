const User = require("../models/User");
const jwt = require("jsonwebtoken");
const {
  sendOtp: sendOtpViaMsg91,
  verifyOtp: verifyOtpViaMsg91,
  verifyAccessToken: verifyMsg91AccessToken,
} = require("../services/msg91Otp.service");
const {
  getUniqueReferralCode,
  validateReferralCode,
  createReferral,
} = require("../utils/referral");

const USER_TOKEN_TTL = String(process.env.USER_JWT_TTL || "90d");
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

// SEND OTP
exports.sendOtp = async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    await sendOtpViaMsg91(phone);

    return res.json({
      success: true,
      message: "OTP sent successfully",
    });
  } catch (error) {
    console.error("Send OTP error:", error);
    return res.status(error.statusCode || 500).json({ message: error.message || "Failed to send OTP" });
  }
};

// VERIFY OTP
exports.verifyOtp = async (req, res) => {
  try {
    const { phone, otp, name, gender, referralCode } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ message: "Phone and OTP are required" });
    }

    await verifyOtpViaMsg91(phone, otp);

    let user = await User.findOne({ phone });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      user = await User.create({
        phone,
        name: String(name || "").trim() || "User",
        gender: String(gender || "").trim(),
      });

      // Generate referral code for new user
      user.referralCode = await getUniqueReferralCode();
      await user.save();
    } else {
      const update = {};
      const cleanName = String(name || "").trim();
      const cleanGender = String(gender || "").trim();
      if (cleanName && (!user.name || user.name === "User")) update.name = cleanName;
      if (cleanGender && !user.gender) update.gender = cleanGender;
      if (Object.keys(update).length) {
        await User.updateOne({ phone }, { $set: update });
        user = await User.findOne({ phone });
      }
    }

    // Handle referral code for new users
    if (isNewUser && referralCode) {
      try {
        const referrer = await validateReferralCode(referralCode, user._id);
        if (referrer) {
          user.referredBy = referrer._id;
          await user.save();
          await createReferral(referrer._id, user._id);
        }
      } catch (error) {
        console.error("Referral validation error:", error.message);
        // Don't fail signup for invalid referral code
      }
    }

    const token = jwt.sign(
      { id: user._id, role: "user" },
      process.env.JWT_SECRET,
      { expiresIn: USER_TOKEN_TTL }
    );

    return res.json({
      success: true,
      token,
      user,
    });
  } catch (error) {
    console.error("Verify OTP error:", error);
    return res.status(error.statusCode || 500).json({ message: error.message || "OTP verification failed" });
  }
};

exports.exchangeMsg91AccessToken = async (req, res) => {
  try {
    const { phone, accessToken, name, gender, referralCode } = req.body;

    if (!phone || !accessToken) {
      return res.status(400).json({
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

    let user = await User.findOne({ phone });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      user = await User.create({
        phone,
        name: String(name || "").trim() || "User",
        gender: String(gender || "").trim(),
      });

      // Generate referral code for new user
      user.referralCode = await getUniqueReferralCode();
      await user.save();
    } else {
      const update = {};
      const cleanName = String(name || "").trim();
      const cleanGender = String(gender || "").trim();
      if (cleanName && (!user.name || user.name === "User")) update.name = cleanName;
      if (cleanGender && !user.gender) update.gender = cleanGender;
      if (Object.keys(update).length) {
        await User.updateOne({ phone }, { $set: update });
        user = await User.findOne({ phone });
      }
    }

    // Handle referral code for new users
    if (isNewUser && referralCode) {
      try {
        const referrer = await validateReferralCode(referralCode, user._id);
        if (referrer) {
          user.referredBy = referrer._id;
          await user.save();
          await createReferral(referrer._id, user._id);
        }
      } catch (error) {
        console.error("Referral validation error:", error.message);
        // Don't fail signup for invalid referral code
      }
    }

    const token = jwt.sign(
      { id: user._id, role: "user" },
      process.env.JWT_SECRET,
      { expiresIn: USER_TOKEN_TTL }
    );

    return res.json({
      success: true,
      token,
      user,
    });
  } catch (error) {
    console.error("MSG91 access token exchange error:", error);
    return res
      .status(error.statusCode || 500)
      .json({ message: error.message || "MSG91 verification failed" });
  }
};
