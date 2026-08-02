const User = require("../models/User");
const jwt = require("jsonwebtoken");
const OtpRequest = require("../models/OtpRequest");
const {
  sendWidgetOtp,
  retryWidgetOtp,
  verifyWidgetOtp,
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

// Phone-binding enforcement for the MSG91 access-token exchange.
//
// The access token only certifies that *some* phone completed an OTP. Without
// binding it to the phone being claimed, an attacker can OTP their own number,
// then POST {phone: <victim>, accessToken: <their own valid token>} and get a
// session as the victim. Modes:
//
//   "strict" (default) — reject on mismatch AND when no phone could be recovered
//                        from MSG91. Fails closed: an unverifiable token never
//                        mints a session.
//   "enforce"          — reject on mismatch, but ALLOW when no phone could be
//                        recovered. Fails open. Only use this as a temporary
//                        mitigation if MSG91 changes its response format and
//                        strict mode starts rejecting real logins — it leaves
//                        the takeover above exploitable, so treat it as an
//                        incident, not a setting.
//   "off"              — skip the check entirely (emergency kill-switch).
//
// If a deploy of strict mode breaks logins, the fix is to make extraction work
// (services/msg91Otp.service.js), not to sit on "enforce".
const PHONE_BINDING_MODE = String(process.env.MSG91_PHONE_BINDING || "strict").toLowerCase();

const lastFour = (value) => {
  const d = String(value || "").replace(/\D/g, "");
  return d ? `…${d.slice(-4)}` : "(none)";
};

// SEND OTP
exports.sendOtp = async (req, res) => {
  try {
    const { phone } = req.body;

    // Require a plain string. A non-string (e.g. an object/array that slipped
    // past sanitizeMongo as {}) is a malformed client request — reject it here
    // with a clean 400 rather than letting it surface as a downstream 500.
    if (!phone || typeof phone !== "string") {
      return res.status(400).json({ message: "Phone number is required" });
    }

    // Re-sending for a phone that already has a live request uses MSG91's
    // retryOtp against the SAME reqId, which is what the widget expects; a
    // second sendOtpMobile would orphan the first reqId. If the retry is
    // refused (expired request), fall back to starting a fresh one.
    const existing = await OtpRequest.findOne({ phone }).lean();
    let reqId;

    if (existing?.reqId) {
      try {
        ({ reqId } = await retryWidgetOtp(existing.reqId));
      } catch {
        ({ reqId } = await sendWidgetOtp(phone));
      }
    } else {
      ({ reqId } = await sendWidgetOtp(phone));
    }

    // Refresh createdAt too, so the TTL window tracks the latest send.
    await OtpRequest.findOneAndUpdate(
      { phone },
      { $set: { reqId, createdAt: new Date() } },
      { upsert: true }
    );

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

    if (!phone || typeof phone !== "string" || !otp || typeof otp !== "string") {
      return res.status(400).json({ message: "Phone and OTP are required" });
    }

    // Look the reqId up BY the submitted phone. This is the phone binding: the
    // caller never supplies a reqId, so an OTP obtained for one number can't be
    // presented against another — that pairing only exists here, server-side.
    const pending = await OtpRequest.findOne({ phone }).lean();
    if (!pending?.reqId) {
      return res.status(400).json({ message: "Please request an OTP first" });
    }

    await verifyWidgetOtp(otp, pending.reqId);

    // Single-use: a correct OTP must not be replayable into a second session.
    await OtpRequest.deleteOne({ phone });

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
      // Whether this login just created the account. Clients use it to decide
      // whether to show the "complete your profile" step — without it they were
      // left guessing from the user's fields, which misfired for anyone who has
      // no gender set (a legitimate choice).
      isNewUser,
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
          // No phone in the token or the verifyAccessToken response, so the
          // binding can't be checked at all.
          if (PHONE_BINDING_MODE === "strict") {
            console.error(
              "[auth] MSG91 phone binding could not be checked — no phone in token/response. " +
                "Rejecting exchange for %s. MSG91's verifyAccessToken format has likely changed; " +
                "fix extraction in services/msg91Otp.service.js.",
              lastFour(phone)
            );
            return res.status(401).json({
              message: "Could not verify the phone number for this OTP. Please try again.",
            });
          }
          console.error(
            "[auth] MSG91 phone binding could not be checked — no phone in token/response. " +
              "ALLOWING exchange for %s because MSG91_PHONE_BINDING=%s (fail-open). " +
              "Account takeover is possible while this is set — fix extraction and return to strict.",
            lastFour(phone),
            PHONE_BINDING_MODE
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
      // Whether this login just created the account. Clients use it to decide
      // whether to show the "complete your profile" step — without it they were
      // left guessing from the user's fields, which misfired for anyone who has
      // no gender set (a legitimate choice).
      isNewUser,
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
