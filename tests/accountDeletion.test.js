/**
 * Deleting an account (DELETE /api/user/me) — customer-app audit, Oct 2026, item 17.
 *
 * A checkout the customer started and never paid for is hidden from their
 * bookings and stays for up to 48 h until the stale-booking cron removes it. It
 * used to count as "an upcoming booking" and block deleting the account for that
 * long, with the customer unable to see (let alone cancel) the booking in the way.
 */
const mockRelease = jest.fn().mockResolvedValue(undefined);
jest.mock("../services/slotCapacity.service", () => ({
  releaseSlotCapacityByBookingId: (...args) => mockRelease(...args),
}));

const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Complaint = require("../models/Complaint");
const User = require("../models/User");
const { deleteAccount } = require("../controllers/user.controller");

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

const del = async (user, body = {}) => {
  const res = mockRes();
  await deleteAccount({ user: { id: user._id }, body }, res);
  return res;
};

let seq = 0;
const makeUser = () => {
  seq += 1;
  return User.create({ name: "Asha", phone: `98765${String(seq).padStart(5, "0")}`, fcmToken: "device-token" });
};

const makeBooking = (user, overrides = {}) => {
  const start = new Date(Date.now() + 5 * 60 * 60 * 1000);
  return Booking.create({
    user: user._id,
    services: [{ serviceId: new mongoose.Types.ObjectId(), name: "Facial", quantity: 1, price: 500, lineTotal: 500 }],
    serviceCategory: "Salon for Women",
    baseAmount: 500,
    totalAmount: 590,
    scheduledDate: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
    scheduledTime: "10:00 AM",
    scheduledStartAt: start,
    location: { type: "Point", coordinates: [88.3525, 22.5526] },
    pincode: "700016",
    address: "12 Park Street",
    payment: { status: "PAID" },
    status: "CONFIRMED",
    ...overrides,
  });
};

const abandonedCheckout = (user, overrides = {}) =>
  makeBooking(user, {
    status: "PENDING_PAYMENT",
    payment: { status: "PENDING" },
    lockedUntil: new Date(Date.now() - 60 * 60 * 1000),
    ...overrides,
  });

beforeEach(() => {
  mockRelease.mockClear();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("an abandoned (unpaid) checkout", () => {
  test("no longer blocks deleting the account; it is cancelled and its slot given back", async () => {
    const user = await makeUser();
    const abandoned = await abandonedCheckout(user);

    const res = await del(user, { reason: "not using it" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true });

    const booking = await Booking.findById(abandoned._id).lean();
    expect(booking).toMatchObject({
      status: "CANCELLED",
      cancelledBy: "user",
      cancelReason: "Account deleted",
      payment: expect.objectContaining({ status: "FAILED" }),
    });
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(String(mockRelease.mock.calls[0][0])).toBe(String(abandoned._id));
    expect(mockRelease.mock.calls[0][1]).toEqual({ releaseReason: "account_deleted" });

    // And the account really is gone: anonymised, phone freed, token dropped.
    const fresh = await User.findById(user._id).lean();
    expect(fresh).toMatchObject({
      isDeleted: true,
      name: "Deleted User",
      phone: `deleted_${user._id}`,
      fcmToken: "",
      deleteReason: "not using it",
    });
  });

  test("several of them are all cancelled", async () => {
    const user = await makeUser();
    const first = await abandonedCheckout(user);
    const second = await abandonedCheckout(user);

    const res = await del(user);

    expect(res.statusCode).toBe(200);
    for (const id of [first._id, second._id]) {
      expect((await Booking.findById(id).lean()).status).toBe("CANCELLED");
    }
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  test("another customer's abandoned checkout is left alone", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const theirs = await abandonedCheckout(other);

    await del(user);

    expect((await Booking.findById(theirs._id).lean()).status).toBe("PENDING_PAYMENT");
    expect(mockRelease).not.toHaveBeenCalled();
  });
});

describe("what still blocks deleting the account", () => {
  test("a paid, upcoming booking — and nothing else is touched when it refuses", async () => {
    const user = await makeUser();
    await makeBooking(user, { status: "CONFIRMED" });
    const abandoned = await abandonedCheckout(user);

    const res = await del(user);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: "ACTIVE_BOOKING" });
    // A refused request changes nothing: the abandoned checkout is still there.
    expect((await Booking.findById(abandoned._id).lean()).status).toBe("PENDING_PAYMENT");
    expect(mockRelease).not.toHaveBeenCalled();
    expect((await User.findById(user._id).lean()).isDeleted).toBe(false);
  });

  test("every in-flight status", async () => {
    for (const status of ["QUEUED", "SEARCHING", "ASSIGNED", "PARTNER_ACCEPTED", "ON_THE_WAY", "ARRIVED", "IN_PROGRESS", "NO_PARTNER_AVAILABLE"]) {
      const user = await makeUser();
      await makeBooking(user, { status });

      const res = await del(user);

      expect(res.body).toMatchObject({ code: "ACTIVE_BOOKING" });
    }
  });

  test("an open complaint — and the abandoned checkout is left alone then too", async () => {
    const user = await makeUser();
    const finished = await makeBooking(user, { status: "COMPLETED" });
    await Complaint.create({
      orderId: finished._id,
      userId: user._id,
      issueType: "OTHER",
      description: "The technician left early",
      status: "UNDER_REVIEW",
    });
    const abandoned = await abandonedCheckout(user);

    const res = await del(user);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: "OPEN_COMPLAINT" });
    expect((await Booking.findById(abandoned._id).lean()).status).toBe("PENDING_PAYMENT");
  });

  test("a guest add-on still waiting for payment: the customer can see it, so it blocks", async () => {
    const user = await makeUser();
    await abandonedCheckout(user, { origin: "partner_onspot", partner: new mongoose.Types.ObjectId() });

    const res = await del(user);

    expect(res.body).toMatchObject({ code: "ACTIVE_BOOKING" });
    expect(mockRelease).not.toHaveBeenCalled();
  });
});

describe("what doesn't block it", () => {
  test("finished and cancelled bookings, and a resolved complaint", async () => {
    const user = await makeUser();
    const done = await makeBooking(user, { status: "COMPLETED" });
    await makeBooking(user, { status: "CANCELLED" });
    await Complaint.create({
      orderId: done._id,
      userId: user._id,
      issueType: "OTHER",
      description: "Resolved already",
      status: "RESOLVED",
    });

    const res = await del(user);

    expect(res.statusCode).toBe(200);
    expect((await Booking.findById(done._id).lean()).status).toBe("COMPLETED");
  });

  test("an account that is already deleted can't be deleted again", async () => {
    const user = await makeUser();
    await del(user);

    const again = await del(user);

    expect(again.statusCode).toBe(400);
    expect(again.body.message).toBe("Account already deleted");
  });
});

test("a payment that lands while the checkouts are being cancelled keeps the account", async () => {
  const user = await makeUser();
  const abandoned = await abandonedCheckout(user);
  // The payment webhook wins the race: by the time the cancel is attempted the
  // booking has been paid, so the cancel finds nothing to cancel.
  mockRelease.mockImplementationOnce(async () => {});
  const realFind = Booking.findOneAndUpdate.bind(Booking);
  jest.spyOn(Booking, "findOneAndUpdate").mockImplementationOnce(async (...args) => {
    await Booking.updateOne({ _id: abandoned._id }, { $set: { status: "SEARCHING", "payment.status": "PAID" } });
    return realFind(...args);
  });

  const res = await del(user);

  expect(res.statusCode).toBe(400);
  expect(res.body).toMatchObject({ code: "ACTIVE_BOOKING" });
  expect((await Booking.findById(abandoned._id).lean()).status).toBe("SEARCHING");
  expect((await User.findById(user._id).lean()).isDeleted).toBe(false);
});
