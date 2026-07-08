const User = require("../models/User");
const jwt = require("jsonwebtoken");
const {
  sendOtp: sendOtpViaMsg91,
  verifyOtp: verifyOtpViaMsg91,
  verifyAccessToken: verifyMsg91AccessToken,
  toInternationalPhone,
  phoneMatchesVerified,
} = require("../services/msg91Otp.service");
const {
  getUniqueReferralCode,
  validateReferralCode,
  createReferral,
} = require("../utils/referral");
const {
  setUserAuthCookie,
  clearUserAuthCookie,
} = require("../utils/authCookie");

const USER_TOKEN_TTL = String(process.env.USER_JWT_TTL || "90d");
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

// Phone-binding enforcement for the MSG91 access-token exchange:
//   "enforce" (default) — reject when the verified token belongs to a different
//                         phone than the one being claimed (the account-takeover fix).
//   "off"               — skip the check (legacy behaviour / emergency kill-switch).
// In every mode we ALLOW the request when no phone could be recovered from MSG91
// (so a format change on MSG91's side can never lock all users out — it only
// degrades the protection, and logs loudly so it's caught).
const PHONE_BINDING_MODE = String(process.env.MSG91_PHONE_BINDING || "enforce").toLowerCase();

const lastFour = (value) => {
  const d = String(value || "").replace(/\D/g, "");
  return d ? `…${d.slice(-4)}` : "(none)";
};

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

    // Web reads its session from this httpOnly cookie; mobile reads `token` from
    // the body (and ignores the cookie). Setting both keeps every client working.
    setUserAuthCookie(res, token);

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
      const verification = await verifyMsg91AccessToken(accessToken);

      // Bind the issued session to the phone MSG91 actually verified. Without
      // this, a valid token for ONE phone could be exchanged for a session on
      // ANY phone (account takeover).
      if (PHONE_BINDING_MODE !== "off") {
        const verifiedPhones = verification?.verifiedPhones || [];
        if (verifiedPhones.length === 0) {
          // Couldn't recover the verified phone from MSG91 — fail open (don't
          // lock users out) but log so this is noticed and investigated.
          console.error(
            "[auth] MSG91 phone binding could not be checked — no phone in token/response. " +
              "Verify MSG91's verifyAccessToken format. Allowing exchange for",
            lastFour(phone)
          );
        } else if (!phoneMatchesVerified(verifiedPhones, phone)) {
          // Verified phone differs from the claimed phone → reject.
          console.warn(
            "[auth] MSG91 phone binding mismatch — rejected exchange. claimed=%s verified=%s",
            lastFour(phone),
            verifiedPhones.map(lastFour).join(",")
          );
          return res.status(401).json({
            message: "Phone number does not match the verified OTP",
          });
        }
      }
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

    // Web reads its session from this httpOnly cookie; mobile reads `token` from
    // the body (and ignores the cookie). Setting both keeps every client working.
    setUserAuthCookie(res, token);

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

// GET /api/auth/me — returns the authenticated user. Runs behind userAuth, so it
// resolves the session from either the Bearer header (mobile) or the httpOnly
// cookie (web). The web app calls this on load to rehydrate its session without
// ever seeing the token.
exports.getMe = async (req, res) => {
  return res.json({ success: true, user: req.user });
};

// POST /api/auth/logout — clears the web session cookie. No auth required: it can
// only ever clear the caller's own cookie. Mobile logs out client-side by
// dropping its stored Bearer token, so this is a no-op for it.
exports.logout = async (req, res) => {
  clearUserAuthCookie(res);
  return res.json({ success: true });
};
