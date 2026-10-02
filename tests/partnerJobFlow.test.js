/**
 * Partner app job flow: what the partner sees on job cards and how the
 * lifecycle endpoints behave for team jobs.
 *
 * - Job cards show what the job pays THIS partner after commission (the app
 *   labels it "Earnings"), never the customer's total.
 * - A team member who finished their own part sees the job as COMPLETED.
 * - on-the-way / arrived / start are idempotent once the booking is already
 *   at or past that step (a teammate got there first, or a retry).
 * - A customer cancellation reaches the partner as "job_cancelled", the event
 *   the partner app listens for.
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

const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const User = require("../models/User");
const Service = require("../models/service.model");
const Category = require("../models/Category");
const { getPartnerBookings } = require("../controllers/partner.controller");
const {
  markOnTheWay,
  markArrived,
  startService,
  completeBooking,
  cancelBookingByUser,
} = require("../controllers/booking.controller");

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

let user;
let service;
let tech;
let helper;

beforeEach(async () => {
  const category = await Category.create({ name: "AC Repair" });
  service = await Service.create({ name: "Split AC Service", price: 1000, category: category._id, isActive: true, commissionPercent: 20 });
  user = await User.create({ name: "Asha", phone: "9876500101" });
  const base = { password: "Secret123", approvalStatus: "APPROVED", serviceCategories: ["AC Repair"] };
  tech = await Partner.create({ ...base, name: "Ravi", phone: "9876500001", skillTier: 2 });
  helper = await Partner.create({ ...base, name: "Amit", phone: "9876500002" });
});

const makeBooking = (extra = {}) =>
  Booking.create({
    user: user._id,
    services: [{ serviceId: service._id, name: service.name, quantity: 1, price: 1000, lineTotal: 1000 }],
    serviceId: service._id,
    serviceCategory: "AC Repair",
    baseAmount: 1000,
    discountAmount: 0,
    totalAmount: 1180, // incl. 18% GST
    scheduledDate: new Date(),
    scheduledTime: "10:00 AM",
    location: { type: "Point", coordinates: [88.36, 22.57] },
    pincode: "700016",
    address: "12 Park Street",
    payment: { status: "PAID" },
    serviceStartCode: "4821",
    ...extra,
  });

const teamBooking = () =>
  makeBooking({
    status: "CONFIRMED",
    partner: tech._id,
    additionalPartners: [helper._id],
    teamAllocations: [
      { partnerId: tech._id, payoutRatio: 0.6, isPrimary: true },
      { partnerId: helper._id, payoutRatio: 0.4, isPrimary: false },
    ],
  });

const jobsFor = async (partner) => (await call(getPartnerBookings, { partner, query: {} })).body.bookings;
const asPartner = (partner, bookingId, body = {}) => ({ partner, params: { bookingId: String(bookingId) }, body });

test("job cards show the partner's earning after commission, not the customer's total", async () => {
  await makeBooking({ status: "ASSIGNED", partner: tech._id });
  const [job] = await jobsFor(tech);
  expect(job.amount).toBe(800); // ₹1000 base − 20% commission (customer paid ₹1180 incl. GST)
  expect(job.price).toBe(800);
});

test("a partner's own commission rate applies when the service has none", async () => {
  await Service.updateOne({ _id: service._id }, { $unset: { commissionPercent: 1 } });
  await Partner.updateOne({ _id: tech._id }, { $set: { commissionPercent: 10 } });
  await makeBooking({ status: "ASSIGNED", partner: tech._id });
  const [job] = await jobsFor(tech);
  expect(job.amount).toBe(900);
});

test("team members each see their own share", async () => {
  await teamBooking();
  expect((await jobsFor(tech))[0].amount).toBe(480);
  expect((await jobsFor(helper))[0].amount).toBe(320);
});

test("team flow: steps are idempotent for the second partner and a finished member sees COMPLETED", async () => {
  const booking = await teamBooking();

  expect((await call(markOnTheWay, asPartner(tech, booking._id))).statusCode).toBe(200);
  const helperOnTheWay = await call(markOnTheWay, asPartner(helper, booking._id));
  expect(helperOnTheWay.statusCode).toBe(200);
  expect(helperOnTheWay.body.status).toBe("ON_THE_WAY");

  expect((await call(markArrived, asPartner(tech, booking._id))).statusCode).toBe(200);
  expect((await call(markArrived, asPartner(helper, booking._id))).statusCode).toBe(200);

  expect((await call(startService, asPartner(tech, booking._id, { startCode: "4821" }))).statusCode).toBe(200);
  const helperStart = await call(startService, asPartner(helper, booking._id));
  expect(helperStart.statusCode).toBe(200);
  expect(helperStart.body.status).toBe("IN_PROGRESS");

  expect((await call(completeBooking, asPartner(tech, booking._id))).statusCode).toBe(200);
  expect((await jobsFor(tech))[0].status).toBe("COMPLETED");
  expect((await jobsFor(tech))[0].amount).toBe(480); // the credited amount
  expect((await jobsFor(helper))[0].status).toBe("IN_PROGRESS");

  expect((await call(completeBooking, asPartner(helper, booking._id))).statusCode).toBe(200);
  expect((await jobsFor(helper))[0].status).toBe("COMPLETED");
});

test("the customer's phone is shown during a job and withheld once it's finished", async () => {
  const active = await makeBooking({ status: "PARTNER_ACCEPTED", partner: tech._id });
  const completed = await makeBooking({ status: "COMPLETED", partner: tech._id });
  const cancelled = await makeBooking({ status: "CANCELLED", partner: tech._id });

  const byId = new Map((await jobsFor(tech)).map((j) => [j.bookingId, j]));
  expect(byId.get(String(active._id)).customerPhone).toBe("9876500101");
  expect(byId.get(String(completed._id)).customerPhone).toBe("");
  expect(byId.get(String(cancelled._id)).customerPhone).toBe("");
  // The rest of the job record stays for the partner's history.
  expect(byId.get(String(completed._id)).customerName).toBe("Asha");
});

test("on a team job the phone is withheld only from the member who has finished", async () => {
  const booking = await teamBooking();
  await call(markOnTheWay, asPartner(tech, booking._id));
  await call(markArrived, asPartner(tech, booking._id));
  await call(startService, asPartner(tech, booking._id, { startCode: "4821" }));
  await call(completeBooking, asPartner(tech, booking._id));

  expect((await jobsFor(tech))[0].customerPhone).toBe("");
  expect((await jobsFor(helper))[0].customerPhone).toBe("9876500101");
});

test("starting a job that hasn't started still needs the customer's code", async () => {
  const booking = await makeBooking({ status: "ARRIVED", partner: tech._id });
  const noCode = await call(startService, asPartner(tech, booking._id));
  expect(noCode.statusCode).toBe(400);
  expect((await Booking.findById(booking._id)).status).toBe("ARRIVED");
});

test("a customer cancellation reaches the partner as job_cancelled", async () => {
  const emitted = [];
  global.io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
  try {
    const booking = await makeBooking({ status: "CONFIRMED", partner: tech._id });
    const res = await call(cancelBookingByUser, {
      user: { _id: user._id },
      params: { bookingId: String(booking._id) },
      body: { reason: "Change of plans" },
    });
    expect(res.statusCode).toBe(200);
    const toPartner = emitted.filter((e) => e.room === `partner_${tech._id}`);
    expect(toPartner.map((e) => e.event)).toContain("job_cancelled");
    expect(toPartner.map((e) => e.event)).not.toContain("booking_cancelled");
  } finally {
    delete global.io;
  }
});
