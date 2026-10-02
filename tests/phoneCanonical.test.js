/**
 * One real phone = one rate-limit bucket = one account.
 *
 * MSG91 always normalised numbers, but the per-phone limiters and the account
 * lookups used the raw request string — so "9876543210", "+91 98765 43210" and
 * "98765-43210" were one phone to MSG91 yet separate OTP budgets (SMS bombing,
 * stretched OTP brute force) and separate accounts (e.g. a blocked customer
 * signing straight back in). These tests pin all three to the canonical number.
 */
process.env.JWT_SECRET = "test-secret";
process.env.MSG91_AUTH_KEY = "test-auth-key";
process.env.MSG91_TEMPLATE_ID = "test-template";

const express = require("express");

const User = require("../models/User");
const Partner = require("../models/Partner");
const { toNationalPhone, toInternationalPhone } = require("../utils/phone");
const { phoneOtpLimiter, phoneOtpVerifyLimiter } = require("../middlewares/rateLimiter");
const { issuePhoneProof } = require("../services/msg91Otp.service");
const { verifyOtp, exchangeMsg91AccessToken } = require("../controllers/userOtp.controller");
const {
  registerPartner,
  loginPartner,
  exchangePartnerMsg91AccessToken,
} = require("../controllers/partnerAuth.controller");

// The same real number, the way different callers might type it.
const VARIANTS = ["9876543210", "+91 98765 43210", "919876543210", "98765-43210", "098765 43210"];

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
    cookie() {
      return this;
    },
  };
}

async function call(handler, body) {
  const res = mockRes();
  await handler({ body }, res);
  return res;
}

describe("toNationalPhone", () => {
  test("reduces every formatting of a number to the same 10 digits", () => {
    for (const variant of VARIANTS) {
      expect(toNationalPhone(variant)).toBe("9876543210");
    }
    expect(toNationalPhone("0091 98765 43210")).toBe("9876543210");
    // A national number that merely starts with the country code is kept whole.
    expect(toNationalPhone("9123456789")).toBe("9123456789");
    expect(toInternationalPhone("+91 98765 43210")).toBe("919876543210");
  });

  test("rejects anything that isn't exactly one 10-digit number", () => {
    for (const bad of ["", "12345", "98765432101", "91987654321", "abc", null, undefined]) {
      expect(toNationalPhone(bad)).toBe("");
    }
    // Non-strings that would stringify into a valid-looking number.
    expect(toNationalPhone(["9876543210"])).toBe("");
    expect(toNationalPhone({ phone: "9876543210" })).toBe("");
  });
});

describe("per-phone rate limiters", () => {
  let server;
  let url;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.post("/send", phoneOtpLimiter, (_req, res) => res.json({ ok: true }));
    // A wrong OTP (400) is what counts toward the verify limiter.
    app.post("/verify", phoneOtpVerifyLimiter, (_req, res) => res.status(400).json({ ok: false }));
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    url = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const post = (path, body) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.status);

  test("OTP sends: every formatting of one number shares the 60s bucket", async () => {
    expect(await post("/send", { phone: "9876543210" })).toBe(200);
    for (const variant of VARIANTS.slice(1)) {
      expect(await post("/send", { phone: variant })).toBe(429);
    }
    // A different real number has its own bucket.
    expect(await post("/send", { phone: "9123456789" })).toBe(200);
  });

  test("OTP verify: reformatting can't stretch the 5-guess budget", async () => {
    const formats = [
      "9000000001",
      "+919000000001",
      "90000-00001",
      "+91 90000 00001",
      "09000000001",
    ];
    for (const phone of formats) {
      expect(await post("/verify", { phone, otp: "000000" })).toBe(400);
    }
    expect(await post("/verify", { phone: "(900) 000-0001", otp: "000000" })).toBe(429);
  });

  test("a missing phone falls back to a real per-IP bucket", async () => {
    // Used to key on the request object itself — unique per request, so never limited.
    expect(await post("/send", {})).toBe(200);
    expect(await post("/send", {})).toBe(429);
  });
});

describe("customer accounts are keyed on the canonical number", () => {
  test("verify-otp: every formatting logs into the same account, and MSG91 checks one number", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: "success", message: "OTP verified success" }),
    });

    const ids = new Set();
    for (const variant of VARIANTS) {
      const res = await call(verifyOtp, { phone: variant, otp: "123456" });
      expect(res.statusCode).toBe(200);
      ids.add(String(res.body.user._id));
    }

    expect(ids.size).toBe(1);
    expect(await User.countDocuments()).toBe(1);
    expect((await User.findOne()).phone).toBe("9876543210");
    for (const [msg91Url] of global.fetch.mock.calls) {
      expect(msg91Url).toContain("mobile=919876543210");
    }
  });

  test("msg91/exchange: a blocked customer can't reformat their way into a fresh account", async () => {
    const proof = issuePhoneProof("9876543210");
    const first = await call(exchangeMsg91AccessToken, { phone: "9876543210", accessToken: proof });
    expect(first.statusCode).toBe(200);
    expect(first.body.isNewUser).toBe(true);

    await User.updateOne({ _id: first.body.user._id }, { $set: { status: "BLOCKED" } });

    for (const variant of VARIANTS.slice(1)) {
      const res = await call(exchangeMsg91AccessToken, { phone: variant, accessToken: proof });
      expect(res.statusCode).toBe(200);
      expect(res.body.isNewUser).toBe(false);
      // Same (blocked) account — userAuth rejects its token on every request.
      expect(String(res.body.user._id)).toBe(String(first.body.user._id));
    }
    expect(await User.countDocuments()).toBe(1);
  });

  test("an unparseable phone is rejected before any lookup", async () => {
    const proof = issuePhoneProof("9876543210");
    for (const phone of ["12345", ["9876543210"]]) {
      const res = await call(exchangeMsg91AccessToken, { phone, accessToken: proof });
      expect(res.statusCode).toBe(400);
    }
    expect(await User.countDocuments()).toBe(0);
  });
});

describe("partner accounts are keyed on the canonical number", () => {
  let partner;

  beforeEach(async () => {
    partner = await Partner.create({ name: "Asha", phone: "9876543210", password: "Secret123" });
  });

  test("register: a reformatted number is recognised as the existing partner", async () => {
    const res = await call(registerPartner, {
      name: "Someone Else",
      phone: "+91 98765 43210",
      password: "Secret123",
      accessToken: issuePhoneProof("9876543210"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe("Partner already exists");
    expect(await Partner.countDocuments()).toBe(1);
  });

  test("password login and OTP exchange find the partner under any formatting", async () => {
    const login = await call(loginPartner, { phone: "98765-43210", password: "Secret123" });
    expect(login.statusCode).toBe(200);
    expect(String(login.body.partner._id)).toBe(String(partner._id));

    const exchange = await call(exchangePartnerMsg91AccessToken, {
      phone: "919876543210",
      accessToken: issuePhoneProof("9876543210"),
    });
    expect(exchange.statusCode).toBe(200);
    expect(String(exchange.body.partner._id)).toBe(String(partner._id));
  });
});
