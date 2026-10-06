/**
 * Medium / low fixes from the Oct 2026 admin audit, driven over real HTTP:
 *   8.  refunds can't pass what the customer paid; a dispute resolves once; a
 *       dispute or complaint refund is a real refund in the finance queue;
 *   9.  audit entries record how the action went, the three unlogged routes
 *       are logged, and SuperAdmin can read the log;
 *   11. a session has a hard end, and a replayed refresh token ends it;
 *   14. coupon rules are validated on create and edit;
 *   15. image upload needs a role that has something to upload;
 *   16. partner wallet balance, and complaint photos actually being stored.
 */

Object.assign(process.env, {
  R2_ACCOUNT_ID: "testaccount",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET_NAME: "test-bucket",
  R2_PUBLIC_URL: "https://media.quickqare.test",
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
const Dispute = require("../admin/models/Dispute");
const Refund = require("../admin/models/Refund");
const Booking = require("../models/Booking");
const Complaint = require("../models/Complaint");
const Coupon = require("../models/coupon");
const Partner = require("../models/Partner");
const PartnerWallet = require("../models/PartnerWallet");
const Policy = require("../models/Policy");
const User = require("../models/User");
const { createComplaint } = require("../controllers/complaint.controller");

const PASSWORD = "Correct-Horse-1";
const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let server;
let origin;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/upload", require("../routes/uploadRoutes"));
  app.use("/api/v1/admin", require("../admin/routes/v1"));
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  base = `${origin}/api/v1/admin`;
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

async function call(method, url, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return {
    status: res.status,
    code: json?.error?.code,
    message: json?.error?.message || json?.message,
    data: json?.data,
    json,
  };
}
const api = (method, path, token, body) => call(method, `${base}${path}`, token, body);

async function makeBooking(overrides = {}) {
  seq += 1;
  const user = await User.create({ name: "Asha", phone: `98792${String(seq).padStart(5, "0")}` });
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
    status: "COMPLETED",
    ...overrides,
  });
}

// The audit outcome is written just after the response goes out.
async function auditEntry(filter) {
  for (let i = 0; i < 40; i += 1) {
    const entry = await AuditLog.findOne(filter).sort({ _id: -1 }).lean();
    if (entry?.outcome) return entry;
    await sleep(25);
  }
  return AuditLog.findOne(filter).sort({ _id: -1 }).lean();
}

describe("refunds stay within what was paid (fix 8)", () => {
  const refund = (booking, token, amountInr, reason = "goodwill refund") =>
    api("POST", `/bookings/${booking._id}/refund`, token, { amountInr, reason });

  test("a refund can't exceed the amount paid, and an unpaid booking can't be refunded", async () => {
    const { token } = await makeAdmin("FinanceAdmin");
    const paid = await makeBooking();
    const unpaid = await makeBooking({ payment: { status: "PENDING" }, status: "CANCELLED" });

    const tooMuch = await refund(paid, token, 99999);
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.code).toBe("REFUND_EXCEEDS_PAID");
    expect(tooMuch.message).toContain("590");

    const none = await refund(unpaid, token, 100);
    expect(none.status).toBe(400);
    expect(none.code).toBe("BOOKING_NOT_PAID");

    expect((await refund(paid, token, 590)).status).toBe(200);
    expect((await refund(paid, token, 1)).code).toBe("REFUND_EXCEEDS_PAID");
    expect(await Refund.countDocuments()).toBe(1);
    expect((await Booking.findById(unpaid._id).lean()).refundStatus).toBe("NONE");
  });

  test("a second refund is added to the first: only the new part is owed, and the total is still capped", async () => {
    const { token } = await makeAdmin("FinanceAdmin");
    const booking = await makeBooking();
    const queue = async () => (await api("GET", "/payments/refunds", token)).data;
    const settle = (referenceId) =>
      api("POST", `/payments/refunds/${booking._id}/complete`, token, { referenceId });

    await refund(booking, token, 100);
    expect((await queue())[0]).toMatchObject({ refundAmount: 100, alreadyRefunded: 0 });
    expect((await settle("rfnd_first")).data).toMatchObject({ refundStatus: "PROCESSED", settledAmount: 100 });

    await refund(booking, token, 200);
    const [row] = await queue();
    // ₹200 to pay now — not ₹300 — and the first refund's id isn't offered as this one's.
    expect(row).toMatchObject({ refundAmount: 200, alreadyRefunded: 100, refundReference: null });

    expect((await settle("rfnd_second")).data.settledAmount).toBe(200);
    expect(await Booking.findById(booking._id).lean()).toMatchObject({
      refundStatus: "PROCESSED",
      refundAmount: 300,
      refundedAmount: 300,
    });

    expect((await refund(booking, token, 291)).code).toBe("REFUND_EXCEEDS_PAID");
    expect((await refund(booking, token, 290)).status).toBe(200);
  });

  test("two refunds racing each other can't add up to more than was paid", async () => {
    const { token } = await makeAdmin("FinanceAdmin");
    const booking = await makeBooking();

    const results = await Promise.all([refund(booking, token, 400), refund(booking, token, 400)]);

    expect(results.map((r) => r.status).sort()).not.toEqual([200, 200]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await Booking.findById(booking._id).lean()).refundAmount).toBe(400);
    expect(await Refund.countDocuments({ bookingId: booking._id })).toBe(1);
  });

  test("an admin cancel after a partial refund records the rest of what was paid", async () => {
    const root = await makeAdmin("SuperAdmin");
    const booking = await makeBooking({ status: "ASSIGNED" });

    await refund(booking, root.token, 100);
    await api("POST", `/payments/refunds/${booking._id}/complete`, root.token, { referenceId: "rfnd_goodwill" });

    const cancelled = await api("POST", `/bookings/${booking._id}/force-cancel`, root.token, { reason: "no partner free" });
    expect(cancelled.data).toMatchObject({ refundStatus: "PENDING", refundAmount: 590, refundedAmount: 100 });

    const [row] = (await api("GET", "/payments/refunds", root.token)).data;
    expect(row).toMatchObject({ refundAmount: 490, alreadyRefunded: 100, refundReference: null });
  });

  test("a dispute resolves once, and its refund reaches the finance queue", async () => {
    const support = await makeAdmin("SupportAdmin");
    const finance = await makeAdmin("FinanceAdmin");
    const booking = await makeBooking();
    const dispute = await Dispute.create({ bookingId: booking._id, status: "OPEN" });
    const resolve = (body) => api("POST", `/disputes/${dispute._id}/resolve`, support.token, body);

    const [first, second] = await Promise.all([
      resolve({ resolution: "REFUND", notes: "partner no-show", refundAmountInr: 300 }),
      resolve({ resolution: "REFUND", notes: "partner no-show", refundAmountInr: 300 }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect((await resolve({ resolution: "NO_ACTION" })).code).toBe("ALREADY_RESOLVED");

    expect(await Refund.countDocuments({ bookingId: booking._id })).toBe(1);
    expect(await Booking.findById(booking._id).lean()).toMatchObject({ refundStatus: "PENDING", refundAmount: 300 });
    const after = await Dispute.findById(dispute._id).lean();
    expect(after).toMatchObject({ status: "RESOLVED", resolution: "REFUND" });
    expect(after.events).toHaveLength(1);

    const owed = (await api("GET", "/payments/refunds", finance.token)).data;
    expect(owed[0]).toMatchObject({ bookingId: String(booking._id), refundAmount: 300, reason: "partner no-show" });
  });

  test("a dispute refund that is refused leaves the dispute open", async () => {
    const support = await makeAdmin("SupportAdmin");
    const booking = await makeBooking();
    const dispute = await Dispute.create({ bookingId: booking._id, status: "IN_REVIEW" });

    const res = await api("POST", `/disputes/${dispute._id}/resolve`, support.token, {
      resolution: "REFUND",
      refundAmountInr: 5000,
    });
    expect(res.status).toBe(400);
    expect(res.code).toBe("REFUND_EXCEEDS_PAID");

    const after = await Dispute.findById(dispute._id).lean();
    expect(after).toMatchObject({ status: "IN_REVIEW", resolution: null, resolvedAt: null });
    expect(after.events).toHaveLength(0);
    expect(await Refund.countDocuments()).toBe(0);
  });

  test("a complaint refund is recorded once on the booking, capped, and queued for finance", async () => {
    const support = await makeAdmin("SupportAdmin");
    const finance = await makeAdmin("FinanceAdmin");
    const booking = await makeBooking();
    const complaint = await Complaint.create({
      orderId: booking._id,
      userId: booking.user,
      issueType: "SERVICE_QUALITY_ISSUE",
      description: "Facial kit was not sealed",
      status: "IN_PROGRESS",
    });
    const resolve = (body) => api("PATCH", `/complaints/${complaint._id}/resolution`, support.token, body);

    const tooMuch = await resolve({ resolution: "Refunding in full", refundAmount: 5000 });
    expect(tooMuch.status).toBe(400);
    expect(await Complaint.findById(complaint._id).lean()).toMatchObject({ status: "IN_PROGRESS", refundAmount: 0 });
    expect((await resolve({ resolution: "x", refundAmount: -5 })).status).toBe(400);

    const ok = await resolve({ resolution: "Partial refund for the kit", refundAmount: 150 });
    expect(ok.status).toBe(200);
    expect(await Complaint.findById(complaint._id).lean()).toMatchObject({ status: "RESOLVED", refundAmount: 150 });
    expect(await Booking.findById(booking._id).lean()).toMatchObject({ refundStatus: "PENDING", refundAmount: 150 });

    // Saving the resolution again doesn't add a second refund; changing the amount is refused.
    expect((await resolve({ resolution: "Partial refund for the kit (updated)", refundAmount: 150 })).status).toBe(200);
    expect((await resolve({ resolution: "More", refundAmount: 200 })).status).toBe(400);
    expect(await Refund.countDocuments({ bookingId: booking._id })).toBe(1);
    expect((await Booking.findById(booking._id).lean()).refundAmount).toBe(150);

    const owed = (await api("GET", "/payments/refunds", finance.token)).data;
    expect(owed[0]).toMatchObject({ refundAmount: 150, reason: "Complaint: Partial refund for the kit" });
  });
});

describe("audit trail (fix 9)", () => {
  test("an entry records whether the action worked", async () => {
    const root = await makeAdmin("SuperAdmin");
    const partner = await Partner.create({ name: "P", phone: "9879300001", password: "Secret123" });

    await api("DELETE", `/partners/${partner._id}?cascade=true`, root.token); // refused: 400
    const refused = await auditEntry({ action: "admin.partners.delete" });
    expect(refused).toMatchObject({ outcome: "failed", statusCode: 400 });

    await api("DELETE", `/partners/${partner._id}`, root.token);
    const done = await auditEntry({ action: "admin.partners.delete", _id: { $ne: refused._id } });
    expect(done).toMatchObject({ outcome: "success", statusCode: 200 });
  });

  test("complaint, policy and referral-reward changes are logged", async () => {
    const root = await makeAdmin("SuperAdmin");
    const booking = await makeBooking();
    const complaint = await Complaint.create({
      orderId: booking._id,
      userId: booking.user,
      issueType: "OTHER",
      description: "Late arrival",
    });

    await api("PATCH", `/complaints/${complaint._id}/status`, root.token, { status: "UNDER_REVIEW" });
    await api("POST", "/policies/terms", root.token, { title: "Terms", content: "New terms text" });
    await api("PUT", "/referrals/referral-settings", root.token, { referrerRewardAmount: 75 });

    expect(await auditEntry({ action: "admin.complaints.status" })).toMatchObject({
      entityId: String(complaint._id),
      outcome: "success",
    });
    const policyEntry = await auditEntry({ action: "admin.policies.update" });
    expect(policyEntry).toMatchObject({ entityId: "terms", outcome: "success" });
    expect(policyEntry.afterState).toContain("New terms text");
    expect(await auditEntry({ action: "admin.referrals.settings" })).toMatchObject({ outcome: "success" });

    // …and the policy itself now remembers who last changed it.
    expect(String((await Policy.findOne({ type: "terms" }).lean()).lastUpdatedBy)).toBe(String(root.admin._id));
  });

  test("SuperAdmin can read the log; other roles can't; passwords never appear in it", async () => {
    const root = await makeAdmin("SuperAdmin");
    const ops = await makeAdmin("OpsAdmin");

    await api("POST", "/admins", root.token, {
      name: "Meera",
      email: "meera@test.local",
      role: "SupportAdmin",
      password: "a-long-enough-password",
    });
    await auditEntry({ action: "admin.admins.create" });
    await api("POST", "/auth/login", null, { email: root.admin.email, password: "wrong-password" });

    expect((await api("GET", "/activity", ops.token)).status).toBe(403);

    const all = await api("GET", "/activity", root.token);
    expect(all.status).toBe(200);
    expect(JSON.stringify(all.json)).not.toContain("a-long-enough-password");
    const created = all.data.find((row) => row.action === "admin.admins.create");
    expect(created).toMatchObject({
      outcome: "success",
      statusCode: 200,
      actor: { email: root.admin.email },
      body: { email: "meera@test.local", password: "[redacted]" },
    });

    const failed = await api("GET", "/activity?outcome=failed&q=login", root.token);
    expect(failed.data).toHaveLength(1);
    expect(failed.data[0]).toMatchObject({ action: "admin.auth.login", outcome: "failed", detail: "invalid_password" });
    expect(all.json.meta.pagination.total).toBeGreaterThanOrEqual(2);
  });
});

describe("sessions (fix 11)", () => {
  async function signIn(extra = {}) {
    const { admin } = await makeAdmin("OpsAdmin");
    const challenge = (await api("POST", "/auth/login", null, { email: admin.email, password: PASSWORD })).data;
    const verified = await api("POST", "/auth/verify-2fa", null, {
      challengeToken: challenge.challengeToken,
      code: challenge.devCode,
      ...extra,
    });
    // A refresh token is a JWT stamped to the second: wait one out so the
    // rotated token is a different string from the one it replaces.
    await sleep(1100);
    return { admin, tokens: verified.data };
  }
  const refresh = (refreshToken) => api("POST", "/auth/refresh", null, { refreshToken });

  test("a replayed refresh token ends the session when the panel coordinates its tabs", async () => {
    const { tokens } = await signIn({ refreshCoordinated: true });

    const rotated = await refresh(tokens.refreshToken);
    expect(rotated.status).toBe(200);
    expect(rotated.data.refreshToken).not.toBe(tokens.refreshToken);

    const replay = await refresh(tokens.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.code).toBe("REFRESH_REUSED");

    // The whole session is gone — including for whoever holds the newest token.
    expect((await refresh(rotated.data.refreshToken)).status).toBe(401);
    expect((await api("GET", "/auth/me", rotated.data.accessToken)).status).toBe(401);
    const logged = await AuditLog.findOne({ action: "admin.auth.refresh" }).lean();
    expect(logged).toMatchObject({ outcome: "failed" });
    expect(logged.metadata).toContain("refresh_token_reuse");
  });

  test("a session from an older panel build behaves exactly as before", async () => {
    // Older builds let two tabs share one refresh token and each refresh on
    // its own. That only ever worked because the old hash matched any token of
    // the session, so it must keep working until those tabs are reloaded.
    const { tokens } = await signIn();

    const tabA = await refresh(tokens.refreshToken);
    const tabB = await refresh(tokens.refreshToken);
    expect(tabA.status).toBe(200);
    expect(tabB.status).toBe(200);

    expect((await api("GET", "/auth/me", tabA.data.accessToken)).status).toBe(200);
    expect((await api("GET", "/auth/me", tabB.data.accessToken)).status).toBe(200);
  });

  test("a session ends 30 days after sign-in however often it is refreshed", async () => {
    const { tokens } = await signIn({ refreshCoordinated: true });
    const { sid } = jwt.decode(tokens.refreshToken);
    const startedAt = (daysAgo) =>
      AdminSession.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(sid) },
        { $set: { createdAt: new Date(Date.now() - daysAgo * DAY) } }
      );

    // Day 29: still refreshable, but the expiry no longer slides a full week ahead.
    await startedAt(29);
    const late = await refresh(tokens.refreshToken);
    expect(late.status).toBe(200);
    const session = await AdminSession.findById(sid).lean();
    expect(session.refreshExpiresAt.getTime()).toBeLessThanOrEqual(session.createdAt.getTime() + 30 * DAY);
    expect(session.refreshExpiresAt.getTime() - Date.now()).toBeLessThan(1.1 * DAY);

    await startedAt(31);
    const over = await refresh(late.data.refreshToken);
    expect(over.status).toBe(401);
    expect(over.code).toBe("SESSION_EXPIRED");
    expect((await AdminSession.findById(sid).lean()).isRevoked).toBe(true);
  });
});

describe("coupon rules (fix 14)", () => {
  const valid = {
    code: "SAVE10",
    discountType: "percent",
    discountValue: 10,
    expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
    usageLimit: 100,
    minOrder: 0,
    perUserLimit: 1,
  };

  test("create refuses impossible discounts", async () => {
    const { token } = await makeAdmin("SuperAdmin");
    const create = (overrides) => api("POST", "/coupons", token, { ...valid, ...overrides });

    expect((await create({ discountValue: 150 })).message).toContain("100");
    expect((await create({ discountType: "flat", discountValue: -50 })).status).toBe(400);
    expect((await create({ discountType: "bogus" })).status).toBe(400);
    expect((await create({ usageLimit: 0 })).status).toBe(400);
    expect((await create({ usageLimit: undefined })).status).toBe(400);
    expect((await create({ minOrder: -1 })).status).toBe(400);
    expect((await create({ expiresAt: "not-a-date" })).status).toBe(400);
    expect(await Coupon.countDocuments()).toBe(0);

    const ok = await create({});
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ code: "SAVE10", discountValue: 10, maxDiscount: null, usageLimit: 100 });
  });

  test("edit applies the same rules, without trapping an older coupon", async () => {
    const { token } = await makeAdmin("SuperAdmin");
    const coupon = await Coupon.create({
      code: "LEGACY",
      discountType: "percent",
      discountValue: 150, // saved before the rules existed
      expiresAt: new Date(Date.now() + 30 * DAY),
    });
    const edit = (body) => api("PATCH", `/coupons/${coupon._id}`, token, body);

    // Switching it off must work even though its discount is invalid…
    expect((await edit({ isActive: false })).status).toBe(200);
    // …but any change to its rules has to leave a valid coupon behind.
    expect((await edit({ minOrder: 200 })).status).toBe(400);
    expect((await edit({ discountValue: 101 })).status).toBe(400);

    const fixed = await edit({ discountValue: 20, usageLimit: "", maxDiscount: 0 });
    expect(fixed.status).toBe(200);
    // A blank or 0 limit means "no limit" — never a stored 0, which redemption reads as "no uses left".
    expect(fixed.data).toMatchObject({ discountValue: 20, usageLimit: null, maxDiscount: null, isActive: false });
  });
});

describe("image upload needs a role with something to upload (fix 15)", () => {
  test("support, finance and ops logins are refused; SuperAdmin gets through", async () => {
    for (const role of ["SupportAdmin", "FinanceAdmin", "OpsAdmin"]) {
      const { token } = await makeAdmin(role);
      expect((await call("POST", `${origin}/api/upload?folder=banners`, token)).status).toBe(403);
      expect((await call("POST", `${origin}/api/upload/multi`, token)).status).toBe(403);
    }
    expect((await call("POST", `${origin}/api/upload`)).status).toBe(401);

    const root = await makeAdmin("SuperAdmin");
    const passed = await call("POST", `${origin}/api/upload?folder=banners`, root.token);
    // Past the permission check: refused only because this request carries no file.
    expect(passed.status).toBe(400);
    expect(passed.message).toBe("No file uploaded");
  });
});

describe("small fixes (16)", () => {
  test("partner wallet balance is what the wallet actually holds", async () => {
    const root = await makeAdmin("SuperAdmin");
    const partner = await Partner.create({ name: "Ravi", phone: "9879300002", password: "Secret123" });
    await PartnerWallet.updateOne(
      { partnerId: partner._id },
      { $set: { withdrawableBalance: 1200.5, balance: 1200.5, pendingBalance: 300, totalEarnings: 4000 } },
      { upsert: true }
    );

    const res = await api("GET", `/partners/${partner._id}/stats`, root.token);
    expect(res.data.stats).toMatchObject({ walletBalance: 1500.5, walletTotalEarnings: 4000 });
  });

  test("complaint photos are the uploaded files, not text from the request", async () => {
    const booking = await makeBooking();
    const req = {
      user: { id: String(booking.user) },
      body: {
        orderId: String(booking._id),
        issueType: "SERVICE_QUALITY_ISSUE",
        description: "Leak after the repair",
        images: ["javascript:alert(1)", "https://evil.example/pixel.png"],
      },
      files: [
        { location: "https://r2.internal/test-bucket/media/1_a.jpg", key: "media/1_a.jpg" },
        { location: "https://r2.internal/test-bucket/media/2_b.png", key: "media/2_b.png" },
      ],
    };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };

    await createComplaint(req, res);

    expect(res.statusCode).toBe(201);
    const stored = await Complaint.findOne({ orderId: booking._id }).lean();
    expect(stored.images).toEqual([
      "https://media.quickqare.test/media/1_a.jpg",
      "https://media.quickqare.test/media/2_b.png",
    ]);
  });
});
