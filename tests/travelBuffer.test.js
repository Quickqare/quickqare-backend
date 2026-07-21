/**
 * Distance-scaled transit buffer tests — pure functions, no DB needed.
 * Buffers come from the two BOOKING addresses, never partner live GPS, and
 * any missing/unusable coordinate falls back to the flat legacy buffer so
 * degraded data is always at least as conservative as the old behaviour.
 */
const {
  travelBufferMinutesForDistance,
  isWindowAvailable,
  DEFAULT_TRAVEL_BUFFER_MINUTES,
  AC_TRAVEL_BUFFER_MINUTES,
} = require("../services/scheduling_service");

const at = (h, m = 0) => new Date(2026, 6, 25, h, m, 0, 0);
const loc = (lng, lat) => ({ type: "Point", coordinates: [lng, lat] });

// ~1 km apart around Bengaluru (0.009° latitude ≈ 1 km).
const A = loc(77.59, 12.97);
const B_1KM = loc(77.59, 12.979);
// ~8 km apart.
const B_8KM = loc(77.59, 13.042);

describe("travelBufferMinutesForDistance", () => {
  test("scales with distance: nearby jobs need far less than the flat 30", () => {
    expect(travelBufferMinutesForDistance(500, false)).toBe(12); // 10 + 2
    expect(travelBufferMinutesForDistance(500, true)).toBe(17);  // 15 + 2
  });

  test("far jobs can exceed the old flat buffer, capped at 60", () => {
    expect(travelBufferMinutesForDistance(8000, false)).toBe(34);  // 10 + 24
    expect(travelBufferMinutesForDistance(20000, false)).toBe(60); // capped
  });

  test("unknown distance falls back to the flat legacy buffer", () => {
    expect(travelBufferMinutesForDistance(Infinity, false)).toBe(DEFAULT_TRAVEL_BUFFER_MINUTES);
    expect(travelBufferMinutesForDistance(Infinity, true)).toBe(AC_TRAVEL_BUFFER_MINUTES);
    expect(travelBufferMinutesForDistance(NaN, false)).toBe(DEFAULT_TRAVEL_BUFFER_MINUTES);
  });
});

describe("isWindowAvailable — pairwise transit gaps", () => {
  test("back-to-back jobs 1 km apart fit with a small gap", () => {
    // Existing job ends 11:00; candidate starts 11:15, ~1 km away.
    // Needed gap ≈ 10 + 4 = 14 min → 15-min gap is enough.
    const existing = [{ startAt: at(10), endAt: at(11), location: A, isAC: false }];
    const candidate = { startAt: at(11, 15), endAt: at(12, 15), location: B_1KM, isAC: false };
    expect(isWindowAvailable(candidate, existing)).toBe(true);
  });

  test("the same 15-min gap is NOT enough when the jobs are 8 km apart", () => {
    // Needed gap ≈ 10 + 25 = 35 min.
    const existing = [{ startAt: at(10), endAt: at(11), location: A, isAC: false }];
    const candidate = { startAt: at(11, 15), endAt: at(12, 15), location: B_8KM, isAC: false };
    expect(isWindowAvailable(candidate, existing)).toBe(false);
  });

  test("missing location on either booking enforces the FLAT buffer (no shortcut)", () => {
    // 15-min gap, no location data → flat 30-min buffer applies → blocked.
    const existing = [{ startAt: at(10), endAt: at(11), location: null, isAC: false }];
    const candidate = { startAt: at(11, 15), endAt: at(12, 15), location: B_1KM, isAC: false };
    expect(isWindowAvailable(candidate, existing)).toBe(false);

    // A [0,0] default coordinate counts as unknown too.
    const zeroLoc = [{ startAt: at(10), endAt: at(11), location: loc(0, 0), isAC: false }];
    expect(isWindowAvailable(candidate, zeroLoc)).toBe(false);
  });

  test("AC on either side uses the AC profile for the trip", () => {
    // ~1 km apart, 16-min gap. General profile needs 14 → ok; AC needs 19 → blocked.
    const existingAC = [{ startAt: at(10), endAt: at(11), location: A, isAC: true }];
    const candidate = { startAt: at(11, 16), endAt: at(12), location: B_1KM, isAC: false };
    expect(isWindowAvailable(candidate, existingAC)).toBe(false);

    const existingGeneral = [{ startAt: at(10), endAt: at(11), location: A, isAC: false }];
    expect(isWindowAvailable(candidate, existingGeneral)).toBe(true);
  });

  test("gap applies in both directions (candidate before the existing job too)", () => {
    const existing = [{ startAt: at(14), endAt: at(15), location: A, isAC: false }];
    const tooClose = { startAt: at(12, 30), endAt: at(13, 50), location: B_8KM, isAC: false };
    expect(isWindowAvailable(tooClose, existing)).toBe(false);

    const farEnough = { startAt: at(12), endAt: at(13, 20), location: B_8KM, isAC: false };
    expect(isWindowAvailable(farEnough, existing)).toBe(true);
  });

  test("directly overlapping windows are always blocked", () => {
    const existing = [{ startAt: at(10), endAt: at(12), location: A, isAC: false }];
    const candidate = { startAt: at(11), endAt: at(13), location: A, isAC: false };
    expect(isWindowAvailable(candidate, existing)).toBe(false);
  });
});
