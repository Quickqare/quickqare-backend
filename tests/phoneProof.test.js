/**
 * Proof-of-phone token issued after a template-API OTP verifies. It has to bind
 * to the phone that was verified, or the exchange/register/reset endpoints that
 * accept it would be an account-takeover path.
 */
process.env.JWT_SECRET = "test-secret";

const jwt = require("jsonwebtoken");
const {
  issuePhoneProof,
  verifyAccessToken,
  phoneMatchesVerified,
} = require("../services/msg91Otp.service");

describe("phone proof", () => {
  test("verifies without calling MSG91 and yields the verified phone", async () => {
    const result = await verifyAccessToken(issuePhoneProof("9876543210"));
    expect(result.verifiedPhones).toEqual(["919876543210"]);
    expect(phoneMatchesVerified(result.verifiedPhones, "9876543210")).toBe(true);
  });

  test("does not match a different phone", async () => {
    const result = await verifyAccessToken(issuePhoneProof("9876543210"));
    expect(phoneMatchesVerified(result.verifiedPhones, "9123456789")).toBe(false);
  });

  test("a token with the wrong purpose is not accepted as proof", async () => {
    const forged = jwt.sign({ phone: "919876543210" }, "test-secret");
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ type: "error", message: "invalid" }),
    });
    process.env.MSG91_AUTH_KEY = "k";
    await expect(verifyAccessToken(forged)).rejects.toThrow();
  });

  test("an expired proof is rejected", async () => {
    const expired = jwt.sign(
      { purpose: "phone-otp-verified", phone: "919876543210" },
      "test-secret",
      { expiresIn: -10 }
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ type: "error", message: "invalid" }),
    });
    process.env.MSG91_AUTH_KEY = "k";
    await expect(verifyAccessToken(expired)).rejects.toThrow();
  });
});
