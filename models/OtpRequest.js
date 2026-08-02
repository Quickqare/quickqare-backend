const mongoose = require("mongoose");

// Ties a phone number to the MSG91 widget `reqId` returned by sendOtpMobile.
//
// MSG91's widget verifyOtp REJECTS a request without a reqId ("reqId is
// required."), so the value has to survive between the send call and the verify
// call. It can't live in process memory: a deploy or restart between the two
// would strand every in-flight login. It also can't go to the browser — a caller
// who can choose the reqId could pair a reqId they obtained for their OWN phone
// with a victim's number and take over the account. Keeping the mapping
// server-side and looking it up BY the submitted phone is what binds the
// verified OTP to the right number.
const otpRequestSchema = new mongoose.Schema(
  {
    // Digits only, as submitted by the client (matches User.phone).
    phone: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    reqId: {
      type: String,
      required: true,
    },
    // TTL anchor. MSG91 OTPs expire well inside this window; the index only
    // stops abandoned attempts from accumulating forever.
    createdAt: {
      type: Date,
      default: Date.now,
      // Mongo's TTL monitor runs about once a minute, so removal is approximate
      // — that's fine, MSG91 is the authority on whether the OTP is still valid.
      expires: 900,
    },
  },
  { versionKey: false }
);

module.exports =
  mongoose.models.OtpRequest || mongoose.model("OtpRequest", otpRequestSchema);
