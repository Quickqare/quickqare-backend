/**
 * High-priority fixes from the Oct 2026 admin audit, driven over real HTTP so
 * the router mounting itself is exercised:
 *   1. admin cancels record the refund owed; Payments lists refunds and marks them paid;
 *   3. deleting a partner is a soft delete, refused while money is outstanding,
 *      and the "wipe booking history" mode is gone;
 *   4. the "/" settings router no longer 403s every later route for other roles,
 *      FinanceAdmin can refund, and SuperAdmin can manage admin accounts;
 *   5. the 2FA attempt cap holds under parallel requests, and logins are
 *      limited per account.
 */

Object.assign(process.env, {
  R2_ACCOUNT_ID: "testaccount",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET_NAME: "test-bucket",
  JWT_SECRET: "test-jwt-secret",
  ADMIN_JWT_ACCESS_SECRET: "test-admin-access-secret",
  ADMIN_JWT_REFRESH_SECRET: "test-admin-refresh-secret",
  RESEND_API_KEY: "re_test",
  // Outside production this fixes the 2FA code and echoes it back as devCode.
  ADMIN_2FA_TEST_CODE: "246810",
});

jest.mock("../admin/services/email.service", () => ({
  sendAdminTwoFaCode: jest.fn().mockResolvedValue(undefined),
  sendOpsAlertEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/pushNotification.service", () => ({
  JOB_ALERTS_CHANNEL: "job_alerts",
  sendPartnerPush: jest.fn().mockResolvedValue(undefined),
  notifyPartner: jest.fn(),
  notifyCustomerOfBookingStatus: jest.fn(),
  sendJobAssignedPush: jest.fn(),
  sendJobCancelledPush: jest.fn(),
  sendJobCompletedPush: jest.fn(),
  sendBookingStatusPush: jest.fn(),
  sendPushNotification: jest.fn(),
  sendPromoBroadcast: jest.fn(),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const AdminUser = require("../admin/models/AdminUser");
const AdminSession = require("../admin/models/AdminSession");
const AuditLog = require("../admin/models/AuditLog");
const BookingTimeline = require("../admin/models/BookingTimeline");
const Refund = require("../admin/models/Refund");
const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const PartnerWallet = require("../models/PartnerWallet");
const User = require("../models/User");
const Withdrawal = require("../models/Withdrawal");

const PASSWORD = "Correct-Horse-1";

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", require("../admin/routes/v1"));
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/v1/admin`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

let seq = 0;

async function makeAdmin(role = "SuperAdmin") {
  seq += 1;
  const admin = await AdminUser.create({
    name: `${role} ${seq}`,
    email: `admin${seq}@test.local`,
    passwordHash: await AdminUser.hashPassword(PASSWORD),
    role,
    isActive: true,
  });
  const session = await AdminSession.create({
    adminUserId: admin._id,
    refreshExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const token = jwt.sign(
    { type: "access", sub: String(admin._id), role, sid: String(session._id) },
    process.env.ADMIN_JWT_ACCESS_SECRET,
    { expiresIn: 3600 }
  );
  return { admin, session, token };
}

async function api(method, path, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, code: json?.error?.code, data: json?.data, json };
}

function makePartner(overrides = {}) {
  seq += 1;
  return Partner.create({
    name: `Partner ${seq}`,
    phone: `98790${String(seq).padStart(5, "0")}`,
    password: "Secret123",
    approvalStatus: "APPROVED",
    ...overrides,
  });
}

async function makeBooking(overrides = {}) {
  seq += 1;
  const user = await User.create({ name: "Asha", phone: `98791${String(seq).padStart(5, "0")}` });
  const start = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return Booking.create({
    user: user._id,
    services: [{ serviceId: new mongoose.Types.ObjectId(), name: "Facial", quantity: 1, price: 500, lineTotal: 500 }],
    serviceCategory: "Salon for Women",
    baseAmount: 500,
    totalAmount: 590,
    scheduledDate: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
    scheduledTime: start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    scheduledStartAt: start,
    location: { type: "Point", coordinates: [88.3525, 22.5526] },
    pincode: "700016",
    address: "12 Park Street",
    payment: { status: "PAID", razorpay_payment_id: "pay_test123" },
    status: "SEARCHING",
    ...overrides,
  });
}

describe("role routing (fix 4)", () => {
  test("routes mounted after the '/' settings router are no longer 403 for other roles", async () => {
    const ops = await makeAdmin("OpsAdmin");
    const support = await makeAdmin("SupportAdmin");
    const finance = await makeAdmin("FinanceAdmin");

    expect((await api("GET", "/complaints", ops.token)).status).toBe(200);
    expect((await api("GET", "/hubs", ops.token)).status).toBe(200);
    expect((await api("GET", "/partner-leads", ops.token)).status).toBe(200);
    expect((await api("GET", "/referrals", ops.token)).status).toBe(200);
    expect((await api("GET", "/roles", ops.token)).status).toBe(200);
    expect((await api("GET", "/complaints", support.token)).status).toBe(200);
    expect((await api("GET", "/roles", finance.token)).status).toBe(200);
  });

  test("the settings routes themselves still need settings.manage", async () => {
    const ops = await makeAdmin("OpsAdmin");
    const root = await makeAdmin("SuperAdmin");

    expect((await api("GET", "/settings", ops.token)).status).toBe(403);
    expect((await api("PATCH", "/emergency", ops.token, { bookingsDisabled: true })).status).toBe(403);
    expect((await api("GET", "/settings", root.token)).status).toBe(200);
    expect((await api("GET", "/settings")).status).toBe(401);
  });

  test("FinanceAdmin can request a refund; bookings.assign routes stay closed to them", async () => {
    const finance = await makeAdmin("FinanceAdmin");
    const ops = await makeAdmin("OpsAdmin");
    const booking = await makeBooking({ status: "COMPLETED" });

    const refund = await api("POST", `/bookings/${booking._id}/refund`, finance.token, {
      amountInr: 100,
      reason: "partial refund",
    });
    expect(refund.status).toBe(200);
    expect(await Refund.countDocuments({ bookingId: booking._id })).toBe(1);

    expect((await api("GET", "/bookings", finance.token)).status).toBe(403);
    // …and the refund route still needs payments.refund.
    const byOps = await api("POST", `/bookings/${booking._id}/refund`, ops.token, {
      amountInr: 100,
      reason: "partial refund",
    });
    expect(byOps.status).toBe(403);
  });
});

describe("admin accounts (fix 4)", () => {
  test("only SuperAdmin can list or add admins", async () => {
    const ops = await makeAdmin("OpsAdmin");
    expect((await api("GET", "/admins", ops.token)).status).toBe(403);
    expect(
      (await api("POST", "/admins", ops.token, { name: "X", email: "x@test.local", role: "OpsAdmin", password: PASSWORD }))
        .status
    ).toBe(403);
  });

  test("add an admin: validated, unique, and the password never reaches the audit log", async () => {
    const root = await makeAdmin("SuperAdmin");

    const weak = await api("POST", "/admins", root.token, {
      name: "Meera",
      email: "meera@test.local",
      role: "SupportAdmin",
      password: "short",
    });
    expect(weak.status).toBe(400);

    const created = await api("POST", "/admins", root.token, {
      name: "Meera",
      email: "Meera@Test.local",
      role: "SupportAdmin",
      password: "a-long-enough-password",
    });
    expect(created.status).toBe(200);
    expect(created.data).toMatchObject({ email: "meera@test.local", role: "SupportAdmin", isActive: true });
    expect(created.data.passwordHash).toBeUndefined();

    const again = await api("POST", "/admins", root.token, {
      name: "Meera 2",
      email: "meera@test.local",
      role: "OpsAdmin",
      password: "a-long-enough-password",
    });
    expect(again.status).toBe(409);

    const logged = await AuditLog.find({ action: "admin.admins.create" }).lean();
    expect(logged.length).toBeGreaterThan(0);
    for (const entry of logged) {
      expect(entry.afterState).not.toContain("a-long-enough-password");
      expect(entry.afterState).toContain("[redacted]");
    }

    const list = await api("GET", "/admins", root.token);
    expect(list.data.map((row) => row.email)).toContain("meera@test.local");
  });

  test("disabling an admin or changing their role signs them out at once", async () => {
    const root = await makeAdmin("SuperAdmin");
    const ops = await makeAdmin("OpsAdmin");
    expect((await api("GET", "/partners", ops.token)).status).toBe(200);

    const demoted = await api("PATCH", `/admins/${ops.admin._id}`, root.token, { role: "SupportAdmin" });
    expect(demoted.status).toBe(200);
    expect(demoted.data.role).toBe("SupportAdmin");
    expect((await api("GET", "/partners", ops.token)).status).toBe(401);

    const support = await makeAdmin("SupportAdmin");
    const disabled = await api("PATCH", `/admins/${support.admin._id}`, root.token, { isActive: false });
    expect(disabled.data.isActive).toBe(false);
    expect((await api("GET", "/complaints", support.token)).status).toBe(401);
  });

  test("a SuperAdmin can't demote or disable themselves", async () => {
    const root = await makeAdmin("SuperAdmin");

    expect((await api("PATCH", `/admins/${root.admin._id}`, root.token, { role: "OpsAdmin" })).status).toBe(400);
    expect((await api("PATCH", `/admins/${root.admin._id}`, root.token, { isActive: false })).status).toBe(400);
    expect((await api("PATCH", `/admins/${root.admin._id}`, root.token, { name: "New Name" })).status).toBe(200);
    expect((await api("GET", "/admins", root.token)).status).toBe(200);
  });

  test("resetting another admin's password ends their sessions and takes effect", async () => {
    const root = await makeAdmin("SuperAdmin");
    const ops = await makeAdmin("OpsAdmin");

    const own = await api("POST", `/admins/${root.admin._id}/password`, root.token, { password: "brand-new-password" });
    expect(own.status).toBe(400);

    const reset = await api("POST", `/admins/${ops.admin._id}/password`, root.token, { password: "brand-new-password" });
    expect(reset.status).toBe(200);
    expect((await api("GET", "/partners", ops.token)).status).toBe(401);

    const fresh = await AdminUser.findById(ops.admin._id).select("+passwordHash");
    expect(await fresh.verifyPassword("brand-new-password")).toBe(true);
    expect(await fresh.verifyPassword(PASSWORD)).toBe(false);
  });

  test("change my password needs the current one and ends my other sessions", async () => {
    const me = await makeAdmin("OpsAdmin");
    const otherSession = await AdminSession.create({
      adminUserId: me.admin._id,
      refreshExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const wrong = await api("POST", "/auth/change-password", me.token, {
      currentPassword: "not-my-password",
      newPassword: "my-next-password-1",
    });
    expect(wrong.status).toBe(400);
    expect(wrong.code).toBe("INVALID_CURRENT_PASSWORD");

    const changed = await api("POST", "/auth/change-password", me.token, {
      currentPassword: PASSWORD,
      newPassword: "my-next-password-1",
    });
    expect(changed.status).toBe(200);

    // This session carries on; the other one is over.
    expect((await api("GET", "/auth/me", me.token)).status).toBe(200);
    expect((await AdminSession.findById(otherSession._id).lean()).isRevoked).toBe(true);
    expect((await AdminSession.findById(me.session._id).lean()).isRevoked).toBe(false);

    const fresh = await AdminUser.findById(me.admin._id).select("+passwordHash");
    expect(await fresh.verifyPassword("my-next-password-1")).toBe(true);
    // Neither password is in the audit trail.
    const logged = await AuditLog.find({ action: "admin.auth.change-password" }).lean();
    expect(JSON.stringify(logged)).not.toContain("my-next-password-1");
  });
});

describe("2FA and login limits (fix 5)", () => {
  const login = (email) => api("POST", "/auth/login", null, { email, password: PASSWORD });

  test("parallel wrong codes: only 5 are ever checked against the challenge", async () => {
    const { admin } = await makeAdmin("OpsAdmin");
    const challenge = (await login(admin.email)).data;
    expect(challenge.challengeToken).toBeTruthy();

    const guesses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        api("POST", "/auth/verify-2fa", null, { challengeToken: challenge.challengeToken, code: String(100000 + i) })
      )
    );

    expect(guesses.filter((g) => g.code === "INVALID_2FA_CODE")).toHaveLength(5);
    expect(guesses.filter((g) => g.code === "TOO_MANY_2FA_ATTEMPTS")).toHaveLength(5);

    // Locked for good: even the right code is refused now.
    const late = await api("POST", "/auth/verify-2fa", null, {
      challengeToken: challenge.challengeToken,
      code: challenge.devCode,
    });
    expect(late.status).toBe(429);
  });

  test("the right code still signs in after a couple of typos, and the challenge is single-use", async () => {
    const { admin } = await makeAdmin("FinanceAdmin");
    const challenge = (await login(admin.email)).data;
    const verify = (code) =>
      api("POST", "/auth/verify-2fa", null, { challengeToken: challenge.challengeToken, code });

    expect((await verify("111111")).code).toBe("INVALID_2FA_CODE");
    expect((await verify("222222")).code).toBe("INVALID_2FA_CODE");

    const ok = await verify(challenge.devCode);
    expect(ok.status).toBe(200);
    expect(ok.data.admin.role).toBe("FinanceAdmin");
    expect((await api("GET", "/auth/me", ok.data.accessToken)).status).toBe(200);

    expect((await verify(challenge.devCode)).code).toBe("CHALLENGE_EXPIRED");
  });

  test("logins are capped per account, whatever IP they come from", async () => {
    const { admin } = await makeAdmin("SupportAdmin");
    const other = await makeAdmin("SupportAdmin");

    for (let i = 0; i < 10; i += 1) {
      expect((await login(admin.email)).status).toBe(200);
    }
    const eleventh = await login(admin.email);
    expect(eleventh.status).toBe(429);
    expect(eleventh.code).toBe("TOO_MANY_LOGIN_ATTEMPTS");

    // A different account is unaffected.
    expect((await login(other.admin.email)).status).toBe(200);
  });
});

describe("customer refunds (fix 1)", () => {
  test("admin cancel of a paid booking records the full refund owed", async () => {
    const root = await makeAdmin("SuperAdmin");
    const booking = await makeBooking();

    const res = await api("POST", `/bookings/${booking._id}/cancel`, root.token, { reason: "$100 goodwill — ops error" });
    expect(res.status).toBe(200);

    const after = await Booking.findById(booking._id).lean();
    expect(after.status).toBe("CANCELLED");
    expect(after.cancelledBy).toBe("admin");
    expect(after.refundStatus).toBe("PENDING");
    expect(after.refundAmount).toBe(590);
    // Typed text is stored as typed, never read as a "$field" path.
    expect(after.cancelReason).toBe("$100 goodwill — ops error");
  });

  test("a paid on-site estimate is part of what is owed", async () => {
    const root = await makeAdmin("SuperAdmin");
    const booking = await makeBooking({
      status: "IN_PROGRESS",
      estimatePayment: { status: "PAID", totalAmount: 410, razorpay_payment_id: "pay_est1" },
    });

    const res = await api("POST", `/bookings/${booking._id}/force-cancel`, root.token, { reason: "partner walked out" });
    // Force-cancel used to answer 500 here: its timeline event wasn't an allowed type.
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ status: "CANCELLED", refundStatus: "PENDING", refundAmount: 1000 });
    expect(await BookingTimeline.countDocuments({ bookingId: booking._id, eventType: "FORCE_CANCELLED" })).toBe(1);
  });

  test("no refund is recorded for an unpaid booking, or when the admin opts out", async () => {
    const root = await makeAdmin("SuperAdmin");
    const unpaid = await makeBooking({ payment: { status: "PENDING" }, status: "PENDING_PAYMENT" });
    const noRefund = await makeBooking();

    await api("POST", `/bookings/${unpaid._id}/cancel`, root.token, { reason: "abandoned" });
    await api("POST", `/bookings/${noRefund._id}/force-cancel`, root.token, { reason: "customer abuse", refund: false });

    expect((await Booking.findById(unpaid._id).lean()).refundStatus).toBe("NONE");
    const kept = await Booking.findById(noRefund._id).lean();
    expect(kept.status).toBe("CANCELLED");
    expect(kept.refundStatus).toBe("NONE");
    expect(kept.refundAmount).toBe(0);
  });

  test("Payments lists refunds owed and marks one paid exactly once", async () => {
    const finance = await makeAdmin("FinanceAdmin");
    const ops = await makeAdmin("OpsAdmin");
    const owed = await makeBooking({
      status: "CANCELLED",
      cancelledBy: "user",
      cancelledAt: new Date(),
      cancelReason: "Change of plans",
      refundStatus: "PENDING",
      refundAmount: 442.5,
    });
    await makeBooking({ status: "COMPLETED" }); // nothing owed

    expect((await api("GET", "/payments/refunds", ops.token)).status).toBe(403);

    const list = await api("GET", "/payments/refunds?status=PENDING", finance.token);
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      bookingId: String(owed._id),
      refundAmount: 442.5,
      refundStatus: "PENDING",
      reason: "Change of plans",
      cancelledBy: "user",
      paymentId: "pay_test123",
      customer: { name: "Asha" },
    });

    const noRef = await api("POST", `/payments/refunds/${owed._id}/complete`, finance.token, {});
    expect(noRef.status).toBe(400);

    const [first, second] = await Promise.all([
      api("POST", `/payments/refunds/${owed._id}/complete`, finance.token, { referenceId: "rfnd_abc" }),
      api("POST", `/payments/refunds/${owed._id}/complete`, finance.token, { referenceId: "rfnd_abc" }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 400]);

    const after = await Booking.findById(owed._id).lean();
    expect(after.refundStatus).toBe("PROCESSED");
    expect(after.refundProcessedAt).toBeTruthy();
    expect(after.payment.razorpay_refund_id).toBe("rfnd_abc");
    expect(await BookingTimeline.countDocuments({ bookingId: owed._id, eventType: "REFUND_COMPLETED" })).toBe(1);

    expect((await api("GET", "/payments/refunds", finance.token)).data).toHaveLength(0);
    expect((await api("GET", "/payments/refunds?status=PROCESSED", finance.token)).data).toHaveLength(1);
  });

  test("a refund requested by hand shows its reason and is closed with the booking", async () => {
    const finance = await makeAdmin("FinanceAdmin");
    const booking = await makeBooking({ status: "COMPLETED" });

    await api("POST", `/bookings/${booking._id}/refund`, finance.token, { amountInr: 150, reason: "AC still leaking" });

    const list = await api("GET", "/payments/refunds", finance.token);
    expect(list.data[0]).toMatchObject({ bookingId: String(booking._id), refundAmount: 150, reason: "AC still leaking" });

    await api("POST", `/payments/refunds/${booking._id}/complete`, finance.token, { referenceId: "rfnd_xyz" });
    expect((await Refund.findOne({ bookingId: booking._id }).lean()).status).toBe("COMPLETED");
  });
});

describe("partner delete (fix 3)", () => {
  test("wiping booking history is refused and touches nothing", async () => {
    const root = await makeAdmin("SuperAdmin");
    const partner = await makePartner();
    const booking = await makeBooking({ partner: partner._id, status: "COMPLETED" });

    const res = await api("DELETE", `/partners/${partner._id}?cascade=true`, root.token);
    expect(res.status).toBe(400);
    expect(res.code).toBe("CASCADE_NOT_SUPPORTED");
    expect(await Booking.countDocuments({ _id: booking._id })).toBe(1);
    expect((await Partner.findById(partner._id).lean()).isDeleted).toBe(false);
  });

  test("refused while the partner has wallet money or a pending withdrawal", async () => {
    const root = await makeAdmin("SuperAdmin");
    const withBalance = await makePartner();
    await PartnerWallet.updateOne(
      { partnerId: withBalance._id },
      { $set: { withdrawableBalance: 1200, balance: 1200, pendingBalance: 300.5 } },
      { upsert: true }
    );
    const withRequest = await makePartner();
    await Withdrawal.create({ partnerId: withRequest._id, amount: 500, status: "PENDING", balanceHeld: true });

    const a = await api("DELETE", `/partners/${withBalance._id}`, root.token);
    expect(a.status).toBe(409);
    expect(a.code).toBe("PARTNER_HAS_BALANCE");
    expect(a.json.error.message).toContain("₹1500.5");

    const b = await api("DELETE", `/partners/${withRequest._id}`, root.token);
    expect(b.status).toBe(409);
    expect(b.code).toBe("PARTNER_HAS_BALANCE");

    expect((await Partner.findById(withBalance._id).lean()).isDeleted).toBe(false);
  });

  test("delete anonymises the account, frees the phone, and keeps the records", async () => {
    const root = await makeAdmin("SuperAdmin");
    const partner = await makePartner();
    const phone = partner.phone;
    const done = await makeBooking({ partner: partner._id, status: "COMPLETED" });

    const res = await api("DELETE", `/partners/${partner._id}`, root.token);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ deleted: true, phone, unassignedBookings: 0 });

    const after = await Partner.findById(partner._id).lean();
    expect(after).toMatchObject({
      isDeleted: true,
      isBlocked: true,
      name: "Deleted Partner",
      phone: `deleted_${partner._id}`,
    });
    expect(await PartnerWallet.countDocuments({ partnerId: partner._id })).toBe(1);
    expect((await Booking.findById(done._id).lean()).status).toBe("COMPLETED");

    // Gone from the list, the number can register again, and it can't be deleted twice.
    const list = await api("GET", "/partners", root.token);
    expect(list.data.map((row) => row.id)).not.toContain(String(partner._id));
    await expect(makePartner({ phone })).resolves.toBeTruthy();
    expect((await api("DELETE", `/partners/${partner._id}`, root.token)).status).toBe(404);
  });

  test("active bookings still need force, which sends them back to searching", async () => {
    const root = await makeAdmin("SuperAdmin");
    const partner = await makePartner();
    const live = await makeBooking({ partner: partner._id, status: "ASSIGNED" });

    const blocked = await api("DELETE", `/partners/${partner._id}`, root.token);
    expect(blocked.status).toBe(409);
    expect(blocked.code).toBe("PARTNER_HAS_ACTIVE_BOOKINGS");

    const forced = await api("DELETE", `/partners/${partner._id}?force=true`, root.token);
    expect(forced.status).toBe(200);
    expect(forced.data.unassignedBookings).toBe(1);
    const after = await Booking.findById(live._id).lean();
    expect(after.status).toBe("SEARCHING");
    expect(after.partner).toBeNull();
  });
});
