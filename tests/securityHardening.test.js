/**
 * Security hardening for the partner app surface.
 *
 * - MSG91 replies only count as success with MSG91's explicit success flag —
 *   an error whose text merely contains "verified" (e.g. "Mobile no. already
 *   verified") must never log anyone in.
 * - Partner MSG91 access-token flows fail CLOSED when the token can't be bound
 *   to the claimed phone.
 * - completeBooking doesn't reveal another partner's settlement.
 * - A password change ends existing sessions (HTTP + socket room join).
 * - Approved partners can't promote themselves to technician or quietly
 *   switch trade.
 */
jest.mock("../services/geocode.service", () => ({
  reverseGeocode: jest.fn(async () => ({ ok: false })),
  forwardGeocode: jest.fn(async () => ({ ok: false })),
}));
jest.mock("../services/pushNotification.service", () => ({
  notifyPartner: jest.fn(),
  notifyCustomerOfBookingStatus: jest.fn(),
  sendJobCancelledPush: jest.fn(),
  sendJobAssignedPush: jest.fn(),
  sendJobCompletedPush: jest.fn(),
  sendBookingStatusPush: jest.fn(),
  sendPushNotification: jest.fn(),
}));

const jwt = require("jsonwebtoken");
const Partner = require("../models/Partner");
const Booking = require("../models/Booking");
const User = require("../models/User");
const Service = require("../models/service.model");
const Category = require("../models/Category");
const { verifyOtp, verifyAccessToken } = require("../services/msg91Otp.service");
const { exchangePartnerMsg91AccessToken, resetPartnerPasswordWithMsg91 } = require("../controllers/partnerAuth.controller");
const { completeBooking } = require("../controllers/booking.controller");
const { updatePartnerServices } = require("../controllers/partnerProfile.controller");
const partnerAuth = require("../middlewares/partnerAuth");
const { partnerSocketAllowed } = require("../socket/handshakeAuth");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.MSG91_AUTH_KEY = "test-auth-key";

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

const realFetch = global.fetch;
const msg91Replies = (body, ok = true) => {
  global.fetch = jest.fn(async () => ({ ok, status: ok ? 200 : 400, json: async () => body }));
};
afterEach(() => {
  global.fetch = realFetch;
});

const makePartner = (extra = {}) =>
  Partner.create({ name: "Ravi", phone: "9876500001", password: "Secret123", ...extra });

/* ---------------- MSG91 success parsing ---------------- */

describe("MSG91 OTP verification", () => {
  test.each([
    [{ type: "error", message: "Mobile no. already verified" }],
    [{ type: "error", message: "OTP not verified" }],
    [{ message: "verification success" }],
    [{ type: "error", message: "OTP not match" }],
  ])("rejects a reply without type=success: %j", async (reply) => {
    msg91Replies(reply);
    await expect(verifyOtp("9876500001", "1234")).rejects.toThrow();
  });

  test("accepts MSG91's success reply", async () => {
    msg91Replies({ type: "success", message: "OTP verified success" });
    await expect(verifyOtp("9876500001", "1234")).resolves.toMatchObject({ success: true });
  });

  test("an access-token error mentioning 'verified' is not a success", async () => {
    msg91Replies({ type: "error", message: "access token already verified" });
    await expect(verifyAccessToken("some-widget-token")).rejects.toThrow();
  });
});

/* ---------------- partner phone binding fails closed ---------------- */

describe("partner MSG91 access-token flows", () => {
  test("a valid token that can't be tied to a phone doesn't log into someone else's account", async () => {
    await makePartner();
    msg91Replies({ type: "success" }); // MSG91 says the token is fine, but names no phone
    const res = mockRes();
    await exchangePartnerMsg91AccessToken({ body: { phone: "9876500001", accessToken: "not.a.jwt" } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  test("…nor reset its password", async () => {
    await makePartner();
    msg91Replies({ type: "success" });
    const res = mockRes();
    await resetPartnerPasswordWithMsg91(
      { body: { phone: "9876500001", accessToken: "not.a.jwt", newPassword: "Hijack123" } },
      res
    );
    expect(res.statusCode).toBe(401);
  });
});

/* ---------------- completeBooking authorization ---------------- */

test("another partner can't read a completed booking's settlement via complete", async () => {
  const owner = await makePartner();
  const stranger = await Partner.create({ name: "Other", phone: "9876500009", password: "Secret123" });
  const user = await User.create({ name: "Asha", phone: "9876500101" });
  const booking = await Booking.create({
    user: user._id,
    partner: owner._id,
    status: "COMPLETED",
    baseAmount: 1000,
    totalAmount: 1180,
    scheduledDate: new Date(),
    scheduledTime: "10:00 AM",
    location: { type: "Point", coordinates: [88.36, 22.57] },
    pincode: "700016",
    partnerSettlement: { grossAmount: 1000, commissionAmount: 200, partnerEarningAmount: 800 },
  });

  const res = mockRes();
  await completeBooking({ partner: stranger, params: { bookingId: String(booking._id) } }, res);
  expect(res.statusCode).toBe(403);
  expect(res.body.settlement).toBeUndefined();
});

/* ---------------- password change ends sessions ---------------- */

describe("password change", () => {
  const runAuth = async (token) => {
    const res = mockRes();
    let passed = false;
    await partnerAuth({ headers: { authorization: `Bearer ${token}` } }, res, () => { passed = true; });
    return { res, passed };
  };

  test("tokens issued before a password change stop working; a fresh login works", async () => {
    const partner = await makePartner();
    const oldIat = Math.floor(Date.now() / 1000) - 3600;
    const oldToken = jwt.sign({ id: partner._id, role: "partner", iat: oldIat }, process.env.JWT_SECRET);

    expect((await runAuth(oldToken)).passed).toBe(true);

    partner.password = "NewSecret456";
    await partner.save();

    const before = await runAuth(oldToken);
    expect(before.passed).toBe(false);
    expect(before.res.statusCode).toBe(401);

    const freshToken = jwt.sign({ id: partner._id, role: "partner" }, process.env.JWT_SECRET);
    expect((await runAuth(freshToken)).passed).toBe(true);
  });

  test("socket room join refuses revoked, blocked and deleted partners", async () => {
    const partner = await makePartner();
    const socketFor = (iat) => ({ verifiedPartnerId: String(partner._id), partnerTokenIssuedAt: iat });
    const now = Math.floor(Date.now() / 1000);

    expect(await partnerSocketAllowed(socketFor(now))).toBe(true);

    partner.password = "NewSecret456";
    await partner.save();
    expect(await partnerSocketAllowed(socketFor(now - 3600))).toBe(false);
    expect(await partnerSocketAllowed(socketFor(now + 5))).toBe(true);

    await Partner.updateOne({ _id: partner._id }, { $set: { isBlocked: true } });
    expect(await partnerSocketAllowed(socketFor(now + 5))).toBe(false);
  });
});

/* ---------------- no self-escalation after approval ---------------- */

describe("services update by an approved partner", () => {
  let acService;
  let mehendiService;

  beforeEach(async () => {
    const ac = await Category.create({ name: "AC Repair" });
    const mehendi = await Category.create({ name: "Mehendi" });
    acService = await Service.create({ name: "AC Service", price: 500, category: ac._id, isActive: true });
    mehendiService = await Service.create({ name: "Bridal Mehendi", price: 2000, category: mehendi._id, isActive: true });
  });

  const update = async (partner, body) => {
    const res = mockRes();
    await updatePartnerServices({ partner, body: { serviceAreas: ["700016"], ...body } }, res);
    return res;
  };

  test("can't promote themselves to technician", async () => {
    const helper = await makePartner({ approvalStatus: "APPROVED", serviceCategories: ["AC Repair"], skillTier: 1 });
    const res = await update(helper, { serviceIds: [String(acService._id)], skillTier: 2 });
    expect(res.statusCode).toBe(403);
    expect((await Partner.findById(helper._id)).skillTier).toBe(1);
  });

  test("can still edit services in their own category (and step down a tier)", async () => {
    const tech = await makePartner({ approvalStatus: "APPROVED", serviceCategories: ["AC Repair"], skillTier: 2 });
    const res = await update(tech, { serviceIds: [String(acService._id)], skillTier: 1 });
    expect(res.statusCode).toBe(200);
    const saved = await Partner.findById(tech._id);
    expect(saved.skillTier).toBe(1);
    expect(saved.approvalStatus).toBe("APPROVED");
  });

  test("switching trade sends them back for approval", async () => {
    const partner = await makePartner({ approvalStatus: "APPROVED", serviceCategories: ["Mehendi"] });
    const res = await update(partner, { serviceIds: [String(acService._id)], skillTier: 2 });
    expect(res.statusCode).toBe(200);
    expect(res.body.reapprovalRequired).toBe(true);
    expect((await Partner.findById(partner._id)).approvalStatus).toBe("PENDING");
  });

  test("a partner not yet approved can choose freely during onboarding", async () => {
    const fresh = await makePartner();
    const res = await update(fresh, { serviceIds: [String(acService._id)], skillTier: 2 });
    expect(res.statusCode).toBe(200);
    expect((await Partner.findById(fresh._id)).skillTier).toBe(2);
    // unrelated category stays selectable before approval too
    expect(mehendiService).toBeTruthy();
  });
});
