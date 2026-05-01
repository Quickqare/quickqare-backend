const PartnerWallet = require("../models/PartnerWallet");
const WalletTransaction = require("../models/WalletTransaction");
const Withdrawal = require("../models/Withdrawal");
const Partner = require("../models/Partner");

const roundAmount = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const normalizeWallet = (wallet) => {
  if (!wallet) return wallet;

  const legacyBalance = Number(wallet.balance || 0);
  const withdrawableBalance = Number(
    wallet.withdrawableBalance !== undefined ? wallet.withdrawableBalance : legacyBalance
  );
  const pendingBalance = Number(wallet.pendingBalance || 0);

  wallet.withdrawableBalance = roundAmount(withdrawableBalance);
  wallet.pendingBalance = roundAmount(pendingBalance);
  wallet.balance = roundAmount(wallet.withdrawableBalance);
  wallet.totalEarnings = roundAmount(wallet.totalEarnings || 0);
  wallet.totalWithdrawn = roundAmount(wallet.totalWithdrawn || 0);
  wallet.lastUpdated = new Date();

  return wallet;
};

/* =====================================================
   RELEASE PENDING EARNINGS AFTER 48h HOLD
   Called internally before wallet reads/withdrawals
===================================================== */
const releasePendingEarnings = async (partnerId) => {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const pendingTxns = await WalletTransaction.find({
    partnerId,
    type: "credit",
    status: "pending",
    createdAt: { $lte: cutoff },
  }).lean();

  if (!pendingTxns.length) return;

  const totalToRelease = pendingTxns.reduce((sum, t) => sum + Number(t.amount || 0), 0);
  if (totalToRelease <= 0) return;

  const wallet = await PartnerWallet.findOne({ partnerId });
  if (!wallet) return;

  normalizeWallet(wallet);
  wallet.pendingBalance = roundAmount(Math.max(0, wallet.pendingBalance - totalToRelease));
  wallet.withdrawableBalance = roundAmount(wallet.withdrawableBalance + totalToRelease);
  wallet.balance = roundAmount(wallet.withdrawableBalance);
  wallet.lastUpdated = new Date();
  await wallet.save();

  await WalletTransaction.updateMany(
    { _id: { $in: pendingTxns.map((t) => t._id) } },
    { $set: { status: "success" } }
  );
};

/* =====================================================
   GET PARTNER WALLET SUMMARY
   GET /api/partner/wallet
===================================================== */
exports.getWallet = async (req, res) => {
  try {
    const partnerId = req.partner._id;

    await releasePendingEarnings(partnerId);

    let wallet = await PartnerWallet.findOne({ partnerId });

    if (!wallet) {
      wallet = await PartnerWallet.create({ partnerId, balance: 0, withdrawableBalance: 0, pendingBalance: 0, totalEarnings: 0, totalWithdrawn: 0 });
    }

    normalizeWallet(wallet);
    await wallet.save();

    res.status(200).json({
      success: true,
      wallet,
    });
  } catch (error) {
    console.error("Get wallet error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =====================================================
   GET WALLET TRANSACTION HISTORY
   GET /api/partner/wallet/history
===================================================== */
exports.getWalletHistory = async (req, res) => {
  try {
    const partnerId = req.partner._id;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Number(req.query.limit) || 30);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      WalletTransaction.find({ partnerId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WalletTransaction.countDocuments({ partnerId }),
    ]);

    res.status(200).json({
      success: true,
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Get wallet history error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =====================================================
   REQUEST WITHDRAWAL
   POST /api/partner/wallet/withdraw
===================================================== */
exports.requestWithdrawal = async (req, res) => {
  try {
    const partnerId = req.partner._id;
    const amount = roundAmount(Number(req.body.amount));

    if (!amount || amount < 200) {
      return res.status(400).json({ success: false, message: "Minimum withdrawal amount is ₹200" });
    }

    await releasePendingEarnings(partnerId);

    const wallet = await PartnerWallet.findOne({ partnerId });
    if (!wallet) return res.status(404).json({ success: false, message: "Wallet not found" });
    normalizeWallet(wallet);

    if (wallet.withdrawableBalance < amount) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available: ₹${wallet.withdrawableBalance}`,
      });
    }

    // Block duplicate pending requests
    const existing = await Withdrawal.findOne({ partnerId, status: "PENDING" });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: "You already have a pending withdrawal request. Wait for it to be processed.",
      });
    }

    const partner = await Partner.findById(partnerId).select("bankDetails").lean();
    const bankDetails = partner?.bankDetails || {};
    if (!bankDetails.accountNumber || !bankDetails.ifsc) {
      return res.status(400).json({
        success: false,
        message: "Add your bank account details before withdrawing.",
      });
    }

    const withdrawal = await Withdrawal.create({
      partnerId,
      amount,
      status: "PENDING",
      bankDetails: {
        accountHolderName: bankDetails.accountHolderName || "",
        accountNumber: bankDetails.accountNumber,
        ifsc: bankDetails.ifsc,
        bankName: bankDetails.bankName || "",
      },
    });

    res.status(201).json({
      success: true,
      message: "Withdrawal request submitted. It will be processed within 2–3 business days.",
      withdrawal,
    });
  } catch (error) {
    console.error("Request withdrawal error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =====================================================
   CREDIT PARTNER WALLET (INTERNAL USE ONLY)
===================================================== */
exports.creditWallet = async ({
  partnerId,
  amount,
  reason,
  bookingId = null,
  description = "",
  bucket = "withdrawable",
}) => {
  if (!partnerId || !amount) {
    throw new Error("partnerId and amount are required");
  }

  let wallet = await PartnerWallet.findOne({ partnerId });

  if (!wallet) {
    wallet = await PartnerWallet.create({ partnerId, balance: 0, withdrawableBalance: 0, pendingBalance: 0, totalEarnings: 0, totalWithdrawn: 0 });
  }

  const walletBucket = String(bucket || "withdrawable").toLowerCase();

  normalizeWallet(wallet);

  if (walletBucket === "pending") {
    wallet.pendingBalance = roundAmount(wallet.pendingBalance + amount);
  } else {
    wallet.withdrawableBalance = roundAmount(wallet.withdrawableBalance + amount);
  }

  wallet.totalEarnings = roundAmount(wallet.totalEarnings + amount);
  wallet.balance = roundAmount(wallet.withdrawableBalance);
  wallet.lastUpdated = new Date();

  await wallet.save();

  await WalletTransaction.create({
    partnerId,
    amount,
    type: "credit",
    reason,
    bookingId,
    status: walletBucket === "pending" ? "pending" : "success",
    description,
  });
};

/* =====================================================
   DEBIT PARTNER WALLET (INTERNAL USE ONLY)
===================================================== */
exports.debitWallet = async ({
  partnerId,
  amount,
  reason,
  bookingId = null,
  description = "",
}) => {
  if (!partnerId || !amount) {
    throw new Error("partnerId and amount are required");
  }

  const wallet = await PartnerWallet.findOne({ partnerId });

  if (!wallet) {
    throw new Error("Wallet not found");
  }

  normalizeWallet(wallet);

  if (wallet.withdrawableBalance < amount) {
    throw new Error("Insufficient wallet balance");
  }

  wallet.withdrawableBalance = roundAmount(wallet.withdrawableBalance - amount);
  wallet.balance = roundAmount(wallet.withdrawableBalance);
  wallet.totalWithdrawn = roundAmount(wallet.totalWithdrawn + amount);
  wallet.lastUpdated = new Date();

  await wallet.save();

  await WalletTransaction.create({
    partnerId,
    amount,
    type: "debit",
    reason,
    bookingId,
    description,
  });
};
