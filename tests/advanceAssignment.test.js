/**
 * CRITICAL PATH: advance bookings (start far in the future) are queued at
 * payment and dispatched inside the T-3h window, and their assigned partner
 * gets a wide acknowledgement window instead of the 2-minute socket timer.
 *
 *   - finalizePaidBooking: a booking scheduled >24h out is QUEUED; one
 *     scheduled sooner is assigned immediately.
 *   - dispatchQueuedBookings: only QUEUED bookings inside the T-3h window are
 *     dispatched.
 *   - handleAckTimeout: an advance assignment is NOT reassigned after the
 *     2-minute socket window — the partner gets 12h (capped at T-3h).
 *     Imminent assignments keep the old 2-minute behaviour.
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

describe("finalizePaidBooking — advance bookings", () => {
  test("booking 72h out queues for the T-3h dispatch", async () => {
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

  test("booking 5h out is assigned immediately", async () => {
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

describe("dispatchQueuedBookings — T-3h window", () => {
  test("QUEUED booking inside the window is dispatched; one 72h out is not", async () => {
    const soon = await makeBooking({
      services: [plainLine],
      status: "QUEUED",
      scheduledDate: hoursFromNow(2),
      scheduledStartAt: hoursFromNow(2),
    });
    const later = await makeBooking({ services: [plainLine], status: "QUEUED" });

    await dispatchQueuedBookings();

    expect(assignBooking).toHaveBeenCalledTimes(1);
    expect(String(assignBooking.mock.calls[0][0])).toBe(String(soon._id));

    const freshSoon = await Booking.findById(soon._id).lean();
    const freshLater = await Booking.findById(later._id).lean();
    expect(freshSoon.status).toBe("SEARCHING");
    expect(freshLater.status).toBe("QUEUED");
  });
});

describe("handleAckTimeout — advance assignments get the wide window", () => {
  test("advance assignment inside its 12h window is NOT reassigned", async () => {
    const booking = await makeBooking({
      services: [plainLine],
      status: "ASSIGNED",
      partner: new mongoose.Types.ObjectId(),
      assignedAt: new Date(), // just assigned
    });

    await handleAckTimeout(booking._id, booking.partner);

    expect(reassignBooking).not.toHaveBeenCalled();
  });

  test("advance assignment unacknowledged for >12h IS reassigned", async () => {
    const booking = await makeBooking({
      services: [plainLine],
      status: "ASSIGNED",
      partner: new mongoose.Types.ObjectId(),
      assignedAt: new Date(Date.now() - 13 * HOUR_MS),
    });

    await handleAckTimeout(booking._id, booking.partner);

    expect(reassignBooking).toHaveBeenCalledTimes(1);
  });

  test("advance assignment reaching the T-3h window IS reassigned even within 12h", async () => {
    const booking = await makeBooking({
      services: [plainLine],
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
      services: [plainLine],
      status: "ASSIGNED",
      partner: new mongoose.Types.ObjectId(),
      assignedAt: new Date(Date.now() - 13 * HOUR_MS),
      ackReceivedAt: new Date(Date.now() - 12 * HOUR_MS),
    });

    await handleAckTimeout(booking._id, booking.partner);

    expect(reassignBooking).not.toHaveBeenCalled();
  });
});
