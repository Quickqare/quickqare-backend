/**
 * CRITICAL PATH: advance (cake) orders must reach a baker at PAYMENT time,
 * not 3 hours before delivery.
 *
 *   - finalizePaidBooking: a customized (cake) order scheduled >24h out is
 *     assigned immediately — never parked in QUEUED (where it is invisible to
 *     the per-baker daily cap and the day-before reminder cron).
 *   - finalizePaidBooking: plain far-future bookings still queue (regression).
 *   - dispatchQueuedBookings: a straggler QUEUED cake is dispatched on the
 *     next pass regardless of the T-3h window.
 *   - handleAckTimeout: an advance assignment is NOT reassigned after the
 *     2-minute socket window — the baker gets 12h (capped at T-3h). Imminent
 *     assignments keep the old 2-minute behaviour.
 */
const mongoose = require("mongoose");

// The assignment engine is the unit under *observation*, not under test —
// mock it so we can assert who gets called without the full service graph.
jest.mock("../services/assignmentEngine", () => ({
  assignBooking: jest.fn().mockResolvedValue(null),
  reassignBooking: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/slotCapacity.service", () => ({
  markSlotLockPaid: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/coupon.service", () => ({
  recordCouponRedemption: jest.fn().mockResolvedValue(undefined),
}));

const Booking = require("../models/Booking");
const { assignBooking, reassignBooking } = require("../services/assignmentEngine");
const { finalizePaidBooking } = require("../services/paymentFinalize.service");
const { dispatchQueuedBookings } = require("../services/cron.service");
const { handleAckTimeout } = require("../services/ackTimeout.service");

const HOUR_MS = 60 * 60 * 1000;

function hoursFromNow(h) {
  return new Date(Date.now() + h * HOUR_MS);
}

const cakeLine = {
  serviceId: new mongoose.Types.ObjectId(),
  name: "Classic Round Cake",
  price: 549,
  lineTotal: 549,
  quantity: 1,
  category: "celebration",
  options: { flavour: "Chocolate Truffle", tiers: 1, addons: [], nameOnCake: "Happy Birthday" },
};

const plainLine = {
  serviceId: new mongoose.Types.ObjectId(),
  name: "Tap Repair",
  price: 300,
  lineTotal: 300,
  quantity: 1,
  category: "plumbing",
};

async function makeBooking(overrides = {}) {
  return Booking.create({
    user: new mongoose.Types.ObjectId(),
    baseAmount: 500,
    totalAmount: 500,
    scheduledDate: hoursFromNow(72),
    scheduledTime: "10:00 AM",
    scheduledStartAt: hoursFromNow(72),
    location: { type: "Point", coordinates: [77.59, 12.97] },
    pincode: "560001",
    status: "PENDING_PAYMENT",
    payment: { razorpay_order_id: "order_test_123" },
    ...overrides,
  });
}

beforeEach(() => {
  assignBooking.mockClear();
  reassignBooking.mockClear();
});

describe("finalizePaidBooking — advance (cake) orders", () => {
  test("cake order 72h out is assigned immediately, never QUEUED", async () => {
    const booking = await makeBooking({ services: [cakeLine] });

    const { outcome } = await finalizePaidBooking(booking, {
      razorpay_payment_id: "pay_1",
      razorpay_order_id: "order_test_123",
    });

    expect(outcome).toBe("searching");
    expect(assignBooking).toHaveBeenCalledTimes(1);

    const fresh = await Booking.findById(booking._id).lean();
    expect(fresh.status).not.toBe("QUEUED");
    expect(fresh.payment.status).toBe("PAID");
  });

  test("plain booking 72h out still queues for the T-3h dispatch (regression)", async () => {
    const booking = await makeBooking({ services: [plainLine] });

    const { outcome } = await finalizePaidBooking(booking, {
      razorpay_payment_id: "pay_2",
      razorpay_order_id: "order_test_123",
    });

    expect(outcome).toBe("queued");
    expect(assignBooking).not.toHaveBeenCalled();

    const fresh = await Booking.findById(booking._id).lean();
    expect(fresh.status).toBe("QUEUED");
  });

  test("plain booking 5h out is assigned immediately (regression)", async () => {
    const booking = await makeBooking({
      services: [plainLine],
      scheduledDate: hoursFromNow(5),
      scheduledStartAt: hoursFromNow(5),
    });

    const { outcome } = await finalizePaidBooking(booking, {
      razorpay_payment_id: "pay_3",
      razorpay_order_id: "order_test_123",
    });

    expect(outcome).toBe("searching");
    expect(assignBooking).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchQueuedBookings — QUEUED cake stragglers", () => {
  test("QUEUED cake 72h out is dispatched on the next pass; plain booking is not", async () => {
    const cake = await makeBooking({ services: [cakeLine], status: "QUEUED" });
    const plain = await makeBooking({ services: [plainLine], status: "QUEUED" });

    await dispatchQueuedBookings();

    expect(assignBooking).toHaveBeenCalledTimes(1);
    expect(String(assignBooking.mock.calls[0][0])).toBe(String(cake._id));

    const freshCake = await Booking.findById(cake._id).lean();
    const freshPlain = await Booking.findById(plain._id).lean();
    expect(freshCake.status).toBe("SEARCHING");
    expect(freshPlain.status).toBe("QUEUED");
  });
});

describe("handleAckTimeout — advance assignments get the wide window", () => {
  test("advance assignment inside its 12h window is NOT reassigned", async () => {
    const booking = await makeBooking({
      services: [cakeLine],
      status: "ASSIGNED",
      partner: new mongoose.Types.ObjectId(),
      assignedAt: new Date(), // just assigned
    });

    await handleAckTimeout(booking._id, booking.partner);

    expect(reassignBooking).not.toHaveBeenCalled();
  });

  test("advance assignment unacknowledged for >12h IS reassigned", async () => {
    const booking = await makeBooking({
      services: [cakeLine],
      status: "ASSIGNED",
      partner: new mongoose.Types.ObjectId(),
      assignedAt: new Date(Date.now() - 13 * HOUR_MS),
    });

    await handleAckTimeout(booking._id, booking.partner);

    expect(reassignBooking).toHaveBeenCalledTimes(1);
  });

  test("advance assignment reaching the T-3h window IS reassigned even within 12h", async () => {
    const booking = await makeBooking({
      services: [cakeLine],
      status: "ASSIGNED",
      partner: new mongoose.Types.ObjectId(),
      scheduledDate: hoursFromNow(2),
      scheduledStartAt: hoursFromNow(2), // inside T-3h
      assignedAt: new Date(Date.now() - 1 * HOUR_MS),
    });

    await handleAckTimeout(booking._id, booking.partner);

    expect(reassignBooking).toHaveBeenCalledTimes(1);
  });

  test("imminent assignment keeps the classic 2-minute behaviour", async () => {
    const booking = await makeBooking({
      services: [plainLine],
      status: "ASSIGNED",
      partner: new mongoose.Types.ObjectId(),
      scheduledDate: hoursFromNow(1),
      scheduledStartAt: hoursFromNow(1),
      assignedAt: new Date(Date.now() - 3 * 60 * 1000), // 3 min ago, no ack
    });

    await handleAckTimeout(booking._id, booking.partner);

    expect(reassignBooking).toHaveBeenCalledTimes(1);
  });

  test("acknowledged advance assignment is left alone after 12h", async () => {
    const booking = await makeBooking({
      services: [cakeLine],
      status: "ASSIGNED",
      partner: new mongoose.Types.ObjectId(),
      assignedAt: new Date(Date.now() - 13 * HOUR_MS),
      ackReceivedAt: new Date(Date.now() - 12 * HOUR_MS),
    });

    await handleAckTimeout(booking._id, booking.partner);

    expect(reassignBooking).not.toHaveBeenCalled();
  });
});
