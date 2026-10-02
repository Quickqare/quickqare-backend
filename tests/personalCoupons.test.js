/**
 * Personal coupons (referral rewards) belong to one customer.
 *
 * They used to be unassigned single-use codes: the public
 * GET /api/coupons/available feed listed every one of them, and whoever
 * redeemed a code first got the discount. Now a coupon with `assignedTo` is
 * listed only to its owner and redeemable only by its owner.
 */
process.env.JWT_SECRET = "test-secret";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Coupon = require("../models/coupon");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Referral = require("../models/Referral");
const ReferralSettings = require("../models/ReferralSettings");
const { listApplicableCoupons, validateCouponForAmount } = require("../services/coupon.service");
const { processReferralReward } = require("../utils/referral");
const userAuth = require("../middlewares/userAuth");

const inAMonth = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const tokenFor = (user) => jwt.sign({ id: user._id, role: "user" }, "test-secret");

let owner;
let stranger;

beforeEach(async () => {
  owner = await User.create({ phone: "9000000001", name: "Owner" });
  stranger = await User.create({ phone: "9000000002", name: "Stranger" });
  await Coupon.create([
    { code: "WELCOME50", discountType: "flat", discountValue: 50, expiresAt: inAMonth() },
    {
      code: "REF1727000000ABCDEF",
      discountType: "flat",
      discountValue: 100,
      usageLimit: 1,
      expiresAt: inAMonth(),
      assignedTo: owner._id,
    },
  ]);
});

const codes = (list) => list.map((c) => c.code).sort();

describe("listApplicableCoupons", () => {
  test("anonymous callers see only general codes", async () => {
    expect(codes(await listApplicableCoupons({ amount: 500 }))).toEqual(["WELCOME50"]);
  });

  test("the owner also sees their personal coupon; nobody else does", async () => {
    expect(codes(await listApplicableCoupons({ amount: 500, customerId: owner._id }))).toEqual([
      "REF1727000000ABCDEF",
      "WELCOME50",
    ]);
    expect(codes(await listApplicableCoupons({ amount: 500, customerId: stranger._id }))).toEqual([
      "WELCOME50",
    ]);
  });
});

describe("validateCouponForAmount", () => {
  test("only the owner can redeem a personal coupon", async () => {
    const result = await validateCouponForAmount({
      code: "REF1727000000ABCDEF",
      amount: 500,
      customerId: owner._id,
    });
    expect(result.discount).toBe(100);

    for (const customerId of [stranger._id, null]) {
      await expect(
        validateCouponForAmount({ code: "REF1727000000ABCDEF", amount: 500, customerId })
      ).rejects.toThrow("Invalid coupon");
    }
  });

  test("general codes still work for everyone", async () => {
    const result = await validateCouponForAmount({
      code: "WELCOME50",
      amount: 500,
      customerId: stranger._id,
    });
    expect(result.discount).toBe(50);
  });
});

describe("GET /api/coupons/available", () => {
  let server;
  let url;

  beforeAll(async () => {
    const app = express();
    app.use("/api/coupons", require("../routes/coupon.routes"));
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    url = `http://127.0.0.1:${server.address().port}/api/coupons/available?amount=500`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const fetchCodes = async (headers = {}) => {
    const res = await fetch(url, { headers });
    const body = await res.json();
    return { codes: codes(body.coupons), cacheControl: res.headers.get("cache-control") };
  };

  test("the public feed never lists someone's referral reward", async () => {
    const anonymous = await fetchCodes();
    expect(anonymous.codes).toEqual(["WELCOME50"]);
    expect(anonymous.cacheControl).toBe("private, no-store");

    const asStranger = await fetchCodes({ Authorization: `Bearer ${tokenFor(stranger)}` });
    expect(asStranger.codes).toEqual(["WELCOME50"]);
  });

  test("the owner sees it via the app's Bearer token or the web cookie", async () => {
    const viaBearer = await fetchCodes({ Authorization: `Bearer ${tokenFor(owner)}` });
    expect(viaBearer.codes).toContain("REF1727000000ABCDEF");

    const viaCookie = await fetchCodes({ Cookie: `qq_token=${tokenFor(owner)}` });
    expect(viaCookie.codes).toContain("REF1727000000ABCDEF");
  });

  test("a bad token or a blocked account just means anonymous", async () => {
    expect((await fetchCodes({ Authorization: "Bearer not-a-jwt" })).codes).toEqual(["WELCOME50"]);

    await User.updateOne({ _id: owner._id }, { $set: { status: "BLOCKED" } });
    const blocked = await fetchCodes({ Authorization: `Bearer ${tokenFor(owner)}` });
    expect(blocked.codes).toEqual(["WELCOME50"]);
  });
});

describe("userAuth (strict) is unchanged by the optional variant", () => {
  const run = async (headers) => {
    const req = { headers };
    const res = {
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
    const next = jest.fn();
    await userAuth(req, res, next);
    return { req, res, next };
  };

  test("rejects missing, invalid and blocked; admits a valid customer", async () => {
    const missing = await run({});
    expect(missing.res.statusCode).toBe(401);
    expect(missing.res.body.message).toBe("Authorization token required");

    const invalid = await run({ authorization: "Bearer not-a-jwt" });
    expect(invalid.res.statusCode).toBe(401);
    expect(invalid.res.body.message).toBe("Invalid or expired token");

    const valid = await run({ authorization: `Bearer ${tokenFor(owner)}` });
    expect(valid.next).toHaveBeenCalled();
    expect(String(valid.req.user._id)).toBe(String(owner._id));

    await User.updateOne({ _id: owner._id }, { $set: { status: "BLOCKED" } });
    const blocked = await run({ authorization: `Bearer ${tokenFor(owner)}` });
    expect(blocked.res.statusCode).toBe(403);
    expect(blocked.next).not.toHaveBeenCalled();
  });
});

describe("processReferralReward", () => {
  test("issues the new customer's reward coupon to that customer only", async () => {
    await ReferralSettings.create({});
    const referrer = await User.create({ phone: "9000000003", name: "Referrer" });
    const referral = await Referral.create({ referrerId: referrer._id, referredId: owner._id });
    const booking = await Booking.create({
      user: owner._id,
      baseAmount: 500,
      totalAmount: 500,
      scheduledDate: new Date("2026-07-01T00:00:00.000Z"),
      scheduledTime: "10:00 AM",
      location: { type: "Point", coordinates: [77.59, 12.97] },
      pincode: "560001",
      status: "COMPLETED",
    });

    await processReferralReward(owner._id, booking._id);

    const { couponId } = await Referral.findById(referral._id).lean();
    expect(couponId).toBeInstanceOf(mongoose.Types.ObjectId);
    const coupon = await Coupon.findById(couponId).lean();
    expect(String(coupon.assignedTo)).toBe(String(owner._id));

    // The referrer can see this code in their referral history, but can't use it.
    await expect(
      validateCouponForAmount({ code: coupon.code, amount: 500, customerId: referrer._id })
    ).rejects.toThrow("Invalid coupon");
  });
});
