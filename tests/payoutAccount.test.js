/**
 * Partner payout accounts + admin withdrawal processing.
 *
 * A withdrawal may only go to an admin-verified payout account (bank or UPI);
 * replacing a verified account holds withdrawals for 24h; an admin can never
 * verify details the partner changed after the admin loaded them; and
 * approve/reject each take effect exactly once, however many clicks race.
 */
process.env.FIELD_ENCRYPTION_KEY = "test-field-key";

jest.mock("../services/pushNotification.service", () => ({
  notifyPartner: jest.fn(),
}));

// Admin auth is covered elsewhere; here every request is a finance admin.
jest.mock("../admin/middleware/authenticateAdmin", () => {
  const mongoose = require("mongoose");
  const { getPermissionsForRole } = require("../admin/constants/permissions");
  const adminId = new mongoose.Types.ObjectId().toString();
  return (req, _res, next) => {
    req.adminUser = { id: adminId, permissions: getPermissionsForRole("FinanceAdmin") };
    next();
  };
});

const express = require("express");

const Partner = require("../models/Partner");
const PartnerWallet = require("../models/PartnerWallet");
const PartnerPayoutAccount = require("../models/PartnerPayoutAccount");
const WalletTransaction = require("../models/WalletTransaction");
const Withdrawal = require("../models/Withdrawal");
const { getPayoutAccount, savePayoutAccount } = require("../controllers/partnerPayoutAccount.controller");
const { requestWithdrawal, creditWallet } = require("../controllers/partnerWallet.controller");
const { isEncrypted, decryptField } = require("../utils/fieldCrypto");

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

let server;
let baseUrl;
let partnerId;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/payments", require("../admin/routes/v1/payments.routes"));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  const partner = await Partner.create({ name: "Ravi Kumar", phone: "9000000003", password: "Secret123" });
  partnerId = partner._id;
});

const admin = async (method, path, body) => {
  const res = await fetch(`${baseUrl}/payments${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const save = async (body) => {
  const res = mockRes();
  await savePayoutAccount({ partner: { _id: partnerId }, body }, res);
  return res;
};

const withdraw = async (amount) => {
  const res = mockRes();
  await requestWithdrawal({ partner: { _id: partnerId }, body: { amount } }, res);
  return res;
};

const BANK = { method: "BANK", accountHolderName: "Ravi Kumar", accountNumber: "123456789012", ifsc: "hdfc0001234", bankName: "HDFC" };
const UPI = { method: "UPI", accountHolderName: "Ravi Kumar", upiId: "Ravi.K@okhdfcbank" };

async function verifyCurrent(status = "VERIFIED", reason) {
  const account = await PartnerPayoutAccount.findOne({ partnerId }).lean();
  return admin("PATCH", `/payout-accounts/${account._id}/verify`, { status, revision: account.revision, reason });
}

async function fundWallet(amount) {
  await creditWallet({ partnerId, amount, reason: "bonus" });
}

/* ---------------- partner: saving an account ---------------- */

test("bank details are stored encrypted and shown to the partner masked", async () => {
  const res = await save(BANK);
  expect(res.statusCode).toBe(200);
  expect(res.body.payoutAccount).toMatchObject({
    method: "BANK",
    accountNumberMasked: "••••9012",
    ifsc: "HDFC0001234",
    status: "PENDING",
    withdrawalsBlockedUntil: null,
  });
  expect(JSON.stringify(res.body)).not.toContain("123456789012");

  const stored = await PartnerPayoutAccount.findOne({ partnerId }).lean();
  expect(isEncrypted(stored.accountNumber)).toBe(true);
  expect(isEncrypted(stored.ifsc)).toBe(true);
  expect(decryptField(stored.accountNumber)).toBe("123456789012");
  expect(stored.revision).toBe(1);
});

test("UPI IDs are normalized, encrypted and masked", async () => {
  const res = await save(UPI);
  expect(res.statusCode).toBe(200);
  expect(res.body.payoutAccount).toMatchObject({ method: "UPI", upiIdMasked: "ra••••@okhdfcbank" });

  const stored = await PartnerPayoutAccount.findOne({ partnerId }).lean();
  expect(decryptField(stored.upiId)).toBe("ravi.k@okhdfcbank");
});

test.each([
  [{ ...BANK, ifsc: "HDFC123" }, /IFSC/],
  [{ ...BANK, accountNumber: "12AB" }, /9 to 18 digits/],
  [{ ...BANK, accountHolderName: "" }, /holder's name/],
  [{ ...UPI, upiId: "not-a-upi" }, /UPI ID/],
  [{ method: "CASH", accountHolderName: "Ravi" }, /bank account or UPI/],
])("rejects invalid submission %#", async (body, message) => {
  const res = await save(body);
  expect(res.statusCode).toBe(400);
  expect(res.body.message).toMatch(message);
  expect(await PartnerPayoutAccount.countDocuments({ partnerId })).toBe(0);
});

test("GET returns null before an account exists", async () => {
  const res = mockRes();
  await getPayoutAccount({ partner: { _id: partnerId } }, res);
  expect(res.body).toEqual({ success: true, payoutAccount: null });
});

/* ---------------- withdrawal gating ---------------- */

test("withdrawal needs a verified payout account", async () => {
  await fundWallet(1000);

  expect((await withdraw(500)).body.message).toMatch(/Add your bank account or UPI/);

  await save(BANK);
  expect((await withdraw(500)).body.message).toMatch(/still being verified/);

  await verifyCurrent("REJECTED", "Name does not match");
  expect((await withdraw(500)).body.message).toMatch(/was rejected/);

  // Nothing was held by any of the refused attempts.
  const wallet = await PartnerWallet.findOne({ partnerId }).lean();
  expect(wallet.withdrawableBalance).toBe(1000);
  expect(await Withdrawal.countDocuments()).toBe(0);
});

test("a verified account's details are snapshotted onto the withdrawal", async () => {
  await fundWallet(1000);
  await save(UPI);
  expect((await verifyCurrent()).status).toBe(200);

  const res = await withdraw(600);
  expect(res.statusCode).toBe(201);

  const row = await Withdrawal.findOne({ partnerId }).lean();
  expect(row.payoutMethod).toBe("UPI");
  expect(decryptField(row.upiId)).toBe("ravi.k@okhdfcbank");
  expect(row.bankDetails.accountHolderName).toBe("Ravi Kumar");

  const listed = await admin("GET", "/withdrawals?status=PENDING");
  expect(listed.body.data[0]).toMatchObject({ payoutMethod: "UPI", upiId: "ravi.k@okhdfcbank", amount: 600 });
});

test("replacing a verified account holds withdrawals for 24h, and a second change can't clear the hold", async () => {
  await fundWallet(1000);
  await save(BANK);
  await verifyCurrent();

  const changed = await save(UPI);
  const holdUntil = new Date(changed.body.payoutAccount.withdrawalsBlockedUntil).getTime();
  expect(holdUntil).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);

  // Changing again (account is now PENDING) keeps the running hold.
  const again = await save(BANK);
  expect(new Date(again.body.payoutAccount.withdrawalsBlockedUntil).getTime()).toBe(holdUntil);

  await verifyCurrent();
  expect((await withdraw(500)).body.message).toMatch(/changed recently/);

  // Once the hold has passed, the withdrawal goes through.
  await PartnerPayoutAccount.updateOne({ partnerId }, { $set: { withdrawalsBlockedUntil: new Date(Date.now() - 1000) } });
  expect((await withdraw(500)).statusCode).toBe(201);
});

test("a single request is capped at ₹10,000", async () => {
  await fundWallet(15000);
  await save(BANK);
  await verifyCurrent();

  const over = await withdraw(10001);
  expect(over.statusCode).toBe(400);
  expect(over.body.message).toMatch(/₹10,000/);
  expect((await PartnerWallet.findOne({ partnerId }).lean()).withdrawableBalance).toBe(15000);

  expect((await withdraw(10000)).statusCode).toBe(201);
});

test("the first account is not held", async () => {
  await fundWallet(1000);
  await save(BANK);
  await verifyCurrent();
  expect((await withdraw(500)).statusCode).toBe(201);
});

/* ---------------- admin: verifying accounts ---------------- */

test("an admin can't verify details the partner changed after they were loaded", async () => {
  await save(BANK);
  const seen = await PartnerPayoutAccount.findOne({ partnerId }).lean();

  await save({ ...BANK, accountNumber: "999999999999" }); // partner edits meanwhile

  const res = await admin("PATCH", `/payout-accounts/${seen._id}/verify`, { status: "VERIFIED", revision: seen.revision });
  expect(res.status).toBe(409);
  expect((await PartnerPayoutAccount.findById(seen._id).lean()).status).toBe("PENDING");
});

test("rejecting an account needs a reason", async () => {
  await save(BANK);
  const res = await verifyCurrent("REJECTED", "");
  expect(res.status).toBe(400);
});

test("the admin list shows full details for checking", async () => {
  await save(BANK);
  const res = await admin("GET", "/payout-accounts?status=PENDING");
  expect(res.status).toBe(200);
  expect(res.body.data[0]).toMatchObject({
    partner: { name: "Ravi Kumar", phone: "9000000003" },
    accountNumber: "123456789012",
    ifsc: "HDFC0001234",
    revision: 1,
  });
});

test("deleting the partner account removes the payout details but keeps an open withdrawal's snapshot", async () => {
  const { deletePartnerAccount } = require("../controllers/partner.controller");
  await fundWallet(1000);
  await save(BANK);
  await verifyCurrent();
  await withdraw(500);

  const res = mockRes();
  await deletePartnerAccount({ partner: { _id: partnerId }, body: {} }, res);
  expect(res.statusCode).toBe(200);

  expect(await PartnerPayoutAccount.countDocuments({ partnerId })).toBe(0);
  const pending = await Withdrawal.findOne({ partnerId, status: "PENDING" }).lean();
  expect(decryptField(pending.bankDetails.accountNumber)).toBe("123456789012");
});

/* ---------------- admin: processing withdrawals ---------------- */

async function pendingWithdrawal(amount = 500) {
  await fundWallet(1000);
  await save(BANK);
  await verifyCurrent();
  expect((await withdraw(amount)).statusCode).toBe(201);
  return Withdrawal.findOne({ partnerId, status: "PENDING" }).lean();
}

test("approve requires the transfer reference", async () => {
  const w = await pendingWithdrawal();
  const res = await admin("PATCH", `/withdrawals/${w._id}/approve`, { referenceId: "  " });
  expect(res.status).toBe(400);
  expect((await Withdrawal.findById(w._id).lean()).status).toBe("PENDING");
});

test("concurrent approvals record the payout exactly once", async () => {
  const w = await pendingWithdrawal(500);

  const results = await Promise.all(
    Array.from({ length: 5 }, () => admin("PATCH", `/withdrawals/${w._id}/approve`, { referenceId: "UTR123" }))
  );
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);

  const wallet = await PartnerWallet.findOne({ partnerId }).lean();
  expect(wallet.totalWithdrawn).toBe(500);
  expect(wallet.withdrawableBalance).toBe(500);
  expect(await WalletTransaction.countDocuments({ partnerId, reason: "withdrawal" })).toBe(1);
  expect((await Withdrawal.findById(w._id).lean()).referenceId).toBe("UTR123");
});

test("concurrent rejections refund the held amount exactly once", async () => {
  const w = await pendingWithdrawal(500);

  const results = await Promise.all(
    Array.from({ length: 5 }, () => admin("PATCH", `/withdrawals/${w._id}/reject`, { reason: "Bank details mismatch" }))
  );
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);

  const wallet = await PartnerWallet.findOne({ partnerId }).lean();
  expect(wallet.withdrawableBalance).toBe(1000);
  expect(wallet.totalWithdrawn).toBe(0);
});

test("approve and reject racing: exactly one wins and the wallet matches it", async () => {
  const w = await pendingWithdrawal(500);

  await Promise.all([
    admin("PATCH", `/withdrawals/${w._id}/approve`, { referenceId: "UTR9" }),
    admin("PATCH", `/withdrawals/${w._id}/reject`, { reason: "dup" }),
  ]);

  const final = await Withdrawal.findById(w._id).lean();
  const wallet = await PartnerWallet.findOne({ partnerId }).lean();
  if (final.status === "APPROVED") {
    expect(wallet).toMatchObject({ withdrawableBalance: 500, totalWithdrawn: 500 });
  } else {
    expect(final.status).toBe("REJECTED");
    expect(wallet).toMatchObject({ withdrawableBalance: 1000, totalWithdrawn: 0 });
  }
});
