/**
 * Automatic Razorpay refunds: pays what a booking owes, exactly once, never
 * more than recorded, and leaves hand-approved / estimate cases to a person.
 * Razorpay itself is mocked.
 */
const mongoose = require("mongoose");

const mockRefund = jest.fn();
const mockFetchRefunds = jest.fn();
const mockFetchPayment = jest.fn();
jest.mock("razorpay", () =>
  jest.fn().mockImplementation(() => ({
    payments: { refund: mockRefund, fetchMultipleRefund: mockFetchRefunds, fetch: mockFetchPayment },
  }))
);
jest.mock("../services/pushNotification.service", () => ({
  notifyCustomerOfBookingStatus: jest.fn().mockResolvedValue(undefined),
}));

process.env.RAZORPAY_KEY_ID = "rzp_test_x";
process.env.RAZORPAY_KEY_SECRET = "secret";

const Booking = require("../models/Booking");
const Refund = require("../admin/models/Refund");
const { issueAutoRefund, sweepPendingRefunds, handleRefundWebhook, canAutoRefund } = require("../services/autoRefund.service");
const { notifyCustomerOfBookingStatus } = require("../services/pushNotification.service");

async function makeBooking(overrides = {}) {
  return Booking.create({
    user: new mongoose.Types.ObjectId(),
    baseAmount: 500,
    totalAmount: 500,
    scheduledDate: new Date("2026-07-01T00:00:00.000Z"),
    scheduledTime: "10:00 AM",
    location: { type: "Point", coordinates: [77.59, 12.97] },
    pincode: "560001",
    status: "CANCELLED",
    payment: { status: "PAID", razorpay_payment_id: "pay_1", razorpay_order_id: "order_1" },
    refundAmount: 375,
    refundStatus: "PENDING",
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchRefunds.mockResolvedValue({ items: [] });
  mockRefund.mockResolvedValue({ id: "rfnd_1" });
  mockFetchPayment.mockResolvedValue({ id: "pay_1", status: "captured" });
});

describe("issueAutoRefund", () => {
  test("sends the owed amount in paise and marks the booking PROCESSED", async () => {
    const b = await makeBooking();
    const out = await issueAutoRefund(b._id);
    expect(out.status).toBe("processed");
    expect(mockRefund).toHaveBeenCalledWith("pay_1", expect.objectContaining({ amount: 37500 }));
    const after = await Booking.findById(b._id).lean();
    expect(after.refundStatus).toBe("PROCESSED");
    expect(after.refundedAmount).toBe(375);
    expect(after.payment.razorpay_refund_id).toBe("rfnd_1");
    expect(notifyCustomerOfBookingStatus).toHaveBeenCalledWith(
      expect.anything(), "REFUND_INITIATED", expect.anything(), expect.objectContaining({ refundAmount: 375 })
    );
  });

  test("a second call does not pay again", async () => {
    const b = await makeBooking();
    await issueAutoRefund(b._id);
    const again = await issueAutoRefund(b._id);
    expect(again.status).toBe("skipped");
    expect(mockRefund).toHaveBeenCalledTimes(1);
  });

  test("two simultaneous calls pay once", async () => {
    const b = await makeBooking();
    await Promise.all([issueAutoRefund(b._id), issueAutoRefund(b._id)]);
    expect(mockRefund).toHaveBeenCalledTimes(1);
  });

  test("adopts a refund Razorpay already has instead of sending a duplicate", async () => {
    const b = await makeBooking();
    mockFetchRefunds.mockResolvedValue({ items: [{ id: "rfnd_old", amount: 37500, status: "processed" }] });
    const out = await issueAutoRefund(b._id);
    expect(out.status).toBe("processed");
    expect(mockRefund).not.toHaveBeenCalled();
    const after = await Booking.findById(b._id).lean();
    expect(after.refundStatus).toBe("PROCESSED");
    expect(after.payment.razorpay_refund_id).toBe("rfnd_old");
  });

  test("sends only the shortfall when part was already refunded on Razorpay", async () => {
    const b = await makeBooking();
    mockFetchRefunds.mockResolvedValue({ items: [{ id: "rfnd_part", amount: 10000, status: "processed" }] });
    await issueAutoRefund(b._id);
    expect(mockRefund).toHaveBeenCalledWith("pay_1", expect.objectContaining({ amount: 27500 }));
  });

  test("a Razorpay error leaves it PENDING with the error and a retry left", async () => {
    const b = await makeBooking();
    mockRefund.mockRejectedValue({ error: { description: "Insufficient balance" } });
    const out = await issueAutoRefund(b._id);
    expect(out.status).toBe("failed");
    const after = await Booking.findById(b._id).lean();
    expect(after.refundStatus).toBe("PENDING");
    expect(after.refundProcessingAt).toBeNull();
    expect(after.refundLastError).toMatch(/Insufficient balance/);
    // retry works
    mockRefund.mockResolvedValue({ id: "rfnd_2" });
    expect((await issueAutoRefund(b._id)).status).toBe("processed");
  });

  test("stops retrying automatically after the attempt limit", async () => {
    const b = await makeBooking({ refundAttempts: 5 });
    expect((await issueAutoRefund(b._id)).status).toBe("skipped");
    expect(mockRefund).not.toHaveBeenCalled();
  });

  test("leaves bookings with a paid on-site estimate to a person", async () => {
    const b = await makeBooking({ estimatePayment: { status: "PAID", totalAmount: 100 } });
    expect((await issueAutoRefund(b._id)).status).toBe("skipped");
    expect(mockRefund).not.toHaveBeenCalled();
  });

  test("never sends more than the booking's payment", async () => {
    const b = await makeBooking({ refundAmount: 900 });
    expect((await issueAutoRefund(b._id)).reason).toBe("amount_mismatch");
    expect(mockRefund).not.toHaveBeenCalled();
  });

  test("waits for approval when an admin-requested refund is open, then admin approval sends it", async () => {
    const b = await makeBooking();
    await Refund.create({ bookingId: b._id, amountInr: 375, reason: "goodwill", status: "REQUESTED", requestedByAdminId: new mongoose.Types.ObjectId() });
    expect((await issueAutoRefund(b._id)).reason).toBe("awaiting_admin_approval");
    expect(mockRefund).not.toHaveBeenCalled();
    const approved = await issueAutoRefund(b._id, { adminId: new mongoose.Types.ObjectId() });
    expect(approved.status).toBe("processed");
    expect((await Refund.findOne({ bookingId: b._id }).lean()).status).toBe("COMPLETED");
  });

  test("AUTO_REFUND_DISABLED switches it off", async () => {
    process.env.AUTO_REFUND_DISABLED = "true";
    try {
      const b = await makeBooking();
      expect((await issueAutoRefund(b._id)).reason).toBe("disabled");
    } finally {
      delete process.env.AUTO_REFUND_DISABLED;
    }
  });

  test("a live unpaid booking is never refunded", async () => {
    const b = await makeBooking({ status: "PENDING_PAYMENT", payment: { status: "PENDING", razorpay_payment_id: "pay_1" } });
    expect((await issueAutoRefund(b._id)).status).toBe("skipped");
    expect(mockRefund).not.toHaveBeenCalled();
  });
});

// The verify and webhook paths flag a payment captured for a dead booking as a
// full PENDING refund and store the payment id, but never mark it PAID.
describe("a payment captured after the booking was cancelled", () => {
  const late = (overrides = {}) =>
    makeBooking({
      payment: { status: "PENDING", razorpay_payment_id: "pay_1", razorpay_order_id: "order_1" },
      refundAmount: 500,
      ...overrides,
    });

  test("is refunded in full once Razorpay confirms it was captured", async () => {
    const b = await late();
    const out = await issueAutoRefund(b._id);
    expect(out.status).toBe("processed");
    expect(mockFetchPayment).toHaveBeenCalledWith("pay_1");
    expect(mockRefund).toHaveBeenCalledWith("pay_1", expect.objectContaining({ amount: 50000 }));
    const after = await Booking.findById(b._id).lean();
    expect(after.refundStatus).toBe("PROCESSED");
    expect(after.refundedAmount).toBe(500);
    expect(after.payment.razorpay_refund_id).toBe("rfnd_1");
  });

  test("is not refunded while Razorpay says it is not captured, and is retried", async () => {
    const b = await late();
    mockFetchPayment.mockResolvedValue({ id: "pay_1", status: "authorized" });
    const out = await issueAutoRefund(b._id);
    expect(out.status).toBe("failed");
    expect(mockRefund).not.toHaveBeenCalled();
    const after = await Booking.findById(b._id).lean();
    expect(after.refundStatus).toBe("PENDING");
    expect(after.refundLastError).toMatch(/authorized, not captured/);
    mockFetchPayment.mockResolvedValue({ id: "pay_1", status: "captured" });
    expect((await issueAutoRefund(b._id)).status).toBe("processed");
  });

  test("adopts a refund Razorpay already made instead of sending again", async () => {
    const b = await late();
    mockFetchPayment.mockResolvedValue({ id: "pay_1", status: "refunded" });
    mockFetchRefunds.mockResolvedValue({ items: [{ id: "rfnd_old", amount: 50000, status: "processed" }] });
    expect((await issueAutoRefund(b._id)).status).toBe("processed");
    expect(mockRefund).not.toHaveBeenCalled();
    expect((await Booking.findById(b._id).lean()).payment.razorpay_refund_id).toBe("rfnd_old");
  });

  test("the sweep picks it up", async () => {
    const b = await late();
    await sweepPendingRefunds();
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect((await Booking.findById(b._id).lean()).refundStatus).toBe("PROCESSED");
  });

  test("a completed booking with a late capture is left to a person", async () => {
    const b = await late({ status: "COMPLETED" });
    expect((await issueAutoRefund(b._id)).reason).toBe("not_eligible");
    await sweepPendingRefunds();
    expect(mockRefund).not.toHaveBeenCalled();
    expect(mockFetchPayment).not.toHaveBeenCalled();
    expect((await Booking.findById(b._id).lean()).refundStatus).toBe("PENDING");
  });

  test("a paid on-site estimate still sends it to a person", async () => {
    const b = await late({ estimatePayment: { status: "PAID", totalAmount: 100 } });
    expect((await issueAutoRefund(b._id)).reason).toBe("not_eligible");
  });
});

describe("canAutoRefund (what the admin refunds list offers)", () => {
  const row = (over) => ({ status: "CANCELLED", payment: { status: "PAID", razorpay_payment_id: "pay_1" }, ...over });

  test("matches what issueAutoRefund will take", () => {
    expect(canAutoRefund(row())).toBe(true);
    expect(canAutoRefund(row({ status: "COMPLETED" }))).toBe(true); // PAID
    expect(canAutoRefund(row({ payment: { status: "PENDING", razorpay_payment_id: "pay_1" } }))).toBe(true); // late capture
    expect(canAutoRefund(row({ status: "COMPLETED", payment: { status: "PENDING", razorpay_payment_id: "pay_1" } }))).toBe(false);
    expect(canAutoRefund(row({ payment: { status: "PAID" } }))).toBe(false); // no payment id
    expect(canAutoRefund(row({ estimatePayment: { status: "PAID" } }))).toBe(false);
  });
});

describe("sweepPendingRefunds", () => {
  test("pays pending refunds, skips awaiting-approval ones", async () => {
    const a = await makeBooking({ payment: { status: "PAID", razorpay_payment_id: "pay_a" } });
    const held = await makeBooking({ payment: { status: "PAID", razorpay_payment_id: "pay_h" } });
    await Refund.create({ bookingId: held._id, amountInr: 375, reason: "x", status: "REQUESTED", requestedByAdminId: new mongoose.Types.ObjectId() });
    await sweepPendingRefunds();
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(mockRefund).toHaveBeenCalledWith("pay_a", expect.anything());
    expect((await Booking.findById(a._id).lean()).refundStatus).toBe("PROCESSED");
    expect((await Booking.findById(held._id).lean()).refundStatus).toBe("PENDING");
  });
});

describe("handleRefundWebhook", () => {
  test("refund.processed tells the customer", async () => {
    const b = await makeBooking({ refundStatus: "PROCESSED", refundedAmount: 375 });
    await handleRefundWebhook("refund.processed", { id: "rfnd_1", payment_id: "pay_1", amount: 37500 });
    expect(notifyCustomerOfBookingStatus).toHaveBeenCalledWith(
      expect.anything(), "REFUND_PROCESSED", expect.anything(), expect.objectContaining({ refundAmount: 375 })
    );
    expect((await Booking.findById(b._id).lean()).refundStatus).toBe("PROCESSED");
  });

  test("refund.failed puts it back to PENDING and stops auto retries", async () => {
    const b = await makeBooking({ refundStatus: "PROCESSED", refundedAmount: 375, refundProcessedAt: new Date() });
    await handleRefundWebhook("refund.failed", { id: "rfnd_1", payment_id: "pay_1", amount: 37500 });
    const after = await Booking.findById(b._id).lean();
    expect(after.refundStatus).toBe("PENDING");
    expect(after.refundedAmount).toBe(0);
    expect(after.refundAttempts).toBe(5);
    expect((await issueAutoRefund(b._id)).status).toBe("skipped");
  });

  test("an unknown payment is ignored", async () => {
    await expect(handleRefundWebhook("refund.failed", { id: "r", payment_id: "pay_none", amount: 100 })).resolves.toBeUndefined();
  });
});
