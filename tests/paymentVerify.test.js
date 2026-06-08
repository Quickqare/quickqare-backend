/**
 * CRITICAL PATH: payment verification must
 *   - reject a forged/invalid Razorpay signature (no free bookings),
 *   - reject verifying someone else's booking (IDOR),
 *   - be idempotent (double-submit can't double-process),
 *   - accept a correctly signed payment.
 *
 * These all run the REAL controller. The downstream finalize/slot services are
 * mocked so the test stays focused on the security guards and doesn't need the
 * full service graph.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");

// Isolate the controller from heavy downstream services.
jest.mock("../services/paymentFinalize.service", () => ({
  finalizePaidBooking: jest.fn().mockResolvedValue({ outcome: "searching" }),
}));
jest.mock("../services/slotCapacity.service", () => ({
  releaseSlotCapacityByBookingId: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/scheduling_service", () => ({
  buildDateTime: jest.fn(() => new Date()),
}));

const Booking = require("../models/Booking");
// The controller populates "Service" refs — register that model so populate works.
require("../models/service.model");
const { finalizePaidBooking } = require("../services/paymentFinalize.service");
const { verifyRazorpayPayment } = require("../controllers/paymentVerify.controller");

const SECRET = "test_secret_key";
process.env.RAZORPAY_KEY_SECRET = SECRET;

// Minimal mock Express res that records status + body.
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

function sign(orderId, paymentId) {
  return crypto
    .createHmac("sha256", SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

async function makeBooking(overrides = {}) {
  return Booking.create({
    user: new mongoose.Types.ObjectId(),
    baseAmount: 500,
    totalAmount: 500,
    scheduledDate: new Date("2026-07-01T00:00:00.000Z"),
    scheduledTime: "10:00 AM",
    location: { type: "Point", coordinates: [77.59, 12.97] },
    pincode: "560001",
    status: "PENDING_PAYMENT",
    lockedUntil: new Date(Date.now() + 10 * 60 * 1000), // 10 min in the future
    payment: { razorpay_order_id: "order_test_123" },
    ...overrides,
  });
}

beforeEach(() => {
  finalizePaidBooking.mockClear();
});

describe("verifyRazorpayPayment", () => {
  test("rejects an invalid signature with 400 and never finalizes", async () => {
    const booking = await makeBooking();
    const req = {
      user: { _id: booking.user },
      body: {
        bookingId: booking._id.toString(),
        razorpay_order_id: "order_test_123",
        razorpay_payment_id: "pay_test_123",
        razorpay_signature: "totally-forged-signature",
      },
    };
    const res = mockRes();

    await verifyRazorpayPayment(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(finalizePaidBooking).not.toHaveBeenCalled();

    const fresh = await Booking.findById(booking._id);
    expect(fresh.payment.status).toBe("FAILED");
  });

  test("rejects verifying another user's booking with 403 (IDOR guard)", async () => {
    const booking = await makeBooking();
    const req = {
      user: { _id: new mongoose.Types.ObjectId() }, // a different user
      body: {
        bookingId: booking._id.toString(),
        razorpay_order_id: "order_test_123",
        razorpay_payment_id: "pay_test_123",
        razorpay_signature: sign("order_test_123", "pay_test_123"),
      },
    };
    const res = mockRes();

    await verifyRazorpayPayment(req, res);

    expect(res.statusCode).toBe(403);
    expect(finalizePaidBooking).not.toHaveBeenCalled();
  });

  test("is idempotent: an already-PAID booking returns success without reprocessing", async () => {
    const booking = await makeBooking({ payment: { status: "PAID" } });
    const req = {
      user: { _id: booking.user },
      body: {
        bookingId: booking._id.toString(),
        razorpay_order_id: "order_test_123",
        razorpay_payment_id: "pay_test_123",
        razorpay_signature: sign("order_test_123", "pay_test_123"),
      },
    };
    const res = mockRes();

    await verifyRazorpayPayment(req, res);

    expect(res.body.success).toBe(true);
    expect(finalizePaidBooking).not.toHaveBeenCalled();
  });

  test("accepts a correctly signed payment and finalizes it", async () => {
    const booking = await makeBooking();
    const sig = sign("order_test_123", "pay_test_123");
    const req = {
      user: { _id: booking.user },
      body: {
        bookingId: booking._id.toString(),
        razorpay_order_id: "order_test_123",
        razorpay_payment_id: "pay_test_123",
        razorpay_signature: sig,
      },
    };
    const res = mockRes();

    await verifyRazorpayPayment(req, res);

    expect(res.body.success).toBe(true);
    expect(finalizePaidBooking).toHaveBeenCalledTimes(1);
  });
});
