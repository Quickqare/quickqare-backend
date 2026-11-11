/**
 * Free-cancel ("grace") window, Oct 2026:
 *  - every booking can get a short window (allBookingsWindowMinutes), last-minute
 *    bookings a longer one (windowMinutes under appliesBelowLeadHours of notice);
 *  - the window closes once the professional sets off (endsWhenPartnerOnTheWay);
 *  - a customer who used it freeCancelLimit times in freeCancelLimitDays gets
 *    no window on new bookings.
 */
jest.mock("../services/pushNotification.service", () => ({
  notifyPartner: jest.fn(),
  notifyCustomerOfBookingStatus: jest.fn(),
  sendJobCancelledPush: jest.fn(),
  sendJobAssignedPush: jest.fn(),
  sendJobCompletedPush: jest.fn(),
  sendBookingStatusPush: jest.fn(),
  sendPushNotification: jest.fn(),
}));

// Razorpay isn't reachable in tests — the refund amount is what matters here.
jest.mock("../services/autoRefund.service", () => ({
  issueAutoRefund: jest.fn(async () => ({ status: "pending" })),
}));

// Mongo transactions aren't available in the in-memory database (no replica set).
const mockPrepare = jest.fn(async () => ({}));
const mockCommit = jest.fn(async () => ({
  lock: { _id: "lock-1" },
  requiredCount: 1,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
}));
jest.mock("../services/slotCapacity.service", () => ({
  ...jest.requireActual("../services/slotCapacity.service"),
  prepareSlotReservation: (...args) => mockPrepare(...args),
  commitSlotReservation: (...args) => mockCommit(...args),
}));

const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Category = require("../models/Category");
const Service = require("../models/service.model");
const User = require("../models/User");
const Zone = require("../models/zone.model");
const AdminSetting = require("../admin/models/AdminSetting");
const { createBooking, cancelBookingByUser } = require("../controllers/booking.controller");
const {
  createGraceCollector,
  computeFreeCancelFields,
  isFreeCancelActive,
} = require("../services/cancellationGrace.service");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

const call = async (handler, req) => {
  const res = mockRes();
  await handler(req, res);
  return res;
};

const mergedFrom = (...graces) => {
  const { collect, merged } = createGraceCollector();
  for (const g of graces) collect({ cancellationGrace: g });
  return merged;
};

/* ---------- the rule itself ---------- */

describe("how long the window is", () => {
  const NOW = Date.UTC(2026, 9, 24, 6, 0, 0);
  const fields = (merged, leadHours) =>
    computeFreeCancelFields({
      merged,
      scheduledStartAt: new Date(NOW + leadHours * HOUR),
      userId: null,
      settings: null,
      now: NOW,
    });

  test("every booking gets the every-booking window", async () => {
    const f = await fields(mergedFrom({ allBookingsWindowMinutes: 15 }), 48);
    expect(f.freeCancelUntil.getTime()).toBe(NOW + 15 * MINUTE);
    expect(f.freeCancelEndsOnPartnerDeparture).toBe(true);
  });

  test("a last-minute booking gets the longer window, others the every-booking one", async () => {
    const merged = mergedFrom({ allBookingsWindowMinutes: 15, windowMinutes: 30, appliesBelowLeadHours: 4 });
    expect((await fields(merged, 3)).freeCancelUntil.getTime()).toBe(NOW + 30 * MINUTE);
    expect((await fields(merged, 5)).freeCancelUntil.getTime()).toBe(NOW + 15 * MINUTE);
  });

  test("the older setting (threshold 0) still applies to every booking", async () => {
    const f = await fields(mergedFrom({ windowMinutes: 60, appliesBelowLeadHours: 0 }), 72);
    expect(f.freeCancelUntil.getTime()).toBe(NOW + 60 * MINUTE);
  });

  test("no window configured → none", async () => {
    const f = await fields(mergedFrom({}, { windowMinutes: 0 }), 2);
    expect(f.freeCancelUntil).toBeNull();
  });

  test("several services: the most generous window, and it only ends on departure if all say so", async () => {
    const merged = mergedFrom(
      { allBookingsWindowMinutes: 15 },
      { allBookingsWindowMinutes: 20, endsWhenPartnerOnTheWay: false }
    );
    const f = await fields(merged, 24);
    expect(f.freeCancelUntil.getTime()).toBe(NOW + 20 * MINUTE);
    expect(f.freeCancelEndsOnPartnerDeparture).toBe(false);
  });
});

describe("when the window closes", () => {
  const open = { freeCancelUntil: new Date(Date.now() + 10 * MINUTE) };

  test("open before the professional sets off", () => {
    expect(isFreeCancelActive({ ...open, status: "CONFIRMED", freeCancelEndsOnPartnerDeparture: true })).toBe(true);
  });

  test("closes once they're on the way, unless the service keeps it open", () => {
    expect(isFreeCancelActive({ ...open, status: "ON_THE_WAY", freeCancelEndsOnPartnerDeparture: true })).toBe(false);
    expect(isFreeCancelActive({ ...open, status: "ON_THE_WAY", freeCancelEndsOnPartnerDeparture: false })).toBe(true);
  });

  test("closes when the time runs out", () => {
    expect(isFreeCancelActive({ freeCancelUntil: new Date(Date.now() - MINUTE), status: "CONFIRMED" })).toBe(false);
  });
});

/* ---------- creating a booking ---------- */

describe("creating a booking", () => {
  let user;
  let service;
  let inserted;

  beforeEach(async () => {
    const category = await Category.create({ name: "Salon for Women" });
    service = await Service.create({
      name: "Facial",
      price: 500,
      category: category._id,
      isActive: true,
      cancellationGrace: { allBookingsWindowMinutes: 15 },
    });
    await Zone.create({ pincode: "700016" });
    user = await User.create({ name: "Asha Roy", phone: "9876500001" });

    inserted = null;
    jest.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: async (fn) => fn(),
      endSession: async () => {},
    });
    jest.spyOn(Booking, "create").mockImplementation(async ([payload]) => {
      inserted = payload;
      return [{ ...payload, _id: new mongoose.Types.ObjectId() }];
    });
  });

  afterEach(() => jest.restoreAllMocks());

  const inTwoDays = () => {
    const d = new Date(Date.now() + 2 * DAY);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const create = () =>
    call(createBooking, {
      user,
      body: {
        services: [{ serviceId: String(service._id), quantity: 1 }],
        serviceCategory: "Salon for Women",
        scheduledDate: inTwoDays(),
        scheduledTime: "10:00 AM",
        pincode: "700016",
        address: "12 Park Street",
        houseDetails: "Flat 4B",
        location: { type: "Point", coordinates: [88.3525, 22.5526] },
      },
    });

  // Past free-window cancels by this customer (inserted directly — Booking.create is stubbed).
  const pastFreeCancels = (count, daysAgo = 2) =>
    Booking.insertMany(
      Array.from({ length: count }, () => ({
        user: user._id,
        services: [{ serviceId: service._id, name: "Facial", quantity: 1, price: 500, lineTotal: 500 }],
        baseAmount: 500,
        totalAmount: 590,
        scheduledDate: new Date(),
        scheduledTime: "10:00 AM",
        pincode: "700016",
        address: "12 Park Street",
        location: { type: "Point", coordinates: [88.3525, 22.5526] },
        status: "CANCELLED",
        cancelledBy: "user",
        cancelledAt: new Date(Date.now() - daysAgo * DAY),
        cancelledInFreeWindow: true,
      }))
    );

  test("the booking carries the window", async () => {
    const before = Date.now();
    const res = await create();
    expect(res.statusCode).toBe(201);
    const until = new Date(inserted.freeCancelUntil).getTime();
    expect(until).toBeGreaterThanOrEqual(before + 15 * MINUTE);
    expect(until).toBeLessThanOrEqual(Date.now() + 15 * MINUTE);
    expect(inserted.freeCancelEndsOnPartnerDeparture).toBe(true);
    expect(inserted.freeCancelBlockedByLimit).toBe(false);
  });

  test("a customer who used it 3 times in 30 days gets no window (default limit)", async () => {
    await pastFreeCancels(3);
    const res = await create();
    expect(res.statusCode).toBe(201);
    expect(inserted.freeCancelUntil).toBeNull();
    expect(inserted.freeCancelBlockedByLimit).toBe(true);
  });

  test("under the limit, or cancels older than the period, still get it", async () => {
    await pastFreeCancels(2);
    await pastFreeCancels(5, 40);
    await create();
    expect(inserted.freeCancelUntil).not.toBeNull();
  });

  test("the admin can change or turn off the limit", async () => {
    await pastFreeCancels(3);
    await AdminSetting.create({ cancellation: { freeCancelLimit: 0 } });
    await create();
    expect(inserted.freeCancelUntil).not.toBeNull();

    await AdminSetting.updateOne({}, { $set: { "cancellation.freeCancelLimit": 5 } });
    await pastFreeCancels(2);
    await create();
    expect(inserted.freeCancelBlockedByLimit).toBe(true);
  });
});

/* ---------- cancelling ---------- */

describe("cancelling", () => {
  let userId;
  beforeEach(() => {
    userId = new mongoose.Types.ObjectId();
  });

  // Service 30 min away: the default tiers would refund 25%.
  const makeBooking = (overrides = {}) => {
    const start = new Date(Date.now() + 30 * MINUTE);
    return Booking.create({
      user: userId,
      services: [{ serviceId: new mongoose.Types.ObjectId(), name: "Facial", quantity: 1, price: 500, lineTotal: 500 }],
      baseAmount: 500,
      totalAmount: 1000,
      scheduledDate: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
      scheduledTime: "10:00 AM",
      scheduledStartAt: start,
      pincode: "700016",
      address: "12 Park Street",
      location: { type: "Point", coordinates: [88.3525, 22.5526] },
      payment: { status: "PAID" },
      status: "CONFIRMED",
      freeCancelUntil: new Date(Date.now() + 10 * MINUTE),
      freeCancelEndsOnPartnerDeparture: true,
      ...overrides,
    });
  };

  const cancel = (booking) =>
    call(cancelBookingByUser, { params: { bookingId: String(booking._id) }, user: { _id: userId }, body: {} });

  test("inside the window: full refund, counted as a free cancel", async () => {
    const b = await makeBooking();
    const res = await cancel(b);
    expect(res.body.refund).toMatchObject({ percent: 100, amount: 1000 });
    expect((await Booking.findById(b._id)).cancelledInFreeWindow).toBe(true);
  });

  test("professional on the way: the window has closed, normal tier applies", async () => {
    const b = await makeBooking({ status: "ON_THE_WAY" });
    const res = await cancel(b);
    expect(res.body.refund).toMatchObject({ percent: 25, amount: 250 });
    expect((await Booking.findById(b._id)).cancelledInFreeWindow).toBe(false);
  });

  test("on the way but the service keeps the window open: full refund", async () => {
    const b = await makeBooking({ status: "ON_THE_WAY", freeCancelEndsOnPartnerDeparture: false });
    const res = await cancel(b);
    expect(res.body.refund.percent).toBe(100);
  });

  test("window over: normal tier", async () => {
    const b = await makeBooking({ freeCancelUntil: new Date(Date.now() - MINUTE) });
    const res = await cancel(b);
    expect(res.body.refund.percent).toBe(25);
    expect((await Booking.findById(b._id)).cancelledInFreeWindow).toBe(false);
  });
});

/* ---------- admin: saving the policy ---------- */

describe("admin saves the free-cancel settings", () => {
  const servicesRoutes = require("../admin/routes/v1/services.routes");
  const routeHandler = (router, method, path) => {
    const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle; // skip the audit middleware
  };
  const save = routeHandler(servicesRoutes, "patch", "/:id/cancellation-policy");

  test("every-booking + last-minute windows and the departure switch, applied to all services", async () => {
    const category = await Category.create({ name: "AC" });
    const a = await Service.create({ name: "AC cleaning", price: 499, category: category._id });
    const b = await Service.create({ name: "AC repair", price: 599, category: category._id });
    const grace = { allBookingsWindowMinutes: 15, windowMinutes: 30, appliesBelowLeadHours: 4, endsWhenPartnerOnTheWay: false };

    const res = await call(save, { params: { id: String(a._id) }, body: { tiers: [], grace, applyTo: "all" }, requestId: "t" });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.appliedCount).toBe(2);
    expect((await Service.findById(b._id).lean()).cancellationGrace).toMatchObject(grace);
  });

  test("bad values are refused; grace: null turns it off", async () => {
    const category = await Category.create({ name: "AC" });
    const a = await Service.create({ name: "AC cleaning", price: 499, category: category._id });

    const bad = await call(save, { params: { id: String(a._id) }, body: { tiers: [], grace: { allBookingsWindowMinutes: -5 } }, requestId: "t" });
    expect(bad.statusCode).toBe(400);

    const off = await call(save, { params: { id: String(a._id) }, body: { tiers: [], grace: null }, requestId: "t" });
    expect(off.statusCode).toBe(200);
    expect((await Service.findById(a._id).lean()).cancellationGrace).toMatchObject({
      allBookingsWindowMinutes: 0,
      windowMinutes: 0,
      endsWhenPartnerOnTheWay: true,
    });
  });
});
