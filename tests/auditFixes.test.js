/**
 * Security-audit fixes:
 *  - OTP sends are capped per client IP (SMS cost abuse across many numbers),
 *    shared by the customer and partner send routes; every attempt counts.
 *  - Google geocoding: only real 6-digit pincodes reach Google, "no such
 *    pincode" answers are cached, public geo routes share a per-IP daily cap,
 *    and booking create rejects non-numeric pincodes.
 *  - Logout revokes customer/partner tokens server-side (HTTP + socket rooms).
 *  - Partner password change needs a recent sign-in, the current password, or
 *    a phone-OTP proof — a bare (possibly stolen) token is not enough.
 *  - Upload object names use the CSPRNG, not Math.random.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.MSG91_AUTH_KEY = "test-auth-key";
process.env.MSG91_TEMPLATE_ID = "test-template";
process.env.GOOGLE_MAPS_SERVER_API_KEY = "test-maps-key";
// Small caps so the tests can reach them (read when rateLimiter.js loads).
process.env.OTP_SEND_IP_HOURLY_MAX = "3";
process.env.GEO_DAILY_MAX = "3";

jest.mock("../services/pushNotification.service", () => ({
  JOB_ALERTS_CHANNEL: "job_alerts",
  sendPartnerPush: jest.fn().mockResolvedValue(undefined),
  notifyPartner: jest.fn(),
  notifyCustomerOfBookingStatus: jest.fn(),
  sendJobCancelledPush: jest.fn(),
  sendJobAssignedPush: jest.fn(),
  sendJobCompletedPush: jest.fn(),
  sendBookingStatusPush: jest.fn(),
  sendPushNotification: jest.fn(),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const Partner = require("../models/Partner");
const User = require("../models/User");
const RevokedToken = require("../models/RevokedToken");
const { forwardGeocode } = require("../services/geocode.service");
const { issuePhoneProof } = require("../services/msg91Otp.service");
const { userSocketAllowed, partnerSocketAllowed } = require("../socket/handshakeAuth");
const { createBookingValidator } = require("../middlewares/validators");
const validate = require("../middlewares/validate");
const { randomUploadName } = require("../utils/imageExt");
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const BookingTimeline = require("../admin/models/BookingTimeline");
const { startService, cancelBooking } = require("../controllers/booking.controller");

const realFetch = global.fetch;
let server;
let url;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", require("../routes/userOtp.routes"));
  app.use("/api/partner/auth", require("../routes/partnerAuth.routes"));
  app.use("/api/maps", require("../routes/maps.routes"));
  app.post("/validate-booking", createBookingValidator, validate, (_req, res) =>
    res.json({ ok: true })
  );
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  url = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

afterEach(() => {
  global.fetch = realFetch;
});

// Requests to our own test server must use the real fetch even while
// global.fetch is mocked for MSG91 / Google.
const call = (method, path, { body, token, cookie } = {}) =>
  realFetch(`${url}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const mockMsg91Success = () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ type: "success" }),
  });
};

const userToken = (user, extra = {}) =>
  jwt.sign({ id: user._id, role: "user", ...extra }, process.env.JWT_SECRET, { expiresIn: "90d" });

const partnerToken = (partner, { ageSeconds = 0 } = {}) =>
  jwt.sign(
    { id: partner._id, role: "partner", iat: Math.floor(Date.now() / 1000) - ageSeconds },
    process.env.JWT_SECRET,
    { expiresIn: "90d" }
  );

const makePartner = (extra = {}) =>
  Partner.create({ name: "Ravi", phone: "9876500001", password: "Secret123", ...extra });

/* ---------------- #2 OTP SMS cost cap ---------------- */

describe("OTP sends are capped per IP across different numbers", () => {
  test("customer + partner send routes share one per-IP budget", async () => {
    mockMsg91Success();

    // Three successful sends to three DIFFERENT numbers (cap is 3 in this test).
    expect(
      (await call("POST", "/api/auth/send-otp", { body: { phone: "9000000101" } })).status
    ).toBe(200);
    expect(
      (await call("POST", "/api/auth/send-otp", { body: { phone: "9000000102" } })).status
    ).toBe(200);
    expect(
      (
        await call("POST", "/api/partner/auth/send-otp", {
          body: { phone: "9000000103", purpose: "register" },
        })
      ).status
    ).toBe(200);

    // A fourth, fresh number from the same IP is refused — on either app.
    const blocked = await call("POST", "/api/auth/send-otp", { body: { phone: "9000000104" } });
    expect(blocked.status).toBe(429);
    expect(
      (
        await call("POST", "/api/partner/auth/send-otp", {
          body: { phone: "9000000105", purpose: "register" },
        })
      ).status
    ).toBe(429);

    // Exactly three SMS went out.
    const sends = global.fetch.mock.calls.filter(([u]) => String(u).includes("/api/v5/otp?"));
    expect(sends).toHaveLength(3);
  });
});

describe("OTP per-IP cap can't be dodged by hanging up", () => {
  test("requests the client aborts before the response still count", async () => {
    // Slow MSG91 so the client can disconnect while the SMS is being sent.
    global.fetch = jest.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ type: "success" }) }), 150)
        )
    );
    const sendAndHangUp = async (phone) => {
      const controller = new AbortController();
      const pending = realFetch(`${url}/api/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
        signal: controller.signal,
      }).catch(() => null);
      setTimeout(() => controller.abort(), 40);
      await pending;
      await new Promise((r) => setTimeout(r, 200)); // let the server finish
    };

    // The whole suite shares one IP bucket; earlier tests may have used it, so
    // just hang up until the cap must have been reached.
    for (let i = 0; i < 4; i += 1) await sendAndHangUp(`90000002${10 + i}`);

    const after = await call("POST", "/api/auth/send-otp", { body: { phone: "9000000299" } });
    expect(after.status).toBe(429);
  });
});

/* ---------------- #4 Google geocoding cost ---------------- */

describe("forward geocoding only accepts real pincodes", () => {
  test("non-pincode input never reaches Google", async () => {
    global.fetch = jest.fn();
    for (const q of ["abc", "12345", "1234567", "560001 x", "[object Object]", { $gt: "" }]) {
      const r = await forwardGeocode(q, "test");
      expect(r.ok).toBe(false);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("a pincode Google doesn't know is cached, so repeats don't bill again", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ZERO_RESULTS", results: [] }),
    });
    expect((await forwardGeocode("999991", "test")).ok).toBe(false);
    expect((await forwardGeocode("999991", "test")).ok).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("transient Google failures are NOT cached", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await forwardGeocode("999992", "test");
    await forwardGeocode("999992", "test");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("a real pincode still geocodes", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "OK",
        results: [{ geometry: { location: { lat: 12.97, lng: 77.59 } }, address_components: [] }],
      }),
    });
    const r = await forwardGeocode("560001", "test");
    expect(r).toMatchObject({ ok: true, lat: 12.97, lng: 77.59 });
  });
});

describe("public geo routes share a per-IP daily cap", () => {
  test("the cap applies across requests (GEO_DAILY_MAX=3 here)", async () => {
    // Out-of-range coordinates are answered locally (400) but still count:
    // the cap bounds request volume, not just billed lookups.
    for (let i = 0; i < 3; i += 1) {
      expect((await call("GET", "/api/maps/reverse?lat=999&lng=999")).status).toBe(400);
    }
    expect((await call("GET", "/api/maps/reverse?lat=999&lng=999")).status).toBe(429);
    expect((await call("GET", "/api/maps/search?query=abc")).status).toBe(429);
  });
});

describe("booking create rejects non-numeric pincodes", () => {
  test("6 characters that aren't 6 digits fail validation", async () => {
    const body = {
      services: [{ serviceId: "507f1f77bcf86cd799439011", quantity: 1 }],
      scheduledDate: "2030-01-01",
      scheduledTime: "10:00 AM",
      location: { coordinates: [77.59, 12.97] },
      address: "12 MG Road",
      pincode: "56000a",
    };
    const bad = await call("POST", "/validate-booking", { body });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e) => e.field)).toContain("pincode");

    const good = await call("POST", "/validate-booking", { body: { ...body, pincode: "560001" } });
    expect(good.status).toBe(200);
  });
});

/* ---------------- #7a customer logout revokes the token ---------------- */

describe("customer logout ends the session server-side", () => {
  test("Bearer token stops working after logout", async () => {
    const user = await User.create({ name: "Asha", phone: "9876500101" });
    const token = userToken(user);

    expect((await call("GET", "/api/auth/me", { token })).status).toBe(200);
    expect((await call("POST", "/api/auth/logout", { token })).status).toBe(200);

    const after = await call("GET", "/api/auth/me", { token });
    expect(after.status).toBe(401);
    expect(after.body.message).toMatch(/session has ended/i);

    // A fresh login (new token) still works.
    expect((await call("GET", "/api/auth/me", { token: userToken(user, { n: 2 }) })).status).toBe(
      200
    );
  });

  test("web cookie token stops working after logout", async () => {
    const user = await User.create({ name: "Asha", phone: "9876500102" });
    const cookie = `qq_token=${userToken(user)}`;

    expect((await call("GET", "/api/auth/me", { cookie })).status).toBe(200);
    expect((await call("POST", "/api/auth/logout", { cookie })).status).toBe(200);
    expect((await call("GET", "/api/auth/me", { cookie })).status).toBe(401);
  });

  test("revocation rows expire with the token (TTL), and junk tokens aren't stored", async () => {
    const user = await User.create({ name: "Asha", phone: "9876500103" });
    const token = userToken(user);
    const { exp } = jwt.decode(token);

    await call("POST", "/api/auth/logout", { token });
    await call("POST", "/api/auth/logout", { token: "not-a-jwt" });
    await call("POST", "/api/auth/logout", { cookie: "qq_token=%E0%A4%A" }); // malformed cookie

    const rows = await RevokedToken.find().lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].expiresAt.getTime()).toBe(exp * 1000);
    expect(rows[0].tokenHash).not.toContain(token); // only a hash is stored
  });

  test("a deleted account's old token stays dead even if its status is reactivated", async () => {
    const user = await User.create({ name: "Gone", phone: "9876500106", isDeleted: true, status: "ACTIVE" });
    expect((await call("GET", "/api/auth/me", { token: userToken(user) })).status).toBe(401);
  });

  test("socket user room: blocked accounts and signed-out tokens are refused", async () => {
    const user = await User.create({ name: "Asha", phone: "9876500104" });
    const token = userToken(user);
    const socket = { verifiedUserId: String(user._id), authToken: token };

    expect(await userSocketAllowed(socket)).toBe(true);

    await call("POST", "/api/auth/logout", { token });
    expect(await userSocketAllowed(socket)).toBe(false);

    const blocked = await User.create({ name: "B", phone: "9876500105", status: "BLOCKED" });
    expect(
      await userSocketAllowed({
        verifiedUserId: String(blocked._id),
        authToken: userToken(blocked),
      })
    ).toBe(false);
  });
});

/* ---------------- #7b partner password change ---------------- */

describe("partner password change needs proof beyond a bearer token", () => {
  const OLD = 60 * 60; // a token issued an hour ago

  test("old token alone → REAUTH_REQUIRED, password unchanged", async () => {
    const partner = await makePartner();
    const res = await call("POST", "/api/partner/auth/reset-password", {
      token: partnerToken(partner, { ageSeconds: OLD }),
      body: { newPassword: "Hijack999" },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("REAUTH_REQUIRED");

    const fresh = await Partner.findById(partner._id).select("+password");
    expect(await bcrypt.compare("Secret123", fresh.password)).toBe(true);
  });

  test("wrong current password is refused", async () => {
    const partner = await makePartner();
    const res = await call("POST", "/api/partner/auth/reset-password", {
      token: partnerToken(partner, { ageSeconds: OLD }),
      body: { newPassword: "NewPass999", currentPassword: "Wrong123" },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CURRENT_PASSWORD_INVALID");
  });

  test("correct current password works", async () => {
    const partner = await makePartner();
    const res = await call("POST", "/api/partner/auth/reset-password", {
      token: partnerToken(partner, { ageSeconds: OLD }),
      body: { newPassword: "NewPass999", currentPassword: "Secret123" },
    });
    expect(res.status).toBe(200);
    const fresh = await Partner.findById(partner._id).select("+password");
    expect(await bcrypt.compare("NewPass999", fresh.password)).toBe(true);
  });

  test("a recent sign-in (e.g. forgot password → OTP login) needs no extra proof", async () => {
    const partner = await makePartner();
    const res = await call("POST", "/api/partner/auth/reset-password", {
      token: partnerToken(partner, { ageSeconds: 60 }),
      body: { newPassword: "NewPass999" },
    });
    expect(res.status).toBe(200);
  });

  test("a phone-OTP proof works only for the partner's own phone", async () => {
    const partner = await makePartner();
    const token = partnerToken(partner, { ageSeconds: OLD });

    const other = await call("POST", "/api/partner/auth/reset-password", {
      token,
      body: { newPassword: "NewPass999", accessToken: issuePhoneProof("9123456789") },
    });
    expect(other.status).toBe(401);

    const own = await call("POST", "/api/partner/auth/reset-password", {
      token,
      body: { newPassword: "NewPass999", accessToken: issuePhoneProof("9876500001") },
    });
    expect(own.status).toBe(200);
  });

  test("current-password guesses are capped per partner", async () => {
    const partner = await makePartner();
    const token = partnerToken(partner, { ageSeconds: OLD });
    for (let i = 0; i < 5; i += 1) {
      const r = await call("POST", "/api/partner/auth/reset-password", {
        token,
        body: { newPassword: "NewPass999", currentPassword: `Wrong${i}` },
      });
      expect(r.status).toBe(400);
    }
    const capped = await call("POST", "/api/partner/auth/reset-password", {
      token,
      body: { newPassword: "NewPass999", currentPassword: "Secret123" },
    });
    expect(capped.status).toBe(429);
  });
});

describe("partner logout ends the session server-side", () => {
  test("token is refused by partnerAuth and the socket room check after logout", async () => {
    const partner = await makePartner();
    const token = partnerToken(partner);

    expect(
      (await call("PATCH", "/api/partner/auth/status", { token, body: { isOnline: false } })).status
    ).toBe(200);
    expect((await call("POST", "/api/partner/auth/logout", { token })).status).toBe(200);

    const after = await call("PATCH", "/api/partner/auth/status", {
      token,
      body: { isOnline: false },
    });
    expect(after.status).toBe(401);
    expect(
      await partnerSocketAllowed({
        verifiedPartnerId: String(partner._id),
        partnerTokenIssuedAt: Math.floor(Date.now() / 1000),
        authToken: token,
      })
    ).toBe(false);
  });
});

/* ---------------- #8 upload object names ---------------- */

describe("upload object names", () => {
  test("timestamp + 128 random bits, extension from the verified MIME type", () => {
    const a = randomUploadName("image/png");
    const b = randomUploadName("image/png");
    expect(a).toMatch(/^\d{13}_[0-9a-f]{32}\.png$/);
    expect(a).not.toBe(b);
    expect(randomUploadName("image/jpeg")).toMatch(/\.jpg$/);
    expect(randomUploadName("text/html")).toMatch(/\.jpg$/); // never a client-chosen extension
  });
});

/* ---------------- #1 start-code lock cap + #5 customer-fault review ---------------- */

const MINUTE = 60 * 1000;

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

const runHandler = async (handler, req) => {
  const res = mockRes();
  await handler(req, res);
  return res;
};

let partnerSeq = 0;
const makeApprovedPartner = () => {
  partnerSeq += 1;
  return Partner.create({
    name: `P${partnerSeq}`,
    phone: `98781${String(partnerSeq).padStart(5, "0")}`,
    password: "Secret123",
    approvalStatus: "APPROVED",
  });
};

const makeJob = (partner, overrides = {}) => {
  const start = new Date(Date.now() + 30 * MINUTE);
  return Booking.create({
    user: new mongoose.Types.ObjectId(),
    services: [
      {
        serviceId: new mongoose.Types.ObjectId(),
        name: "Facial",
        quantity: 1,
        price: 500,
        lineTotal: 500,
      },
    ],
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
    partner: partner._id,
    status: "ARRIVED",
    serviceStartCode: "4821",
    ...overrides,
  });
};

// alertOps runs fire-and-forget; give its timeline write a moment to land.
const timelineFor = async (bookingId, eventType) => {
  for (let i = 0; i < 20; i += 1) {
    const rows = await BookingTimeline.find({ bookingId, eventType }).lean();
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return [];
};

describe("start-code locks: only the first lifts by itself", () => {
  const start = async (booking, partner, startCode) =>
    runHandler(startService, {
      params: { bookingId: String(booking._id) },
      body: { startCode },
      partner: await Partner.findById(partner._id),
    });

  test("5 wrong codes lock it, count the lock, and alert ops", async () => {
    const partner = await makeApprovedPartner();
    const booking = await makeJob(partner);
    for (const code of ["1111", "2222", "3333", "4444", "5555"]) {
      expect((await start(booking, partner, code)).body.code).toBe("START_CODE_INVALID");
    }
    const fresh = await Booking.findById(booking._id).lean();
    expect(fresh.startCodeLockCount).toBe(1);
    expect(fresh.startCodeLockedAt).toBeInstanceOf(Date);
    expect(await timelineFor(booking._id, "START_CODE_LOCKED")).toHaveLength(1);
  });

  test("a second lock does not lift after 30 minutes — support must reset it", async () => {
    const partner = await makeApprovedPartner();
    const booking = await makeJob(partner, {
      startCodeAttempts: 5,
      startCodeLockedAt: new Date(Date.now() - 31 * MINUTE),
      startCodeLockCount: 2,
    });
    const res = await start(booking, partner, "4821");
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe("START_CODE_LOCKED");
    expect(res.body.message).toMatch(/support/i);
    expect((await Booking.findById(booking._id).lean()).status).toBe("ARRIVED");
  });

  test("the first lock still lifts after 30 minutes", async () => {
    const partner = await makeApprovedPartner();
    const booking = await makeJob(partner, {
      startCodeAttempts: 5,
      startCodeLockedAt: new Date(Date.now() - 31 * MINUTE),
      startCodeLockCount: 1,
    });
    const res = await start(booking, partner, "4821");
    expect(res.body).toMatchObject({ success: true });
  });
});

describe("customer-fault (no refund) closes at the door", () => {
  const cancelAtDoor = async (booking, partner, reason) =>
    runHandler(cancelBooking, {
      params: { bookingId: String(booking._id) },
      body: { reason },
      partner: await Partner.findById(partner._id),
    });

  const waitedAtDoor = () => ({
    status: "ARRIVED",
    arrivedAt: new Date(Date.now() - 20 * MINUTE),
    arrivedLocationVerified: true,
  });

  test("every no-refund close is raised to ops on the booking timeline", async () => {
    const partner = await makeApprovedPartner();
    const booking = await makeJob(partner, waitedAtDoor());
    const res = await cancelAtDoor(booking, partner, "Customer not reachable");
    expect(res.body.success).toBe(true);
    expect((await Booking.findById(booking._id).lean()).refundAmount).toBe(0);

    const rows = await timelineFor(booking._id, "CUSTOMER_FAULT_CLOSED");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      partnerId: String(partner._id),
      totalAmount: 590,
    });
  });

  test("a teammate's or pre-arrival report doesn't turn a partner-fault cancel into a no-refund close", async () => {
    const partner = await makeApprovedPartner();
    const teammate = await makeApprovedPartner();
    const booking = await makeJob(partner, {
      ...waitedAtDoor(),
      partnerReports: [
        // filed by someone else
        {
          partner: teammate._id,
          issueType: "CUSTOMER_NOT_AVAILABLE",
          statusAtReport: "ARRIVED",
          createdAt: new Date(),
        },
        // filed by this partner before they arrived
        {
          partner: partner._id,
          issueType: "CUSTOMER_NOT_AVAILABLE",
          statusAtReport: "ON_THE_WAY",
          createdAt: new Date(Date.now() - 30 * MINUTE),
        },
      ],
    });
    const res = await cancelAtDoor(booking, partner, "Vehicle breakdown");
    // Ordinary partner cancel: a strike for the partner and the job released
    // (here no one else can take it, so the customer is refunded in full).
    expect(res.body).toMatchObject({
      success: true,
      message: "Booking cancelled and reassigned",
      weeklyCancelCount: 1,
    });
    expect(res.body.penalty).toBeUndefined();
    const fresh = await Booking.findById(booking._id).lean();
    expect(fresh.refundAmount).toBe(590);
    expect(
      await BookingTimeline.countDocuments({
        bookingId: booking._id,
        eventType: "CUSTOMER_FAULT_CLOSED",
      })
    ).toBe(0);
  });

  test("this partner's own report at the door still counts", async () => {
    const partner = await makeApprovedPartner();
    const booking = await makeJob(partner, {
      ...waitedAtDoor(),
      partnerReports: [
        {
          partner: partner._id,
          issueType: "CUSTOMER_NOT_AVAILABLE",
          statusAtReport: "ARRIVED",
          createdAt: new Date(),
        },
      ],
    });
    const res = await cancelAtDoor(booking, partner, "Vehicle breakdown");
    expect(res.body.penalty).toBe(100);
    expect((await Booking.findById(booking._id).lean()).refundAmount).toBe(0);
  });
});
