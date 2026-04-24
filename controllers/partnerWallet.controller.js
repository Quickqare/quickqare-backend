const PartnerWallet = require("../models/PartnerWallet");
const WalletTransaction = require("../models/WalletTransaction");

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
   GET PARTNER WALLET SUMMARY
   GET /api/partner/wallet
===================================================== */
exports.getWallet = async (req, res) => {
  try {
    const partnerId = req.partner._id;

    const wallet = await PartnerWallet.findOne({ partnerId });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found",
      });
    }

    normalizeWallet(wallet);
    await wallet.save();

    res.status(200).json({
      success: true,
      wallet,
    });
  } catch (error) {
    console.error("Get wallet error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/* =====================================================
   GET WALLET TRANSACTION HISTORY
   GET /api/partner/wallet/history
===================================================== */
exports.getWalletHistory = async (req, res) => {
  try {
    const partnerId = req.partner._id;

    const transactions = await WalletTransaction.find({ partnerId })
      .sort({ createdAt: -1 })
      .limit(100);

    res.status(200).json({
      success: true,
      count: transactions.length,
      transactions,
    });
  } catch (error) {
    console.error("Get wallet history error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
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

  const wallet = await PartnerWallet.findOne({ partnerId });

  if (!wallet) {
    throw new Error("Wallet not found");
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
