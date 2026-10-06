/**
 * Customer pushes for what a customer must hear about even with the app closed
 * (customer-app audit, Oct 2026, item 9):
 *   - a booking closed by someone other than the customer — an admin, the
 *     platform (no professional found, stale booking) or the partner at the door;
 *   - an on-site estimate waiting for their approval;
 *   - a guest-mehendi add-on waiting for their approval.
 * The real push service runs end to end; only Firebase is faked.
 */
Object.assign(process.env, {
  R2_ACCOUNT_ID: "testaccount",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET_NAME: "test-bucket",
  R2_PUBLIC_URL: "https://media.quickqare.test",
});

const mockSend = jest.fn().mockResolvedValue("message-id");
jest.mock("../config/firebase", () => ({
  apps: [{}],
  messaging: () => ({ send: (...args) => mockSend(...args) }),
}));

const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const CatalogItem = require("../models/CatalogItem");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");
const User = require("../models/User");
const { notifyCustomerOfBookingStatus } = require("../services/pushNotification.service");
const { escalateUnassignedBooking } = require("../services/escalation.service");
const { cancelStaleBookings } = require("../services/cron.service");
const { cancelBooking, cancelBookingByUser } = require("../controllers/booking.controller");
const { submitEstimate } = require("../controllers/partner.controller");
const { createGuestAddon } = require("../controllers/guestAddon.controller");
const adminBookingRoutes = require("../admin/routes/v1/bookings.routes");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

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

const routeHandler = (router, method, path) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle; // skip the audit middleware
};

let seq = 0;

function makeCustomer(overrides = {}) {
  seq += 1;
  return User.create({
    name: `Asha ${seq}`,
    phone: `98770${String(seq).padStart(5, "0")}`,
    fcmToken: `customer-token-${seq}`,
    ...overrides,
  });
}

function makePartner(overrides = {}) {
  seq += 1;
  return Partner.create({
    name: `Partner ${seq}`,
    phone: `98771${String(seq).padStart(5, "0")}`,
    password: "Secret123",
    approvalStatus: "APPROVED",
    ...overrides,
  });
}

function makeBooking(customer, overrides = {}) {
  const start = new Date(Date.now() + 3 * HOUR);
  return Booking.create({
    user: customer._id,
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
    payment: { status: "PAID" },
    status: "CONFIRMED",
    ...overrides,
  });
}

// The senders are fire-and-forget, so a push lands a moment after the call
// that triggers it returns.
async function eventually(check, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    try {
      return check();
    } catch (err) {
      if (Date.now() - started > timeoutMs) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

// To prove nothing is sent, give anything that was going to be sent time to be.
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

const sent = () => mockSend.mock.calls.map((c) => c[0]);

beforeEach(() => {
  mockSend.mockClear();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("customer push messages", () => {
  test("a cancellation with a refund says how much", async () => {
    const customer = await makeCustomer();

    await notifyCustomerOfBookingStatus(customer._id, "CANCELLED", "booking-1", { refundAmount: 590 });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const message = mockSend.mock.calls[0][0];
    expect(message.token).toBe(customer.fcmToken);
    expect(message.notification).toEqual({
      title: "Booking cancelled",
      body: "Your booking was cancelled. A refund of ₹590 is being processed.",
    });
    // The app opens the booking for BOOKING_UPDATE.
    expect(message.data).toEqual({ type: "BOOKING_UPDATE", bookingId: "booking-1", status: "CANCELLED" });
  });

  test("a cancellation with no refund doesn't mention money", async () => {
    const customer = await makeCustomer();

    await notifyCustomerOfBookingStatus(customer._id, "CANCELLED", "booking-1", { refundAmount: 0 });
    await notifyCustomerOfBookingStatus(customer._id, "CANCELLED", "booking-2");

    for (const message of sent()) {
      expect(message.notification.body).toBe("Your booking was cancelled. Open the app for details.");
    }
  });

  test("an estimate opens the estimate screen, and quotes no amount", async () => {
    const customer = await makeCustomer();

    await notifyCustomerOfBookingStatus(customer._id, "ESTIMATE_SUBMITTED", "booking-1", { amount: 800 });

    const message = mockSend.mock.calls[0][0];
    expect(message.notification.title).toBe("Additional work needs your approval");
    // What the customer pays includes taxes the estimate doesn't: the app shows the real figure.
    expect(message.notification.body).not.toMatch(/₹|800/);
    expect(message.data).toEqual({ type: "ESTIMATE_SUBMITTED", bookingId: "booking-1" });
  });

  test("a guest add-on request counts the guests and points at the visit it rides on", async () => {
    const customer = await makeCustomer();

    await notifyCustomerOfBookingStatus(customer._id, "GUEST_ADDON_REQUESTED", "addon-1", {
      guests: 3,
      parentBookingId: "booking-1",
    });
    await notifyCustomerOfBookingStatus(customer._id, "GUEST_ADDON_REQUESTED", "addon-2", { guests: 1 });

    const [many, one] = sent();
    expect(many.notification.body).toBe("Your artist added 3 guest designs. Tap to approve and pay.");
    expect(many.data).toEqual({ type: "GUEST_ADDON_REQUESTED", bookingId: "addon-1", parentBookingId: "booking-1" });
    expect(one.notification.body).toBe("Your artist added 1 guest design. Tap to approve and pay.");
    expect(one.data).toEqual({ type: "GUEST_ADDON_REQUESTED", bookingId: "addon-2" });
  });

  test("the existing status pushes are unchanged", async () => {
    const customer = await makeCustomer();

    await notifyCustomerOfBookingStatus(customer._id, "ON_THE_WAY", "booking-1");

    const message = mockSend.mock.calls[0][0];
    expect(message.notification).toEqual({
      title: "Partner On The Way",
      body: "Your partner is heading to your location.",
    });
    expect(message.data).toEqual({ type: "BOOKING_UPDATE", bookingId: "booking-1", status: "ON_THE_WAY" });
  });

  test("nothing is sent without a token, or for an event with no message", async () => {
    const noToken = await makeCustomer({ fcmToken: "" });
    const customer = await makeCustomer();

    await notifyCustomerOfBookingStatus(noToken._id, "CANCELLED", "booking-1");
    await notifyCustomerOfBookingStatus(customer._id, "SEARCHING", "booking-1");
    await notifyCustomerOfBookingStatus(null, "CANCELLED", "booking-1");

    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("a booking closed by someone other than the customer", () => {
  test("the platform finding no replacement partner tells a customer who paid", async () => {
    const customer = await makeCustomer();
    const booking = await makeBooking(customer, { status: "NO_PARTNER_AVAILABLE", autoRefundIfUnassigned: true });

    await escalateUnassignedBooking(booking._id);

    await eventually(() => expect(mockSend).toHaveBeenCalledTimes(1));
    const message = mockSend.mock.calls[0][0];
    expect(message.token).toBe(customer.fcmToken);
    expect(message.notification.body).toContain("₹590");
    expect(message.data).toMatchObject({ type: "BOOKING_UPDATE", status: "CANCELLED", bookingId: String(booking._id) });
  });

  test("…but says nothing about an unpaid booking the customer can't see", async () => {
    const customer = await makeCustomer();
    const booking = await makeBooking(customer, {
      status: "NO_PARTNER_AVAILABLE",
      autoRefundIfUnassigned: true,
      payment: { status: "PENDING" },
    });

    await escalateUnassignedBooking(booking._id);
    await settle();

    expect((await Booking.findById(booking._id).lean()).status).toBe("CANCELLED");
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("the stale-booking cleanup tells the customers whose paid bookings it cancelled", async () => {
    const paidCustomer = await makeCustomer();
    const unpaidCustomer = await makeCustomer();
    const paid = await makeBooking(paidCustomer, { status: "SEARCHING" });
    const unpaid = await makeBooking(unpaidCustomer, {
      status: "PENDING_PAYMENT",
      payment: { status: "PENDING" },
      lockedUntil: new Date(Date.now() - HOUR),
    });
    const old = new Date(Date.now() - 72 * HOUR);
    await Booking.collection.updateMany({}, { $set: { createdAt: old, updatedAt: old } });

    await cancelStaleBookings(new Date());

    expect((await Booking.findById(paid._id).lean()).status).toBe("CANCELLED");
    expect((await Booking.findById(unpaid._id).lean()).status).toBe("CANCELLED");
    await eventually(() => expect(mockSend).toHaveBeenCalledTimes(1));
    await settle();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const message = mockSend.mock.calls[0][0];
    expect(message.token).toBe(paidCustomer.fcmToken);
    expect(message.notification.body).toContain("₹590");
  });

  test("a partner closing it at the door as the customer's fault tells the customer, with no refund", async () => {
    const customer = await makeCustomer();
    const partner = await makePartner();
    const booking = await makeBooking(customer, {
      partner: partner._id,
      status: "ARRIVED",
      arrivedAt: new Date(Date.now() - 20 * MINUTE),
      arrivedLocationVerified: true,
    });

    const res = await call(cancelBooking, {
      params: { bookingId: String(booking._id) },
      body: { reason: "Customer not reachable" },
      partner: await Partner.findById(partner._id),
    });

    expect(res.body).toMatchObject({ success: true });
    await eventually(() => expect(mockSend).toHaveBeenCalledTimes(1));
    const message = mockSend.mock.calls[0][0];
    expect(message.token).toBe(customer.fcmToken);
    expect(message.notification.body).toBe("Your booking was cancelled. Open the app for details.");
  });

  test("an admin cancel of a paid booking says what is being refunded", async () => {
    const customer = await makeCustomer();
    const booking = await makeBooking(customer);

    const res = await call(routeHandler(adminBookingRoutes, "post", "/:id/cancel"), {
      params: { id: String(booking._id) },
      body: { reason: "ops error" },
      adminUser: { id: new mongoose.Types.ObjectId(), email: "ops@test.local" },
      requestId: "req-1",
    });

    expect(res.statusCode).toBe(200);
    await eventually(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend.mock.calls[0][0].notification.body).toContain("₹590");
  });

  test("an admin force-cancel with no refund doesn't promise one", async () => {
    const customer = await makeCustomer();
    const booking = await makeBooking(customer, { status: "ASSIGNED" });

    const res = await call(routeHandler(adminBookingRoutes, "post", "/:id/force-cancel"), {
      params: { id: String(booking._id) },
      body: { reason: "customer abuse", refund: false },
      adminUser: { id: new mongoose.Types.ObjectId(), email: "ops@test.local" },
      requestId: "req-2",
    });

    expect(res.statusCode).toBe(200);
    await eventually(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend.mock.calls[0][0].notification.body).toBe(
      "Your booking was cancelled. Open the app for details."
    );
  });

  test("an admin cancelling a booking nobody paid for sends nothing", async () => {
    const customer = await makeCustomer();
    const booking = await makeBooking(customer, { status: "PENDING_PAYMENT", payment: { status: "PENDING" } });

    const res = await call(routeHandler(adminBookingRoutes, "post", "/:id/cancel"), {
      params: { id: String(booking._id) },
      body: { reason: "abandoned" },
      adminUser: { id: new mongoose.Types.ObjectId(), email: "ops@test.local" },
      requestId: "req-3",
    });
    await settle();

    expect(res.statusCode).toBe(200);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("the customer cancelling their own booking is not pushed to them", async () => {
    const customer = await makeCustomer();
    const booking = await makeBooking(customer);

    const res = await call(cancelBookingByUser, {
      params: { bookingId: String(booking._id) },
      body: {},
      user: customer,
    });
    await settle();

    expect(res.body).toMatchObject({ success: true });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("work that waits for the customer's approval", () => {
  test("a technician's estimate is pushed to the customer", async () => {
    const customer = await makeCustomer();
    const partner = await makePartner();
    const item = await CatalogItem.create({ name: "Compressor", priceInr: 400, unit: "piece" });
    const booking = await makeBooking(customer, { partner: partner._id, status: "IN_PROGRESS" });

    const res = await call(submitEstimate, {
      partner,
      body: { bookingId: String(booking._id), items: [{ serviceId: String(item._id), quantity: 2 }] },
    });

    expect(res.body).toMatchObject({ success: true, estimateTotal: 800 });
    await eventually(() => expect(mockSend).toHaveBeenCalledTimes(1));
    const message = mockSend.mock.calls[0][0];
    expect(message.token).toBe(customer.fcmToken);
    expect(message.data).toEqual({ type: "ESTIMATE_SUBMITTED", bookingId: String(booking._id) });
  });

  test("an estimate that is rejected as invalid is not pushed", async () => {
    const customer = await makeCustomer();
    const partner = await makePartner();
    const booking = await makeBooking(customer, { partner: partner._id, status: "IN_PROGRESS" });

    const res = await call(submitEstimate, {
      partner,
      body: { bookingId: String(booking._id), items: [{ serviceId: String(new mongoose.Types.ObjectId()), quantity: 1 }] },
    });
    await settle();

    expect(res.statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("guest mehendi added on the spot is pushed, pointing at the add-on booking", async () => {
    const customer = await makeCustomer();
    const partner = await makePartner();
    await Service.create({ name: "Mehendi for Guests", price: 150, isActive: true });
    const parent = await makeBooking(customer, {
      partner: partner._id,
      status: "IN_PROGRESS",
      serviceCategory: "mehendi",
    });

    const res = await call(createGuestAddon, {
      partner,
      body: { parentBookingId: String(parent._id), quantity: 3 },
    });

    expect(res.body).toMatchObject({ success: true });
    await eventually(() => expect(mockSend).toHaveBeenCalledTimes(1));
    const message = mockSend.mock.calls[0][0];
    expect(message.token).toBe(customer.fcmToken);
    expect(message.notification.body).toBe("Your artist added 3 guest designs. Tap to approve and pay.");
    // bookingId is the add-on (what the customer approves and pays), not the visit.
    expect(message.data).toEqual({
      type: "GUEST_ADDON_REQUESTED",
      bookingId: res.body.booking.id,
      parentBookingId: String(parent._id),
    });
    expect(res.body.booking.id).not.toBe(String(parent._id));
  });
});
