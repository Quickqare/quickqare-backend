/**
 * Partner-side signals and fairer strike rules:
 *   - the silent "seen" signal (POST /api/partner/bookings/seen);
 *   - any app use records activity and ends an inactivity pause; a paused
 *     partner is left out of matching;
 *   - profile carries the partner's standing; job cards carry the exact start;
 *   - the urgent-jobs switch can't be switched on at night;
 *   - the 5th weekly strike pauses new jobs but no longer blocks the account;
 *   - a missed job alert (ACK timeout) is not a strike;
 *   - giving a job back 12h+ ahead is free (2 per week);
 *   - admin unblock/approve restores availability.
 */
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
}));

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const Category = require("../models/Category");
const Service = require("../models/service.model");
const BookingTimeline = require("../admin/models/BookingTimeline");
const push = require("../services/pushNotification.service");
const partnerAuth = require("../middlewares/partnerAuth");
const { markBookingsSeen, getPartnerBookings } = require("../controllers/partner.controller");
const { getPartnerProfile } = require("../controllers/partnerProfile.controller");
const { setPartnerStatus } = require("../controllers/partnerAuth.controller");
const { cancelBooking } = require("../controllers/booking.controller");
const { recordPartnerStrike } = require("../services/partnerLifecycle.service");
const { reassignBooking } = require("../services/assignmentEngine");
const { findEligiblePartnersForBooking } = require("../services/scheduling_service");
const adminPartnerRoutes = require("../admin/routes/v1/partners.routes");

const HOUR = 60 * 60 * 1000;
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

let seq = 0;
function makePartner(overrides = {}) {
  seq += 1;
  return Partner.create({
    name: `Partner ${seq}`,
    phone: `98770${String(seq).padStart(5, "0")}`,
    password: "Secret123",
    approvalStatus: "APPROVED",
    fcmToken: `token-${seq}`,
    ...overrides,
  });
}

function makeBooking(partner, start, overrides = {}) {
  return Booking.create({
    user: new mongoose.Types.ObjectId(),
    services: [{ serviceId: new mongoose.Types.ObjectId(), name: "Facial", quantity: 1, price: 500, lineTotal: 500 }],
    serviceCategory: "Salon for Women",
    baseAmount: 500,
    totalAmount: 590,
    scheduledDate: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
    scheduledTime: start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    scheduledStartAt: start,
    location: { type: "Point", coordinates: [88.36, 22.57] },
    pincode: "700016",
    address: "12 Park Street",
    payment: { status: "PAID" },
    partner: partner ? partner._id : null,
    status: "CONFIRMED",
    assignedAt: new Date(),
    ...overrides,
  });
}

// Date-only fake clock: mongoose/driver timers keep running for real.
const REAL_TIMER_APIS = [
  "hrtime", "nextTick", "performance", "queueMicrotask",
  "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback",
  "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout",
];
const setClock = (date) => jest.useFakeTimers({ doNotFake: REAL_TIMER_APIS, now: date });

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.useRealTimers());

describe("seen signal", () => {
  test("marks only the caller's jobs, once, and switches the check on for them", async () => {
    const ravi = await makePartner();
    const amit = await makePartner();
    const mine = await makeBooking(ravi, new Date(Date.now() + 5 * HOUR));
    const theirs = await makeBooking(amit, new Date(Date.now() + 5 * HOUR));

    const res = await call(markBookingsSeen, {
      partner: ravi,
      body: { bookingIds: [String(mine._id), String(theirs._id), "not-an-id"] },
    });

    expect(res.body).toEqual({ success: true, marked: 1 });
    const freshMine = await Booking.findById(mine._id).lean();
    expect(freshMine.partnerSeen.map((s) => String(s.partnerId))).toEqual([String(ravi._id)]);
    expect((await Booking.findById(theirs._id).lean()).partnerSeen).toEqual([]);
    expect((await Partner.findById(ravi._id).lean()).seenSignalAt).toBeInstanceOf(Date);
    const timeline = await BookingTimeline.find({ bookingId: mine._id }).lean();
    expect(timeline.map((t) => t.eventType)).toEqual(["PARTNER_SEEN"]);

    const again = await call(markBookingsSeen, { partner: ravi, body: { bookingIds: [String(mine._id)] } });
    expect(again.body).toEqual({ success: true, marked: 0 });
  });

  test("rejects a request without valid booking ids", async () => {
    const res = await call(markBookingsSeen, { partner: await makePartner(), body: { bookingIds: ["x"] } });
    expect(res.statusCode).toBe(400);
  });
});

describe("activity and inactivity pause", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  });

  test("any authenticated request records activity and ends an inactivity pause", async () => {
    const partner = await makePartner({
      inactivePausedAt: new Date(Date.now() - DAY),
      inactivePauseReason: "INACTIVE",
    });
    const token = jwt.sign({ id: partner._id, role: "partner" }, process.env.JWT_SECRET);
    const next = jest.fn();

    await partnerAuth({ headers: { authorization: `Bearer ${token}` } }, mockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    const fresh = await Partner.findById(partner._id).lean();
    expect(fresh.inactivePausedAt).toBeNull();
    expect(fresh.inactivePauseReason).toBe("");
    expect(Date.now() - new Date(fresh.lastActiveAt).getTime()).toBeLessThan(60 * 1000);
  });

  test("a paused partner is left out of matching", async () => {
    const salon = await Category.create({ name: "Salon for Women", slug: "salon-for-women" });
    const facial = await Service.create({ name: "Glow facial", price: 499, category: salon._id, duration: 45 });
    const offers = [{ serviceId: facial._id, name: facial.name, isActive: true }];
    const active = await makePartner({ serviceAreas: ["700001"], services: offers, gender: "FEMALE" });
    await makePartner({
      serviceAreas: ["700001"],
      services: offers,
      gender: "FEMALE",
      inactivePausedAt: new Date(),
    });

    const ranked = await findEligiblePartnersForBooking(
      {
        services: [{ serviceId: facial._id, quantity: 1 }],
        scheduledDate: "2026-11-02",
        scheduledTime: "10:00",
        pincode: "700001",
        rejectedPartners: [],
      },
      ["700001"],
      { requireOnline: false }
    );

    expect(ranked.map((e) => String(e.partner._id))).toEqual([String(active._id)]);
  });
});

describe("what the app is told", () => {
  test("profile carries the partner's standing", async () => {
    const now = new Date();
    const partner = await makePartner({
      weeklyCancelCount: 2,
      lastCancelReset: new Date(now.getTime() - 2 * DAY),
      freeReleaseCount: 1,
      freeReleaseWeekStart: new Date(now.getTime() - DAY),
      suspendedUntil: new Date(now.getTime() + 3 * DAY),
      isAvailable: false,
    });

    const res = await call(getPartnerProfile, { partner });

    expect(res.body.standing).toMatchObject({
      cancellationsThisWeek: 2,
      weeklyCancelLimit: 5,
      dailyCancelLimit: 1,
      freeReleasesLeft: 1,
      freeReleasesPerWeek: 2,
      freeReleaseMinHours: 12,
    });
    expect(new Date(res.body.standing.newJobsPausedUntil).getTime()).toBeGreaterThan(now.getTime());
  });

  test("job cards carry the exact start time", async () => {
    const partner = await makePartner();
    const start = new Date(Date.now() + 26 * HOUR);
    await makeBooking(partner, start);

    const res = await call(getPartnerBookings, { partner, query: {} });

    expect(new Date(res.body.bookings[0].scheduledStartAt).getTime()).toBe(start.getTime());
  });

  test("the urgent-jobs switch can't be switched on at night", async () => {
    const partner = await makePartner({ isOnline: false });

    setClock(new Date(2026, 9, 12, 23, 0));
    const night = await call(setPartnerStatus, { partner, body: { isOnline: true } });
    expect(night.body).toMatchObject({ success: true, isOnline: false, quietHours: true });

    setClock(new Date(2026, 9, 13, 9, 0));
    const morning = await call(setPartnerStatus, { partner, body: { isOnline: true } });
    expect(morning.body).toMatchObject({ success: true, isOnline: true, quietHours: false });
  });
});

describe("fairer strikes", () => {
  test("the 5th weekly strike pauses new jobs but doesn't block the account", async () => {
    const partner = await makePartner({ weeklyCancelCount: 4, lastCancelReset: new Date() });

    const updated = await recordPartnerStrike(partner._id);

    expect(updated.isBlocked).toBe(false);
    expect(updated.isAvailable).toBe(false);
    const days = (new Date(updated.suspendedUntil).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(6.9);
    expect(push.notifyPartner).toHaveBeenCalledTimes(1);
    expect(push.notifyPartner.mock.calls[0][1].type).toBe("ACCOUNT_SUSPENDED");
  });

  test("a job alert that times out without a response is not a strike", async () => {
    const partner = await makePartner();
    // Start already 2h past: the follow-up assignment attempt escalates at once.
    const booking = await makeBooking(partner, new Date(Date.now() - 2 * HOUR), { status: "ASSIGNED" });

    await reassignBooking(booking._id, partner._id, "TIMEOUT");

    const fresh = await Partner.findById(partner._id).lean();
    expect(fresh.weeklyCancelCount).toBe(0);
    const freshBooking = await Booking.findById(booking._id).lean();
    expect(freshBooking.rejectedPartners.map(String)).toContain(String(partner._id));
  });

  test("giving a job back 12h+ ahead costs no strike, up to 2 a week", async () => {
    const partner = await makePartner();
    const cancel = async () => {
      const booking = await makeBooking(partner, new Date(Date.now() + 2 * DAY));
      const fresh = await Partner.findById(partner._id);
      return call(cancelBooking, {
        params: { bookingId: String(booking._id) },
        body: { reason: "Health issue" },
        partner: fresh,
      });
    };

    const first = await cancel();
    expect(first.body).toMatchObject({ success: true, freeRelease: true });
    expect(first.body.message).toMatch(/no strike/);
    const second = await cancel();
    expect(second.body.freeRelease).toBe(true);

    let fresh = await Partner.findById(partner._id).lean();
    expect(fresh.weeklyCancelCount).toBe(0);
    expect(fresh.dailyCancelCount).toBe(0);
    expect(fresh.freeReleaseCount).toBe(2);

    // Third in the week: an ordinary cancellation again.
    const third = await cancel();
    expect(third.body).toMatchObject({ success: true, freeRelease: false });
    fresh = await Partner.findById(partner._id).lean();
    expect(fresh.weeklyCancelCount).toBe(1);
  });

  test("a cancel less than 12h before the start is an ordinary strike", async () => {
    const partner = await makePartner();
    const booking = await makeBooking(partner, new Date(Date.now() + 5 * HOUR));

    const res = await call(cancelBooking, {
      params: { bookingId: String(booking._id) },
      body: { reason: "Vehicle breakdown" },
      partner: await Partner.findById(partner._id),
    });

    expect(res.body).toMatchObject({ success: true, freeRelease: false });
    expect((await Partner.findById(partner._id).lean()).weeklyCancelCount).toBe(1);
  });
});

describe("admin unblock restores the partner", () => {
  const routeHandler = (path) => {
    const layer = adminPartnerRoutes.stack.find(
      (l) => l.route && l.route.path === path && l.route.methods.patch
    );
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle; // skip the audit middleware
  };

  test("setting a suspended partner back to APPROVED makes them available again", async () => {
    const partner = await makePartner({
      isBlocked: true,
      isAvailable: false,
      suspendedUntil: new Date(Date.now() + 5 * DAY),
      weeklyCancelCount: 5,
    });

    const res = await call(routeHandler("/:id/status"), {
      params: { id: String(partner._id) },
      body: { status: "APPROVED" },
      requestId: "test",
      adminUser: { id: "admin" },
    });

    expect(res.statusCode).toBe(200);
    const fresh = await Partner.findById(partner._id).lean();
    expect(fresh).toMatchObject({ isBlocked: false, isAvailable: true, suspendedUntil: null, weeklyCancelCount: 0 });
  });
});
