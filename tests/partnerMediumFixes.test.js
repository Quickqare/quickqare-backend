/**
 * Medium fixes from the Oct 2026 partner-app audit:
 *   6. start code: 5 wrong tries really means 5 (attempts reserved atomically),
 *      the lock lifts after 30 min, and support can reset it;
 *   7. partner photos are handed out as short-lived signed links;
 *   8. "Arrived" needs the partner near the customer; the no-refund
 *      "customer not reachable" close needs a verified arrival + 15 min wait;
 *   9. a penalty the partner owes is collected as soon as earnings mature;
 *  10. "On the way" stores the partner's starting point and bases the ETA on it.
 */

// Signed links (fix 7) need R2 credentials when config/r2 is first loaded.
Object.assign(process.env, {
  R2_ACCOUNT_ID: "testaccount",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET_NAME: "test-bucket",
  R2_PUBLIC_URL: "https://media.quickqare.test",
  R2_PRIVATE_UPLOADS: "true",
});

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
const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const PartnerWallet = require("../models/PartnerWallet");
const WalletTransaction = require("../models/WalletTransaction");
const PartnerPayoutAccount = require("../models/PartnerPayoutAccount");
const BookingTimeline = require("../admin/models/BookingTimeline");
const push = require("../services/pushNotification.service");
const {
  startService,
  markArrived,
  markOnTheWay,
  cancelBooking,
  getBookingById,
} = require("../controllers/booking.controller");
const { getPartnerProfile } = require("../controllers/partnerProfile.controller");
const { getWallet, requestWithdrawal } = require("../controllers/partnerWallet.controller");
const adminBookingRoutes = require("../admin/routes/v1/bookings.routes");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// Customer's pin (Park Street, Kolkata) — [lng, lat].
const CUSTOMER = { lat: 22.5526, lng: 88.3525 };

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
    phone: `98780${String(seq).padStart(5, "0")}`,
    password: "Secret123",
    approvalStatus: "APPROVED",
    ...overrides,
  });
}

function makeBooking(partner, overrides = {}) {
  const start = new Date(Date.now() + 30 * MINUTE);
  return Booking.create({
    user: new mongoose.Types.ObjectId(),
    services: [{ serviceId: new mongoose.Types.ObjectId(), name: "Facial", quantity: 1, price: 500, lineTotal: 500 }],
    serviceCategory: "Salon for Women",
    baseAmount: 500,
    totalAmount: 590,
    scheduledDate: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
    scheduledTime: start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    scheduledStartAt: start,
    location: { type: "Point", coordinates: [CUSTOMER.lng, CUSTOMER.lat] },
    pincode: "700016",
    address: "12 Park Street",
    payment: { status: "PAID" },
    partner: partner._id,
    status: "ON_THE_WAY",
    serviceStartCode: "4821",
    ...overrides,
  });
}

const routeHandler = (router, method, path) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle; // skip the audit middleware
};

beforeEach(() => jest.clearAllMocks());

/* ---------------- 6. start code ---------------- */
describe("start code", () => {
  const start = (booking, partner, startCode) =>
    call(startService, { params: { bookingId: String(booking._id) }, body: { startCode }, partner });

  test("20 parallel wrong codes get exactly 5 tries; the rest are locked out", async () => {
    const partner = await makePartner();
    const booking = await makeBooking(partner, { status: "ARRIVED" });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => start(booking, partner, String(1000 + i)))
    );

    expect(results.filter((r) => r.body?.code === "START_CODE_INVALID")).toHaveLength(5);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(15);
    const fresh = await Booking.findById(booking._id).lean();
    expect(fresh.startCodeAttempts).toBe(5);
    expect(fresh.startCodeLockedAt).toBeInstanceOf(Date);
    expect(fresh.status).toBe("ARRIVED");
  });

  test("still locked within 30 minutes of the lock", async () => {
    const partner = await makePartner();
    const booking = await makeBooking(partner, {
      status: "ARRIVED",
      startCodeAttempts: 5,
      startCodeLockedAt: new Date(Date.now() - 10 * MINUTE),
    });

    const res = await start(booking, partner, "4821");

    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe("START_CODE_LOCKED");
  });

  test("the lock lifts after 30 minutes; the right code starts the job and clears the count", async () => {
    const partner = await makePartner();
    const booking = await makeBooking(partner, {
      status: "ARRIVED",
      startCodeAttempts: 5,
      startCodeLockedAt: new Date(Date.now() - 31 * MINUTE),
    });

    const res = await start(booking, partner, "4821");

    expect(res.body).toMatchObject({ success: true });
    const fresh = await Booking.findById(booking._id).lean();
    expect(fresh).toMatchObject({ status: "IN_PROGRESS", startCodeAttempts: 0, startCodeLockedAt: null });
  });

  test("support can reset a locked start code", async () => {
    const partner = await makePartner();
    const booking = await makeBooking(partner, {
      status: "ARRIVED",
      startCodeAttempts: 5,
      startCodeLockedAt: new Date(),
    });

    const res = await call(routeHandler(adminBookingRoutes, "post", "/:id/reset-start-code"), {
      params: { id: String(booking._id) },
      requestId: "test",
      adminUser: { id: new mongoose.Types.ObjectId() },
    });

    expect(res.statusCode).toBe(200);
    const fresh = await Booking.findById(booking._id).lean();
    expect(fresh).toMatchObject({ startCodeAttempts: 0, startCodeLockedAt: null });
    const timeline = await BookingTimeline.find({ bookingId: booking._id }).lean();
    expect(timeline.map((t) => t.eventType)).toEqual(["START_CODE_RESET"]);
  });
});

/* ---------------- 7. private partner photos ---------------- */
describe("partner photos are handed out as signed links", () => {
  const STORED = "https://media.quickqare.test/selfies/1700000000000_abc.jpg";

  test("on the customer's booking screen", async () => {
    const partner = await makePartner({ selfieUrl: STORED, selfieVerificationStatus: "APPROVED" });
    const booking = await makeBooking(partner);

    const res = await call(getBookingById, {
      params: { bookingId: String(booking._id) },
      user: { _id: booking.user },
    });

    const url = res.body.booking.partner.selfieUrl;
    expect(url).toMatch(/X-Amz-Signature=/);
    expect(url).toContain("selfies/1700000000000_abc.jpg");
    expect(url.startsWith("https://media.quickqare.test")).toBe(false);
  });

  test("in the partner's own profile", async () => {
    const partner = await makePartner({ selfieUrl: STORED });

    const res = await call(getPartnerProfile, { partner: await Partner.findById(partner._id) });

    expect(res.body.partner.selfieUrl).toMatch(/X-Amz-Signature=/);
  });
});

/* ---------------- 8. arrival proof + wait at the door ---------------- */
describe("arriving at the customer", () => {
  const arrive = async (booking, partner, body = {}) =>
    call(markArrived, {
      params: { bookingId: String(booking._id) },
      body,
      partner: await Partner.findById(partner._id),
    });

  test("'Arrived' far from the customer is refused", async () => {
    const partner = await makePartner();
    const booking = await makeBooking(partner);

    // ~2 km north of the pin.
    const res = await arrive(booking, partner, { latitude: CUSTOMER.lat + 0.018, longitude: CUSTOMER.lng });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("NOT_AT_CUSTOMER");
    expect((await Booking.findById(booking._id).lean()).status).toBe("ON_THE_WAY");
  });

  test("'Arrived' at the door is verified and the customer is told", async () => {
    const partner = await makePartner();
    const booking = await makeBooking(partner);

    // ~45 m away.
    const res = await arrive(booking, partner, { latitude: CUSTOMER.lat + 0.0004, longitude: CUSTOMER.lng, accuracy: 20 });

    expect(res.body).toMatchObject({ success: true });
    const fresh = await Booking.findById(booking._id).lean();
    expect(fresh.status).toBe("ARRIVED");
    expect(fresh.arrivedLocationVerified).toBe(true);
    expect(fresh.arrivedDistanceMeters).toBeLessThan(60);
    expect(push.notifyCustomerOfBookingStatus.mock.calls[0][1]).toBe("ARRIVED");
  });

  test("without a GPS fix it falls back to a fresh location ping", async () => {
    const partner = await makePartner({
      location: { type: "Point", coordinates: [CUSTOMER.lng, CUSTOMER.lat + 0.0005] },
      lastLocationAt: new Date(Date.now() - 2 * MINUTE),
    });
    const booking = await makeBooking(partner);

    await arrive(booking, partner);

    expect((await Booking.findById(booking._id).lean()).arrivedLocationVerified).toBe(true);
  });

  test("with no fresh location at all it's allowed but unverified", async () => {
    const partner = await makePartner({
      location: { type: "Point", coordinates: [CUSTOMER.lng, CUSTOMER.lat] },
      lastLocationAt: new Date(Date.now() - 2 * HOUR),
    });
    const booking = await makeBooking(partner);

    const res = await arrive(booking, partner);

    expect(res.body).toMatchObject({ success: true });
    const fresh = await Booking.findById(booking._id).lean();
    expect(fresh.status).toBe("ARRIVED");
    expect(fresh.arrivedLocationVerified).toBe(false);
  });
});

describe("'Customer not reachable' at the door", () => {
  const cancelAtDoor = async (booking, partner) =>
    call(cancelBooking, {
      params: { bookingId: String(booking._id) },
      body: { reason: "Customer not reachable" },
      partner: await Partner.findById(partner._id),
    });

  test("before 15 minutes at the door it's an ordinary cancel with a strike", async () => {
    const partner = await makePartner();
    const booking = await makeBooking(partner, {
      status: "ARRIVED",
      arrivedAt: new Date(Date.now() - 5 * MINUTE),
      arrivedLocationVerified: true,
    });

    const res = await cancelAtDoor(booking, partner);

    expect(res.body).toMatchObject({ success: true, message: "Booking cancelled and reassigned" });
    expect(res.body.penalty).toBeUndefined();
    expect((await Partner.findById(partner._id).lean()).weeklyCancelCount).toBe(1);
  });

  test("after a verified arrival and 15+ minutes it closes as the customer's fault (no refund)", async () => {
    const partner = await makePartner();
    const booking = await makeBooking(partner, {
      status: "ARRIVED",
      arrivedAt: new Date(Date.now() - 20 * MINUTE),
      arrivedLocationVerified: true,
    });

    const res = await cancelAtDoor(booking, partner);

    expect(res.body.penalty).toBe(100);
    const fresh = await Booking.findById(booking._id).lean();
    expect(fresh).toMatchObject({ status: "CANCELLED", refundAmount: 0, cancelledBy: "partner" });
    expect((await Partner.findById(partner._id).lean()).weeklyCancelCount).toBe(0);
  });

  test("an unverified arrival never unlocks the no-refund close", async () => {
    const partner = await makePartner();
    const booking = await makeBooking(partner, {
      status: "ARRIVED",
      arrivedAt: new Date(Date.now() - 40 * MINUTE),
      arrivedLocationVerified: false,
    });

    const res = await cancelAtDoor(booking, partner);

    expect(res.body.message).toBe("Booking cancelled and reassigned");
    expect((await Partner.findById(partner._id).lean()).weeklyCancelCount).toBe(1);
  });
});

/* ---------------- 9. owed penalties ---------------- */
describe("a penalty the partner owes", () => {
  async function walletWithOwedPenalty({ withdrawable = 0, pendingCredit = 0, owed = 100 }) {
    const partner = await makePartner();
    // Partner's post-save hook creates the wallet; set its balances.
    await PartnerWallet.updateOne(
      { partnerId: partner._id },
      {
        $set: {
          balance: withdrawable,
          withdrawableBalance: withdrawable,
          pendingBalance: pendingCredit,
          totalEarnings: withdrawable + pendingCredit,
          totalWithdrawn: 0,
        },
      },
      { upsert: true }
    );
    if (pendingCredit) {
      const credit = await WalletTransaction.create({
        partnerId: partner._id,
        amount: pendingCredit,
        type: "credit",
        reason: "job_payment",
        bookingId: new mongoose.Types.ObjectId(),
        status: "pending",
      });
      await WalletTransaction.collection.updateOne(
        { _id: credit._id },
        { $set: { createdAt: new Date(Date.now() - 72 * HOUR) } }
      );
    }
    const debt = await WalletTransaction.create({
      partnerId: partner._id,
      amount: owed,
      type: "debit",
      reason: "penalty",
      status: "pending",
      description: "Penalty — OUTSTANDING",
    });
    return { partner, debt };
  }

  test("is collected as soon as earnings come out of the 48h hold", async () => {
    const { partner, debt } = await walletWithOwedPenalty({ pendingCredit: 500 });

    const res = await call(getWallet, { partner });

    expect(res.body.wallet.withdrawableBalance).toBe(400);
    expect((await WalletTransaction.findById(debt._id).lean()).status).toBe("success");
  });

  test("can't be withdrawn around", async () => {
    const { partner } = await walletWithOwedPenalty({ withdrawable: 250 });
    await PartnerPayoutAccount.create({
      partnerId: partner._id,
      method: "UPI",
      accountHolderName: "Partner",
      upiId: "partner@okhdfcbank",
      status: "VERIFIED",
      revision: 1,
    });

    const res = await call(requestWithdrawal, { partner, body: { amount: 250 } });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Available: ₹150/);
  });
});

/* ---------------- 10. ETA from where the partner sets off ---------------- */
describe("'On the way'", () => {
  test("stores the partner's starting point and bases the ETA on it", async () => {
    const partner = await makePartner({
      location: { type: "Point", coordinates: [77.59, 12.97] }, // stale, far away
      lastLocationAt: new Date(Date.now() - 6 * HOUR),
    });
    const booking = await makeBooking(partner, { status: "PARTNER_ACCEPTED" });

    // ~3 km north of the customer.
    const res = await call(markOnTheWay, {
      params: { bookingId: String(booking._id) },
      body: { latitude: CUSTOMER.lat + 0.027, longitude: CUSTOMER.lng },
      partner: await Partner.findById(partner._id),
    });

    expect(res.body).toMatchObject({ success: true });
    expect(res.body.etaMinutes).toBe(9); // 3 km × 3 min/km
    const fresh = await Partner.findById(partner._id).lean();
    expect(fresh.location.coordinates).toEqual([CUSTOMER.lng, CUSTOMER.lat + 0.027]);
    expect(Date.now() - new Date(fresh.lastLocationAt).getTime()).toBeLessThan(MINUTE);
  });
});
