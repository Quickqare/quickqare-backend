/**
 * The GST audit report takes refunds off: a refund (owed or paid back) is money
 * the booking no longer keeps, so the tax inside it isn't collected either.
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
});

jest.mock("../admin/services/email.service", () => ({
  sendAdminTwoFaCode: jest.fn().mockResolvedValue(undefined),
  sendOpsAlertEmail: jest.fn().mockResolvedValue(undefined),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const AdminUser = require("../admin/models/AdminUser");
const AdminSession = require("../admin/models/AdminSession");
const Booking = require("../models/Booking");
const User = require("../models/User");

const PASSWORD = "Correct-Horse-1";
const DAY = 24 * 60 * 60 * 1000;

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

async function adminToken() {
  seq += 1;
  const admin = await AdminUser.create({
    name: `Finance ${seq}`,
    email: `finance${seq}@test.local`,
    passwordHash: await AdminUser.hashPassword(PASSWORD),
    role: "FinanceAdmin",
    isActive: true,
  });
  const session = await AdminSession.create({
    adminUserId: admin._id,
    refreshExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return jwt.sign(
    { type: "access", sub: String(admin._id), role: "FinanceAdmin", sid: String(session._id) },
    process.env.ADMIN_JWT_ACCESS_SECRET,
    { expiresIn: 3600 }
  );
}

// ₹1,000 service + 18% tax = ₹1,180 (tax ₹180) unless overridden.
async function makeBooking(overrides = {}) {
  seq += 1;
  const user = await User.create({ name: "Asha", phone: `98793${String(seq).padStart(5, "0")}` });
  const start = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return Booking.create({
    user: user._id,
    services: [{ serviceId: new mongoose.Types.ObjectId(), name: "Facial", quantity: 1, price: 1000, lineTotal: 1000 }],
    serviceCategory: "Salon for Women",
    baseAmount: 1000,
    gstAmount: 180,
    totalAmount: 1180,
    scheduledDate: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
    scheduledTime: start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    scheduledStartAt: start,
    location: { type: "Point", coordinates: [88.3525, 22.5526] },
    pincode: "700016",
    address: "12 Park Street",
    payment: { status: "PAID", razorpay_payment_id: `pay_${seq}` },
    status: "COMPLETED",
    ...overrides,
  });
}

async function report() {
  const token = await adminToken();
  const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
  const res = await fetch(`${base}/reports/gst?start=${day(-1)}&end=${day(1)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  expect(res.status).toBe(200);
  return json.data;
}

describe("GST report nets out refunds", () => {
  test("a booking with no refund reports the same as before", async () => {
    await makeBooking();
    const { summary } = await report();
    expect(summary).toMatchObject({
      bookingCount: 1,
      gstAmount: 180,
      totalAmount: 1180,
      refundedAmount: 0,
      refundedGstAmount: 0,
      netGstAmount: 180,
      netTotalAmount: 1180,
    });
  });

  test("a partial refund takes its share of the tax, owed or paid back", async () => {
    // 75% tier: ₹885 of ₹1,180 → tax 180 × 885 / 1180 = ₹135.
    await makeBooking({ status: "CANCELLED", refundAmount: 885, refundStatus: "PENDING" });
    const { summary } = await report();
    expect(summary.refundedAmount).toBe(885);
    expect(summary.refundedGstAmount).toBe(135);
    expect(summary.netGstAmount).toBe(45);
    expect(summary.netTotalAmount).toBe(295);
    // The figures as collected are untouched.
    expect(summary.gstAmount).toBe(180);
    expect(summary.totalAmount).toBe(1180);
  });

  test("a full refund removes all of the tax", async () => {
    await makeBooking({ status: "CANCELLED", refundAmount: 1180, refundedAmount: 1180, refundStatus: "PROCESSED" });
    const { summary } = await report();
    expect(summary.refundedGstAmount).toBe(180);
    expect(summary.netGstAmount).toBe(0);
    expect(summary.netTotalAmount).toBe(0);
  });

  test("a refund is never counted past the booking total, and NONE or unpaid bookings don't count", async () => {
    // Refund on record beyond the total (an on-site estimate paid on top).
    await makeBooking({ totalAmount: 590, gstAmount: 90, refundAmount: 700, refundStatus: "PROCESSED" });
    // A stale refundAmount on a booking with no refund is ignored.
    await makeBooking({ totalAmount: 590, gstAmount: 90, refundAmount: 500, refundStatus: "NONE" });
    // Unpaid bookings aren't in the report at all.
    await makeBooking({ payment: { status: "PENDING" }, status: "CANCELLED" });

    const { summary } = await report();
    expect(summary.bookingCount).toBe(2);
    expect(summary.gstAmount).toBe(180);
    expect(summary.refundedAmount).toBe(590);
    expect(summary.refundedGstAmount).toBe(90);
    expect(summary.netGstAmount).toBe(90);
    expect(summary.netTotalAmount).toBe(590);
  });

  test("daily rows add up to the summary", async () => {
    await makeBooking();
    await makeBooking({ status: "CANCELLED", refundAmount: 885, refundStatus: "PENDING" });
    await makeBooking({ status: "CANCELLED", refundAmount: 1180, refundStatus: "PROCESSED" });

    const { summary, rows } = await report();
    const sum = (key) => Math.round(rows.reduce((total, row) => total + row[key], 0) * 100) / 100;
    expect(summary.refundedGstAmount).toBe(315);
    expect(summary.netGstAmount).toBe(225);
    for (const key of ["bookingCount", "gstAmount", "totalAmount", "refundedAmount", "refundedGstAmount", "netGstAmount", "netTotalAmount"]) {
      expect(sum(key)).toBe(summary[key]);
    }
  });
});
