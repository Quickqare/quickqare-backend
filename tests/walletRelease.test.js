/**
 * Partner wallet: releasing matured pending earnings.
 *
 * Job payments land in pendingBalance and move to withdrawableBalance once
 * they're 48h old, on the partner's next wallet read or withdrawal request.
 * Each credit must move exactly once however many of those requests overlap,
 * and a wallet read must never write stale balances back over a concurrent
 * credit.
 */
const mongoose = require("mongoose");

const Partner = require("../models/Partner");
const PartnerWallet = require("../models/PartnerWallet");
const WalletTransaction = require("../models/WalletTransaction");
const Withdrawal = require("../models/Withdrawal");
const PartnerPayoutAccount = require("../models/PartnerPayoutAccount");
const {
  getWallet,
  requestWithdrawal,
  creditWallet,
} = require("../controllers/partnerWallet.controller");

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

let partnerId;

beforeEach(async () => {
  const partner = await Partner.create({
    name: "Partner",
    phone: "9000000002",
    password: "Secret123",
  });
  partnerId = partner._id;
  await PartnerPayoutAccount.create({
    partnerId,
    method: "BANK",
    accountHolderName: "Partner",
    accountNumber: "1234567890",
    ifsc: "HDFC0000001",
    status: "VERIFIED",
    revision: 1,
  });
});

// A job payment held in the pending bucket, `ageHours` old.
async function pendingJobPayment(amount, ageHours) {
  const bookingId = new mongoose.Types.ObjectId();
  await creditWallet({ partnerId, amount, reason: "job_payment", bookingId, bucket: "pending" });
  // createdAt is immutable through Mongoose; age the row on the raw collection.
  await WalletTransaction.collection.updateOne(
    { partnerId, bookingId },
    { $set: { createdAt: new Date(Date.now() - ageHours * 60 * 60 * 1000) } }
  );
  return bookingId;
}

async function readWallet() {
  const res = mockRes();
  await getWallet({ partner: { _id: partnerId } }, res);
  expect(res.statusCode).toBe(200);
  return res.body.wallet;
}

async function balances() {
  const wallet = await PartnerWallet.findOne({ partnerId }).lean();
  return {
    withdrawable: wallet.withdrawableBalance,
    pending: wallet.pendingBalance,
    balance: wallet.balance,
  };
}

const ledgerStatus = async (bookingId) =>
  (await WalletTransaction.findOne({ bookingId }).lean()).status;

test("overlapping wallet reads release a matured credit exactly once", async () => {
  const matured = await pendingJobPayment(500, 49);
  const fresh = await pendingJobPayment(300, 1);

  // Staggered so some reads start while others are mid-release.
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      new Promise((resolve) => setTimeout(resolve, i % 4)).then(readWallet)
    )
  );

  expect(await balances()).toEqual({ withdrawable: 500, pending: 300, balance: 500 });
  expect(await ledgerStatus(matured)).toBe("success");
  expect(await ledgerStatus(fresh)).toBe("pending");

  // Nothing is left to release on later reads.
  await readWallet();
  expect(await balances()).toEqual({ withdrawable: 500, pending: 300, balance: 500 });
});

test("a withdrawal releases matured credits once, then holds the amount", async () => {
  await pendingJobPayment(1000, 49);

  const res = mockRes();
  await requestWithdrawal({ partner: { _id: partnerId }, body: { amount: 1000 } }, res);
  expect(res.statusCode).toBe(201);

  await readWallet();
  expect(await balances()).toEqual({ withdrawable: 0, pending: 0, balance: 0 });
  expect(await Withdrawal.countDocuments({ partnerId, status: "PENDING", amount: 1000 })).toBe(1);
});

test("wallet reads don't write stale balances over concurrent credits", async () => {
  // The wallet Partner's post-save hook created, holding an unrounded float
  // (e.g. left by an $inc) that normalization must rewrite.
  await PartnerWallet.collection.updateOne(
    { partnerId },
    { $set: { withdrawableBalance: 0.1 + 0.2, balance: 0.1 + 0.2 } }
  );

  await Promise.all([
    ...Array.from({ length: 6 }, () => creditWallet({ partnerId, amount: 50, reason: "bonus" })),
    ...Array.from({ length: 6 }, readWallet),
  ]);

  expect(await balances()).toEqual({ withdrawable: 300.3, pending: 0, balance: 300.3 });
});

test("a legacy balance-only wallet keeps its balance when normalized", async () => {
  // A wallet from before the withdrawable/pending buckets existed.
  await PartnerWallet.collection.replaceOne({ partnerId }, { partnerId, balance: 750, totalEarnings: 750 });

  const wallet = await readWallet();

  expect(wallet.withdrawableBalance).toBe(750);
  expect(await balances()).toEqual({ withdrawable: 750, pending: 0, balance: 750 });
});
