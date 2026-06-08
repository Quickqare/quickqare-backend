/**
 * The geocode service must NEVER throw on a Google outage/timeout — it must
 * return a graceful { ok: false } so callers (e.g. the partner location
 * heartbeat) can still save GPS coordinates while Google is unavailable.
 */
process.env.GOOGLE_MAPS_SERVER_API_KEY = "test_key";

const { reverseGeocode } = require("../services/geocode.service");

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

describe("reverseGeocode failure handling", () => {
  test("returns ok:false (not a throw) when the network call errors", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ENOTFOUND"));

    const result = await reverseGeocode(12.001, 77.001, "test");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("GOOGLE_REQUEST_ERROR");
  });

  test("returns a timeout error when the request is aborted", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    global.fetch = jest.fn().mockRejectedValue(abortErr);

    const result = await reverseGeocode(12.002, 77.002, "test");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("GOOGLE_REQUEST_TIMEOUT");
  });

  test("returns ok:false when Google responds with a non-OK HTTP status", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false });

    const result = await reverseGeocode(12.003, 77.003, "test");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("GOOGLE_REQUEST_FAILED");
  });

  test("returns ok:false when the response body cannot be parsed", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("bad json")),
    });

    const result = await reverseGeocode(12.004, 77.004, "test");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("GOOGLE_BAD_RESPONSE");
  });

  test("returns ok:true with a pincode on a healthy response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "OK",
          results: [
            {
              formatted_address: "MG Road, Bengaluru, 560001",
              address_components: [
                { types: ["postal_code"], long_name: "560001" },
              ],
            },
          ],
        }),
    });

    const result = await reverseGeocode(12.005, 77.005, "test");

    expect(result.ok).toBe(true);
    expect(result.pincode).toBe("560001");
  });
});
