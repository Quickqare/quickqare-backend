const PartnerPayoutAccount = require("../models/PartnerPayoutAccount");
const {
  encryptField,
  decryptField,
  maskAccountNumber,
  maskUpiId,
} = require("../utils/fieldCrypto");
const { notifyPartner } = require("../services/pushNotification.service");

// Replacing a VERIFIED account blocks withdrawals for this long, giving the
// real partner time to react to the "payout account changed" alert if their
// login was hijacked.
const PAYOUT_CHANGE_HOLD_MS = 24 * 60 * 60 * 1000;

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NUMBER_RE = /^\d{9,18}$/;
const UPI_RE = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9]{1,63}$/;
const HOLDER_NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,99}$/;

/* =====================================================
   PARTNER-SAFE VIEW
   The partner app only ever sees masked identifiers; full details stay
   server-side (admin verification + withdrawal snapshots).
===================================================== */
const toPartnerView = (account) => {
  if (!account) return null;
  const blockedUntil =
    account.withdrawalsBlockedUntil && new Date(account.withdrawalsBlockedUntil) > new Date()
      ? account.withdrawalsBlockedUntil
      : null;
  return {
    method: account.method,
    accountHolderName: account.accountHolderName || "",
    bankName: account.method === "BANK" ? account.bankName || "" : "",
    accountNumberMasked: account.method === "BANK" ? maskAccountNumber(account.accountNumber) : "",
    ifsc: account.method === "BANK" ? decryptField(account.ifsc) || "" : "",
    upiIdMasked: account.method === "UPI" ? maskUpiId(account.upiId) : "",
    status: account.status,
    rejectionReason: account.status === "REJECTED" ? account.rejectionReason || "" : "",
    submittedAt: account.submittedAt,
    verifiedAt: account.verifiedAt,
    withdrawalsBlockedUntil: blockedUntil,
  };
};
exports.toPartnerView = toPartnerView;

/* =====================================================
   VALIDATE + NORMALIZE SUBMISSION
   Returns { error } or { fields } ready to $set (sensitive values encrypted).
===================================================== */
const parseSubmission = (body = {}) => {
  const method = String(body.method || "").trim().toUpperCase();
  const accountHolderName = String(body.accountHolderName || "").trim().replace(/\s+/g, " ");

  if (!["BANK", "UPI"].includes(method)) {
    return { error: "Choose bank account or UPI" };
  }
  if (!HOLDER_NAME_RE.test(accountHolderName)) {
    return { error: "Enter the account holder's name exactly as the bank shows it" };
  }

  if (method === "BANK") {
    const accountNumber = String(body.accountNumber || "").replace(/\s+/g, "");
    const ifsc = String(body.ifsc || "").trim().toUpperCase();
    const bankName = String(body.bankName || "").trim().slice(0, 100);

    if (!ACCOUNT_NUMBER_RE.test(accountNumber)) {
      return { error: "Account number must be 9 to 18 digits" };
    }
    if (!IFSC_RE.test(ifsc)) {
      return { error: "Enter a valid 11-character IFSC code (e.g. HDFC0001234)" };
    }

    return {
      fields: {
        method,
        accountHolderName,
        accountNumber: encryptField(accountNumber),
        ifsc: encryptField(ifsc),
        bankName,
        upiId: "",
      },
    };
  }

  const upiId = String(body.upiId || "").trim().toLowerCase();
  if (!UPI_RE.test(upiId)) {
    return { error: "Enter a valid UPI ID (e.g. name@okhdfcbank)" };
  }

  return {
    fields: {
      method,
      accountHolderName,
      accountNumber: "",
      ifsc: "",
      bankName: "",
      upiId: encryptField(upiId),
    },
  };
};

/* =====================================================
   GET MY PAYOUT ACCOUNT
   GET /api/partner/payout-account
===================================================== */
exports.getPayoutAccount = async (req, res) => {
  try {
    const account = await PartnerPayoutAccount.findOne({ partnerId: req.partner._id }).lean();
    return res.json({ success: true, payoutAccount: toPartnerView(account) });
  } catch (error) {
    console.error("Get payout account error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =====================================================
   ADD / REPLACE MY PAYOUT ACCOUNT
   PUT /api/partner/payout-account
   Body: { method: "BANK", accountHolderName, accountNumber, ifsc, bankName? }
      or { method: "UPI",  accountHolderName, upiId }
   Always (re)enters PENDING admin verification.
===================================================== */
exports.savePayoutAccount = async (req, res) => {
  try {
    const partnerId = req.partner._id;
    const { error, fields } = parseSubmission(req.body);
    if (error) return res.status(400).json({ success: false, message: error });

    const now = new Date();
    const existing = await PartnerPayoutAccount.findOne({ partnerId })
      .select("status withdrawalsBlockedUntil")
      .lean();

    // Never shorten a hold that's still running (otherwise replacing the
    // account a second time would clear the first change's hold).
    let withdrawalsBlockedUntil =
      existing?.withdrawalsBlockedUntil && existing.withdrawalsBlockedUntil > now
        ? existing.withdrawalsBlockedUntil
        : null;
    if (existing?.status === "VERIFIED") {
      withdrawalsBlockedUntil = new Date(now.getTime() + PAYOUT_CHANGE_HOLD_MS);
    }

    const account = await PartnerPayoutAccount.findOneAndUpdate(
      { partnerId },
      {
        $set: {
          ...fields,
          status: "PENDING",
          rejectionReason: "",
          submittedAt: now,
          verifiedAt: null,
          verifiedBy: null,
          withdrawalsBlockedUntil,
        },
        $inc: { revision: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    // Security alert on every change: if this wasn't the partner, they hear
    // about it before any money can move.
    notifyPartner(partnerId, {
      type: "PAYOUT_ACCOUNT_UPDATED",
      title: existing ? "Payout account changed" : "Payout account added",
      body: existing
        ? "Your payout account was changed and is being verified. If you didn't do this, contact QuickQare support immediately."
        : "Your payout account was added and is being verified.",
    });

    return res.json({
      success: true,
      message: "Payout account submitted. We'll verify it shortly.",
      payoutAccount: toPartnerView(account),
    });
  } catch (error) {
    console.error("Save payout account error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
