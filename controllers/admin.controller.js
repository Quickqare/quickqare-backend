const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const PartnerWallet = require("../models/PartnerWallet");
const WalletTransaction = require("../models/WalletTransaction");
const Withdrawal = require("../models/Withdrawal");
const { syncPartnerOperationalState } = require("../services/scheduling_service");

const roundAmount = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const normalizeWallet = (wallet) => {
  if (!wallet) return wallet;
  wallet.withdrawableBalance = roundAmount(
    wallet.withdrawableBalance !== undefined ? wallet.withdrawableBalance : wallet.balance || 0
  );
  wallet.pendingBalance = roundAmount(wallet.pendingBalance || 0);
  wallet.balance = roundAmount(wallet.withdrawableBalance);
  wallet.totalEarnings = roundAmount(wallet.totalEarnings || 0);
  wallet.totalWithdrawn = roundAmount(wallet.totalWithdrawn || 0);
  return wallet;
};

/* =====================================================
   1. GET ALL BOOKINGS (UPDATED FOR MULTI SERVICE)
===================================================== */
exports.getAllBookings = async (req, res) => {
  try {
    const bookings = await Booking.find()
      .populate("user")
      .populate("partner")
      .populate("primaryService") // NEW
      .populate("services.serviceId") // NEW
      .sort({ createdAt: -1 });

    res.json({ success: true, bookings });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* =====================================================
   2. GET BOOKING DETAILS (UPDATED FOR MULTI SERVICE)
===================================================== */
exports.getBookingDetails = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId)
      .populate("user")
      .populate("partner")
      .populate("primaryService") // NEW
      .populate("services.serviceId"); // NEW

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    res.json({ success: true, booking });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* =====================================================
   3. FORCE ASSIGN PARTNER (NO CHANGE IN LOGIC)
===================================================== */
exports.forceAssignPartner = async (req, res) => {
  try {
    const { bookingId, partnerId } = req.body;

    const booking = await Booking.findById(bookingId);
    const partner = await Partner.findById(partnerId);

    if (!booking || !partner) {
      return res.status(404).json({
        message: "Booking or Partner not found",
      });
    }

    if (booking.partner) {
      return res.status(400).json({
        message: "Booking already assigned",
      });
    }

    const autoAccepted = Boolean(partner.autoAccept);

    booking.partner = partner._id;
    booking.status = autoAccepted ? "PARTNER_ACCEPTED" : "ASSIGNED";
    booking.assignedAt = new Date();
    booking.assignmentAudit = Array.isArray(booking.assignmentAudit)
      ? booking.assignmentAudit
      : [];
    booking.assignmentAudit.push({
      stage: booking.assignmentStage || 1,
      event: "ADMIN_FORCE_ASSIGN",
      searchedPincodes: [String(booking.pincode || "").trim()].filter(Boolean),
      selectedPartnerId: partner._id,
      notes: `Assigned manually by admin${autoAccepted ? " with auto-accept enabled" : ""}`,
      candidates: [
        {
          partnerId: partner._id,
          score: 100,
          skillMatchLevel: 3,
          distanceMeters: null,
          activeJobs: Number(partner.activeJobs || 0),
          rating: Number(partner.rating || 0),
          fairnessScore: 100,
          reliabilityScore: 100,
          inPrimaryPincode: true,
          autoAccept,
        },
      ],
    });
    await booking.save();

    partner.lastAssignedAt = new Date();

    await partner.save();
    await syncPartnerOperationalState(partner._id);

    res.json({
      success: true,
      message: "Partner force assigned successfully",
      booking,
    });
  } catch (err) {
    console.error("Force assign error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* =====================================================
   4. GET ALL PARTNERS
===================================================== */
exports.getAllPartners = async (req, res) => {
  try {
    const partners = await Partner.find().sort({ createdAt: -1 });
    res.json({ success: true, partners });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* =====================================================
   5. BLOCK PARTNER
===================================================== */
exports.blockPartner = async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.partnerId);

    if (!partner) {
      return res.status(404).json({ message: "Partner not found" });
    }

    partner.isBlocked = true;
    await partner.save();

    res.json({
      success: true,
      message: "Partner blocked",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* =====================================================
   6. UNBLOCK PARTNER
===================================================== */
exports.unblockPartner = async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.partnerId);

    if (!partner) {
      return res.status(404).json({ message: "Partner not found" });
    }

    partner.isBlocked = false;
    partner.weeklyCancelCount = 0;

    await partner.save();

    res.json({
      success: true,
      message: "Partner unblocked and cancel count reset",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* =====================================================
   7. ADJUST PARTNER WALLET
===================================================== */
exports.adjustWallet = async (req, res) => {
  try {
    const { partnerId, amount, type, reason } = req.body;

    const wallet = await PartnerWallet.findOne({ partnerId });

    if (!wallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    normalizeWallet(wallet);

    if (type === "credit") {
      wallet.withdrawableBalance += amount;
      wallet.balance = wallet.withdrawableBalance;
      wallet.totalEarnings += amount;
    } else {
      if (wallet.withdrawableBalance < amount) {
        return res.status(400).json({
          message: "Insufficient wallet balance",
        });
      }

      wallet.withdrawableBalance -= amount;
      wallet.balance = wallet.withdrawableBalance;
      wallet.totalWithdrawn += amount;
    }

    await wallet.save();

    await WalletTransaction.create({
      partnerId,
      amount,
      type,
      reason,
      description: "Admin manual adjustment",
    });

    res.json({
      success: true,
      message: "Wallet adjusted successfully",
      wallet,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* =====================================================
   8. GET ALL WITHDRAWAL REQUESTS
===================================================== */
exports.getWithdrawals = async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find()
      .populate("partnerId")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      withdrawals,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* =====================================================
   9. APPROVE / REJECT WITHDRAWAL
===================================================== */
exports.processWithdrawal = async (req, res) => {
  try {
    const { withdrawalId, status, reason, referenceId } = req.body;

    const withdrawal = await Withdrawal.findById(withdrawalId);

    if (!withdrawal) {
      return res.status(404).json({
        message: "Withdrawal not found",
      });
    }

    if (withdrawal.status !== "PENDING") {
      return res.status(400).json({
        message: "Already processed",
      });
    }

    if (status === "APPROVED") {
      const wallet = await PartnerWallet.findOne({
        partnerId: withdrawal.partnerId,
      });

      normalizeWallet(wallet);

      if (!wallet || wallet.withdrawableBalance < withdrawal.amount) {
        return res.status(400).json({
          message: "Insufficient wallet balance",
        });
      }

      wallet.withdrawableBalance = roundAmount(
        wallet.withdrawableBalance - withdrawal.amount
      );
      wallet.balance = roundAmount(wallet.withdrawableBalance);
      wallet.totalWithdrawn = roundAmount(wallet.totalWithdrawn + withdrawal.amount);
      await wallet.save();

      withdrawal.status = "APPROVED";
      withdrawal.referenceId = String(referenceId || withdrawal.referenceId || "");
      withdrawal.processedAt = new Date();
      withdrawal.processedBy = req.admin?.id || req.adminUser?.id || null;

      const transaction = await WalletTransaction.findOne({
        partnerId: withdrawal.partnerId,
        referenceId: String(withdrawal._id),
        reason: "withdrawal",
      }).sort({ createdAt: -1 });

      if (transaction) {
        transaction.status = "success";
        transaction.referenceId = String(withdrawal.referenceId || transaction.referenceId || "");
        transaction.description = "Partner withdrawal paid";
        await transaction.save();
      }
    } else {
      withdrawal.status = "REJECTED";
      withdrawal.reason = reason || "Rejected by admin";
      withdrawal.processedAt = new Date();
      withdrawal.processedBy = req.admin?.id || req.adminUser?.id || null;

      const transaction = await WalletTransaction.findOne({
        partnerId: withdrawal.partnerId,
        referenceId: String(withdrawal._id),
        reason: "withdrawal",
      }).sort({ createdAt: -1 });

      if (transaction) {
        transaction.status = "failed";
        transaction.description = withdrawal.reason;
        await transaction.save();
      }
    }

    await withdrawal.save();

    res.json({
      success: true,
      message: `Withdrawal ${withdrawal.status.toLowerCase()}`,
      withdrawal,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
