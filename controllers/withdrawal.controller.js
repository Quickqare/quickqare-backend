const Withdrawal = require("../models/Withdrawal");
const PartnerWallet = require("../models/PartnerWallet");
const WalletTransaction = require("../models/WalletTransaction");
const { encryptBankDetails, maskAccountNumber } = require("../utils/fieldCrypto");

const roundAmount = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const getWithdrawableBalance = (wallet) =>
  roundAmount(
    wallet?.withdrawableBalance !== undefined
      ? wallet.withdrawableBalance
      : wallet?.balance || 0
  );

/* =====================================================
   PARTNER REQUEST WITHDRAWAL
   POST /api/partner/withdrawal
===================================================== */
exports.requestWithdrawal = async (req, res) => {
  try {
    const AdminSetting = require("../admin/models/AdminSetting");
    const settings = await AdminSetting.findOne().lean();
    if (settings?.emergencyLockdown || settings?.payoutsFreezed) {
      return res.status(503).json({
        success: false,
        message: settings?.emergencyLockdown
          ? "Service temporarily unavailable. Please try again later."
          : "Payouts are temporarily frozen. Please try again later.",
      });
    }

    const { amount } = req.body;
    const partnerId = req.partner._id;

    /* =====================
       VALIDATE INPUT
    ===================== */
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid withdrawal amount is required",
      });
    }

    /* =====================
       CHECK WALLET
    ===================== */
    const wallet = await PartnerWallet.findOne({ partnerId });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found",
      });
    }

    const withdrawableBalance = getWithdrawableBalance(wallet);

    if (withdrawableBalance < amount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient wallet balance",
      });
    }

    /* =====================
       CHECK BANK DETAILS
    ===================== */
    if (!req.partner.bankDetails?.accountNumber) {
      return res.status(400).json({
        success: false,
        message: "Please add bank details first",
      });
    }

    /* =====================
       PREVENT MULTIPLE PENDING REQUESTS
    ===================== */
    const existingPending = await Withdrawal.findOne({
      partnerId,
      status: "PENDING",
    });

    if (existingPending) {
      return res.status(400).json({
        success: false,
        message: "You already have a pending withdrawal request",
      });
    }

    /* =====================
       CREATE WITHDRAWAL REQUEST
    ===================== */
    const withdrawal = await Withdrawal.create({
      partnerId,
      amount,
      // Encrypt the snapshot at rest. Idempotent: if req.partner.bankDetails is
      // already encrypted (saved via saveBankDetails), this is a no-op.
      bankDetails: encryptBankDetails(req.partner.bankDetails),
      status: "PENDING",
    });

    await WalletTransaction.create({
      partnerId,
      amount,
      type: "debit",
      reason: "withdrawal",
      status: "pending",
      referenceId: String(withdrawal._id),
      description: "Partner withdrawal request submitted",
    });

    res.json({
      success: true,
      message: "Withdrawal request submitted",
      withdrawal,
    });
  } catch (error) {
    console.error("Withdrawal request error:", error);
    res.status(500).json({
      success: false,
      message: "Withdrawal request failed",
    });
  }
};

/* =====================================================
   SAVE / UPDATE BANK DETAILS
   POST /api/partner/bank-details
===================================================== */
exports.saveBankDetails = async (req, res) => {
  try {
    const { accountHolderName, accountNumber, ifsc, bankName } = req.body;

    /* =====================
       VALIDATE INPUT
    ===================== */
    if (!accountHolderName || !accountNumber || !ifsc || !bankName) {
      return res.status(400).json({
        success: false,
        message: "All bank details are required",
      });
    }

    // Encrypt sensitive fields (account number, IFSC) before persisting.
    req.partner.bankDetails = encryptBankDetails({
      accountHolderName,
      accountNumber,
      ifsc,
      bankName,
    });

    await req.partner.save();

    // Never echo the full account number back — confirm with a masked value.
    res.json({
      success: true,
      message: "Bank details saved successfully",
      bankDetails: {
        accountHolderName,
        accountNumber: maskAccountNumber(accountNumber),
        ifsc,
        bankName,
      },
    });
  } catch (error) {
    console.error("Save bank details error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save bank details",
    });
  }
};
