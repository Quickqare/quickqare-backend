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
    const rawAmount = Number(req.body.amount);
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid withdrawal amount" });
    }
    const amount = roundAmount(rawAmount);
    if (amount < 200) {
      return res.status(400).json({ success: false, message: "Minimum withdrawal amount is ₹200" });
    }
    if (amount > 100_000) {
      return res.status(400).json({ success: false, message: "Maximum withdrawal amount is ₹1,00,000 per request" });
    }

    await releasePendingEarnings(partnerId);

    const wallet = await PartnerWallet.findOne({ partnerId });
    if (!wallet) return res.status(404).json({ success: false, message: "Wallet not found" });

    // Persist a normalized wallet so withdrawableBalance is populated (migrates
    // any legacy balance-only doc) before the atomic hold reads that field.
    normalizeWallet(wallet);
    await wallet.save();

    // Block duplicate pending requests (product rule + cheap pre-check).
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

    // ATOMIC HOLD: reserve the amount out of the withdrawable bucket in a single
    // guarded update. The `withdrawableBalance: { $gte: amount }` filter means
    // two concurrent requests can't both pass, and the balance can never be
    // requested twice or driven negative — the old check-then-create left the
    // funds sitting in the balance until approval, so a later penalty/debit
    // could make an already-approved request un-payable (or be spent twice).
    const held = await PartnerWallet.findOneAndUpdate(
      { partnerId, withdrawableBalance: { $gte: amount } },
      [
        {
          $set: {
            withdrawableBalance: {
              $round: [{ $subtract: [{ $ifNull: ["$withdrawableBalance", 0] }, amount] }, 2],
            },
            lastUpdated: new Date(),
          },
        },
        // balance mirrors the withdrawable bucket.
        { $set: { balance: "$withdrawableBalance" } },
      ],
      { new: true }
    );

    if (!held) {
      const available = roundAmount(wallet.withdrawableBalance ?? wallet.balance ?? 0);
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available: ₹${available}`,
      });
    }

    let withdrawal;
    try {
      withdrawal = await Withdrawal.create({
        partnerId,
        amount,
        status: "PENDING",
        balanceHeld: true,
        bankDetails: {
          accountHolderName: bankDetails.accountHolderName || "",
          accountNumber: bankDetails.accountNumber,
          ifsc: bankDetails.ifsc,
          bankName: bankDetails.bankName || "",
        },
      });
    } catch (createErr) {
      // Creation failed after the hold — return the reserved funds so they
      // aren't stranded out of the partner's withdrawable balance.
      await PartnerWallet.findOneAndUpdate(
        { partnerId },
        [
          {
            $set: {
              withdrawableBalance: {
                $round: [{ $add: [{ $ifNull: ["$withdrawableBalance", 0] }, amount] }, 2],
              },
              lastUpdated: new Date(),
            },
          },
          { $set: { balance: "$withdrawableBalance" } },
        ]
      );
      throw createErr;
    }

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

  const walletBucket = String(bucket || "withdrawable").toLowerCase();
  const txnStatus = walletBucket === "pending" ? "pending" : "success";
  const isJobPayment = Boolean(bookingId) && reason === "job_payment";

  /*
   * Idempotency for job payments.
   * The ledger row is written FIRST and the unique index
   * { partnerId, bookingId, reason } makes a concurrent second credit fail here,
   * before any balance is touched. The old order (balance first, ledger second)
   * let two racing completeBooking calls both bump the balance — the findOne
   * check-then-act could not stop a true concurrent double-tap.
   */
  if (isJobPayment) {
    // Fast path: skip all work if this job was already credited.
    const existingTxn = await WalletTransaction.findOne({
      partnerId,
      bookingId,
      reason: "job_payment",
    });
    if (existingTxn) return;

    try {
      await WalletTransaction.create({
        partnerId,
        amount,
        type: "credit",
        reason,
        bookingId,
        status: txnStatus,
        description,
      });
    } catch (err) {
      // E11000 — a concurrent call already created this job_payment row.
      // Another request is crediting the balance; do not double up.
      if (err && err.code === 11000) return;
      throw err;
    }
  }

  let wallet = await PartnerWallet.findOne({ partnerId });

  if (!wallet) {
    wallet = await PartnerWallet.create({ partnerId, balance: 0, withdrawableBalance: 0, pendingBalance: 0, totalEarnings: 0, totalWithdrawn: 0 });
  }

  // Atomic credit via an $inc-style pipeline update, so a concurrent debit/credit on the
  // same wallet can't clobber this balance through a stale read-modify-write (findOne+save).
  const incField = walletBucket === "pending" ? "pendingBalance" : "withdrawableBalance";
  await PartnerWallet.findOneAndUpdate(
    { partnerId },
    [
      {
        $set: {
          [incField]: { $round: [{ $add: [{ $ifNull: [`$${incField}`, 0] }, amount] }, 2] },
          totalEarnings: { $round: [{ $add: [{ $ifNull: ["$totalEarnings", 0] }, amount] }, 2] },
          lastUpdated: new Date(),
        },
      },
      // balance mirrors the withdrawable bucket only.
      { $set: { balance: { $round: [{ $ifNull: ["$withdrawableBalance", 0] }, 2] } } },
    ],
    { new: true }
  );

  // Non-job-payment credits (bonus, adjustment, etc.) still need a ledger row.
  // job_payment rows were already written above as the idempotency guard.
  if (!isJobPayment) {
    await WalletTransaction.create({
      partnerId,
      amount,
      type: "credit",
      reason,
      bookingId,
      status: txnStatus,
      description,
    });
  }

  // Now that the partner has earned, try to collect any penalty they owe (recorded as a
  // PENDING debit when their balance was short). This nets the debt off fresh earnings so
  // the "owed" row doesn't sit forever uncollected. Only meaningful when the withdrawable
  // bucket actually grew, so skip for pending-bucket credits.
  if (walletBucket !== "pending") {
    await settleOutstandingPenalties(partnerId).catch((e) =>
      console.warn(`[wallet] settleOutstandingPenalties failed for ${partnerId}: ${e.message}`)
    );
  }
};

/* =====================================================
   SETTLE OUTSTANDING PENALTIES (INTERNAL)
   Collects any PENDING penalty debits (recorded by debitWallet's allowShortfall path
   when the balance was insufficient) from the partner's current withdrawable balance,
   oldest first. Each collection is atomic ($gte guard) and marks the ledger row settled.
===================================================== */
const settleOutstandingPenalties = async (partnerId) => {
  const owed = await WalletTransaction.find({
    partnerId,
    type: "debit",
    status: "pending",
    reason: "penalty",
  })
    .sort({ createdAt: 1 })
    .lean();

  for (const row of owed) {
    const amt = roundAmount(row.amount);
    if (amt <= 0) {
      await WalletTransaction.updateOne({ _id: row._id }, { $set: { status: "success" } });
      continue;
    }
    // Atomically deduct only if the balance fully covers this owed row.
    const wallet = await PartnerWallet.findOneAndUpdate(
      { partnerId, withdrawableBalance: { $gte: amt } },
      {
        $inc: { withdrawableBalance: -amt, balance: -amt, totalWithdrawn: amt },
        $set: { lastUpdated: new Date() },
      },
      { new: true }
    );
    if (!wallet) break; // not enough to clear this (or any later, larger) row — stop.

    await WalletTransaction.updateOne(
      { _id: row._id },
      { $set: { status: "success", description: `${row.description} [settled from later earnings]` } }
    );
  }
};
exports.settleOutstandingPenalties = settleOutstandingPenalties;

/* =====================================================
   DEBIT PARTNER WALLET (INTERNAL USE ONLY)
===================================================== */
exports.debitWallet = async ({
  partnerId,
  amount,
  reason,
  bookingId = null,
  description = "",
  allowShortfall = false,
}) => {
  if (!partnerId || !amount) {
    throw new Error("partnerId and amount are required");
  }

  const safeAmount = roundAmount(amount);

  if (!allowShortfall) {
    // Strict atomic debit: only succeeds if sufficient balance exists — prevents
    // concurrent double-spend on withdrawals / admin payouts.
    const wallet = await PartnerWallet.findOneAndUpdate(
      { partnerId, withdrawableBalance: { $gte: safeAmount } },
      {
        $inc: {
          withdrawableBalance: -safeAmount,
          balance: -safeAmount,
          totalWithdrawn: safeAmount,
        },
        $set: { lastUpdated: new Date() },
      },
      { new: true }
    );

    if (!wallet) {
      const exists = await PartnerWallet.exists({ partnerId });
      if (!exists) throw new Error("Wallet not found");
      throw new Error("Insufficient wallet balance");
    }

    await WalletTransaction.create({
      partnerId,
      amount: safeAmount,
      type: "debit",
      reason,
      bookingId,
      description,
    });

    return { collected: safeAmount, shortfall: 0, withdrawableBalance: wallet.withdrawableBalance };
  }

  /*
   * allowShortfall: a MANDATORY charge (e.g. a cancellation penalty) must never be
   * silently lost. Collect as much as the balance allows (respecting the wallet's
   * min:0 floor — a negative balance would throw on the next .save()), and record any
   * uncollected remainder as a PENDING debit ledger row: a durable "owed" record that
   * shows in wallet history and is queryable/recoverable by ops
   * (WalletTransaction.find({ type: "debit", status: "pending" })).
   */
  // Ensure the wallet exists so the atomic update below has a target.
  let wallet = await PartnerWallet.findOne({ partnerId });
  if (!wallet) {
    wallet = await PartnerWallet.create({
      partnerId, balance: 0, withdrawableBalance: 0, pendingBalance: 0, totalEarnings: 0, totalWithdrawn: 0,
    });
  }

  // Atomic collection: subtract min(withdrawableBalance, safeAmount) in a single pipeline
  // update so a concurrent credit/debit on the same wallet can't clobber the balance via a
  // stale read-modify-write. We read the PRE-image to compute exactly how much was collected
  // (the same min() the pipeline applied), then record the success/owed ledger rows.
  const pre = await PartnerWallet.findOneAndUpdate(
    { partnerId },
    [
      {
        $set: {
          withdrawableBalance: {
            $round: [
              { $subtract: [
                { $ifNull: ["$withdrawableBalance", 0] },
                { $min: [{ $ifNull: ["$withdrawableBalance", 0] }, safeAmount] },
              ] },
              2,
            ],
          },
          totalWithdrawn: {
            $round: [
              { $add: [
                { $ifNull: ["$totalWithdrawn", 0] },
                { $min: [{ $ifNull: ["$withdrawableBalance", 0] }, safeAmount] },
              ] },
              2,
            ],
          },
          lastUpdated: new Date(),
        },
      },
      { $set: { balance: "$withdrawableBalance" } },
    ],
    { new: false }
  );

  const availablePre = Math.max(0, roundAmount(pre?.withdrawableBalance || 0));
  const collected = roundAmount(Math.min(availablePre, safeAmount));
  const shortfall = roundAmount(safeAmount - collected);

  if (collected > 0) {
    await WalletTransaction.create({
      partnerId,
      amount: collected,
      type: "debit",
      reason,
      bookingId,
      status: "success",
      description: shortfall > 0
        ? `${description} (partial: ₹${collected} collected, ₹${shortfall} outstanding)`
        : description,
    });
  }

  if (shortfall > 0) {
    // Uncollected remainder — recorded as PENDING so it reads as owed, not settled.
    await WalletTransaction.create({
      partnerId,
      amount: shortfall,
      type: "debit",
      reason,
      bookingId,
      status: "pending",
      description: `${description} — OUTSTANDING (insufficient balance, ₹${shortfall} owed)`,
    });
  }

  return { collected, shortfall, withdrawableBalance: roundAmount(availablePre - collected) };
};
