/**
 * MSG91 phone binding — the gate that stops account takeover on
 * POST /api/auth/msg91/exchange.
 *
 * The access token only proves that *some* phone completed an OTP. If the issued
 * session isn't bound to the phone being claimed, an attacker can OTP their own
 * number and exchange that perfectly valid token for a session on a victim's
 * number. The binding works by recovering the phone MSG91 actually verified out
 * of the token / response, so these tests pin the extraction against the shapes
 * MSG91 is known to use — including a bare phone in `message`, which is how MSG91
 * returns unnamed payloads elsewhere in this integration.
 */
const jwt = require("jsonwebtoken");

const {
  extractVerifiedPhones,
  phoneMatchesVerified,
} = require("../services/msg91Otp.service");

// The token is only decoded for its claims here (MSG91's API is what actually
// verifies it), so the signing secret is irrelevant.
const tokenWith = (payload) => jwt.sign(payload, "irrelevant");

describe("extractVerifiedPhones", () => {
  test("recovers the phone from the access token's `identifier` claim", () => {
    const token = tokenWith({ identifier: "919876543210" });
    expect(extractVerifiedPhones(token, {})).toContain("919876543210");
  });

  test("recovers a bare phone returned in the response `message`", () => {
    const phones = extractVerifiedPhones("not.a.jwt", {
      type: "success",
      message: "919876543210",
    });
    expect(phones).toContain("919876543210");
  });

  test("recovers a phone from a named field in the response", () => {
    const phones = extractVerifiedPhones("not.a.jwt", {
      data: { mobile: "+91 98765 43210" },
    });
    expect(phones).toContain("919876543210");
  });

  test("ignores numeric JWT claims like exp/iat that look phone-shaped", () => {
    // exp/iat are 10-digit unix timestamps — treating them as phones would make
    // every legitimate login look like a mismatch.
    const token = tokenWith({ identifier: "919876543210", exp: 1893456000, iat: 1735689600 });
    const phones = extractVerifiedPhones(token, {});
    expect(phones).toEqual(["919876543210"]);
  });

  test("ignores a human-readable `message` that merely contains digits", () => {
    const phones = extractVerifiedPhones("not.a.jwt", {
      message: "OTP verified successfully in 2 attempts",
    });
    expect(phones).toEqual([]);
  });

  test("returns nothing when MSG91 echoes no phone at all", () => {
    // This is the fail-closed trigger: strict mode rejects the exchange here.
    expect(extractVerifiedPhones("not.a.jwt", { type: "success" })).toEqual([]);
  });
});

describe("phoneMatchesVerified", () => {
  const verified = ["919876543210"];

  test("matches the same number regardless of country-code formatting", () => {
    expect(phoneMatchesVerified(verified, "9876543210")).toBe(true);
    expect(phoneMatchesVerified(verified, "919876543210")).toBe(true);
    expect(phoneMatchesVerified(verified, "+91 98765 43210")).toBe(true);
  });

  test("rejects a different number — the account-takeover attempt", () => {
    // Attacker verified their own 919876543210 but claims the victim's number.
    expect(phoneMatchesVerified(verified, "9123456789")).toBe(false);
  });

  test("rejects when nothing could be verified", () => {
    expect(phoneMatchesVerified([], "9876543210")).toBe(false);
  });
});
