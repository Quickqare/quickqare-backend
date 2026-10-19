/**
 * Technician ↔ helper link (Oct 2026 review).
 *
 * - A helper whose link is removed/reassigned is taken off upcoming jobs and no
 *   longer sees them (customer address / phone).
 * - Taking a helper off a job tells them.
 * - A new "Technician" claim never grants tier 2; an admin does.
 */
jest.mock("../services/pushNotification.service", () => ({
  notifyPartner: jest.fn(),
  sendPushNotification: jest.fn(),
}));

const Booking = require("../models/Booking");
const Category = require("../models/Category");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");
const TechnicianHelper = require("../models/TechnicianHelper");
const User = require("../models/User");
const { sendPushNotification } = require("../services/pushNotification.service");
const { removeHelperFromUpcomingBookings } = require("../services/technicianHelper.service");
const { listHelperJobs, setBookingHelpers, inviteHelper, respondToInvitation } = require("../controllers/technicianHelper.controller");
const { updatePartnerServices } = require("../controllers/partnerProfile.controller");

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

let category;
let service;
let user;
let tech;
let helper;

beforeEach(async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  sendPushNotification.mockClear();
  category = await Category.create({ name: "AC Repair" });
  service = await Service.create({ name: "Split AC Service", price: 1000, category: category._id, isActive: true, commissionPercent: 20 });
  user = await User.create({ name: "Asha", phone: "9876500101" });
  const base = { password: "Secret123", approvalStatus: "APPROVED", serviceCategories: ["AC Repair"] };
  tech = await Partner.create({ ...base, name: "Ravi", phone: "9876500001", skillTier: 2 });
  helper = await Partner.create({ ...base, name: "Amit", phone: "9876500002", fcmToken: "tok-helper" });
});

afterEach(() => jest.restoreAllMocks());

const makeBooking = (extra = {}) =>
  Booking.create({
    user: user._id,
    services: [{ serviceId: service._id, name: service.name, quantity: 1, price: 1000, lineTotal: 1000 }],
    serviceId: service._id,
    serviceCategory: "AC Repair",
    baseAmount: 1000,
    discountAmount: 0,
    totalAmount: 1180,
    scheduledDate: new Date(),
    scheduledTime: "10:00 AM",
    location: { type: "Point", coordinates: [88.36, 22.57] },
    pincode: "700016",
    address: "12 Park Street",
    payment: { status: "PAID" },
    status: "PARTNER_ACCEPTED",
    partner: tech._id,
    helpers: [{ partnerId: helper._id, name: "Amit", phone: "9876500002" }],
    ...extra,
  });

const link = (status = "ACTIVE") =>
  TechnicianHelper.create({ technician: tech._id, helper: helper._id, status });

describe("helper job visibility", () => {
  test("a linked helper sees the job", async () => {
    await link();
    await makeBooking();
    const res = await call(listHelperJobs, { partner: helper });
    expect(res.body.jobs).toHaveLength(1);
  });

  test("an unlinked helper no longer sees upcoming jobs, but keeps finished ones", async () => {
    await link("REMOVED");
    await makeBooking();
    await makeBooking({ status: "COMPLETED" });
    const res = await call(listHelperJobs, { partner: helper });
    expect(res.body.jobs.map((j) => j.status)).toEqual(["COMPLETED"]);
  });

  test("removing the link takes the helper off upcoming jobs only", async () => {
    const upcoming = await makeBooking();
    const inProgress = await makeBooking({ status: "IN_PROGRESS" });
    await removeHelperFromUpcomingBookings(helper._id);
    expect((await Booking.findById(upcoming._id)).helpers).toHaveLength(0);
    expect((await Booking.findById(inProgress._id)).helpers).toHaveLength(1);
  });
});

describe("taking a helper off a job", () => {
  test("the removed helper is notified", async () => {
    await link();
    const booking = await makeBooking();
    const res = await call(setBookingHelpers, {
      partner: tech,
      body: { bookingId: String(booking._id), helperIds: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(sendPushNotification).toHaveBeenCalledWith(
      "tok-helper",
      "Removed from a Job",
      expect.any(String),
      expect.objectContaining({ type: "HELPER_JOB_REMOVED" })
    );
  });
});

describe("technician tier is admin-granted", () => {
  const body = (tier) => ({ serviceIds: [String(service._id)], serviceAreas: ["700016"], skillTier: tier });

  test("an unapproved partner claiming Technician stays tier 1 with the claim recorded", async () => {
    const fresh = await Partner.create({
      password: "Secret123",
      name: "New",
      phone: "9876500003",
      approvalStatus: "PENDING",
      serviceCategories: ["AC Repair"],
    });
    const res = await call(updatePartnerServices, { partner: fresh, body: body(2) });
    expect(res.statusCode).toBe(200);
    const saved = await Partner.findById(fresh._id);
    expect(saved.skillTier).toBe(1);
    expect(saved.requestedSkillTier).toBe(2);
  });

  test("an admin-granted tier 2 survives re-saving the profile", async () => {
    await call(updatePartnerServices, { partner: tech, body: body(2) });
    expect((await Partner.findById(tech._id)).skillTier).toBe(2);
  });
});

describe("only approved partners can be helpers", () => {
  test("a pending partner cannot be invited", async () => {
    await Partner.updateOne({ _id: helper._id }, { approvalStatus: "PENDING" });
    const res = await call(inviteHelper, { partner: tech, body: { phone: helper.phone } });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/not approved/);
    expect(await TechnicianHelper.countDocuments({})).toBe(0);
  });

  test("an approved partner can be invited", async () => {
    const res = await call(inviteHelper, { partner: tech, body: { phone: helper.phone } });
    expect(res.statusCode).toBe(201);
  });

  test("a partner who was invited then lost approval cannot accept", async () => {
    const invite = await link("PENDING");
    const pending = await Partner.findByIdAndUpdate(helper._id, { approvalStatus: "REJECTED" }, { new: true });
    const res = await call(respondToInvitation, {
      partner: pending,
      body: { invitationId: String(invite._id), action: "ACCEPT" },
    });
    expect(res.statusCode).toBe(403);
    expect((await TechnicianHelper.findById(invite._id)).status).toBe("PENDING");
  });
});
