/**
 * Team packer + planner unit tests — pure functions, no DB needed.
 * Covers the real-world fixes:
 *  - visit-window team sizing (event finishes on time, balanced workloads)
 *  - bridal parallelism (2 artists, half duration each)
 *  - AC multi-unit time discount
 *  - technician-tier bins and mixed-team planning
 *  - makespan-based elapsed duration
 */
const {
  packTeamTasks,
  planTeamAssignment,
  partnerFitsBin,
  calculateDurationMinutesFromRequest,
  MEHENDI_VISIT_WINDOW_MINUTES,
  AC_VISIT_WINDOW_MINUTES,
  SALON_VISIT_WINDOW_MINUTES,
} = require("../services/scheduling_service");

// Helpers to build a serviceMap the way loadServiceMap would.
let idCounter = 1;
function svc(props) {
  const id = String(idCounter++).padStart(24, "0");
  return { _id: id, ...props };
}
function mapOf(...services) {
  return new Map(services.map((s) => [String(s._id), s]));
}
function line(service, quantity = 1, extra = {}) {
  return {
    serviceId: String(service._id),
    name: service.name,
    quantity,
    category: extra.category || "mehendi",
    subCategory: extra.subCategory || service.subCategoryName || "",
  };
}

describe("packTeamTasks — mehendi", () => {
  test("guest party is sized by the event window, not one artist's whole day", () => {
    const guests = svc({ name: "Mehendi for Guests", duration: 30, packingRole: "INDEPENDENT" });
    const pack = packTeamTasks([line(guests, 20)], mapOf(guests), { isMehendi: true });

    // 20 × 30 = 600 min. Old model: 2 artists (420 + 180). New model:
    // ceil(600 / 240) = 3 artists, balanced at 200 min each.
    expect(pack.requiredCount).toBe(3);
    for (const bin of pack.bins) {
      expect(bin.minutes).toBeLessThanOrEqual(MEHENDI_VISIT_WINDOW_MINUTES);
    }
    // LPT balance: no lopsided 420-vs-180 split.
    const loads = pack.bins.map((b) => b.minutes).sort((a, b) => a - b);
    expect(loads[loads.length - 1] - loads[0]).toBeLessThanOrEqual(60);
    expect(pack.makespanMinutes).toBeLessThanOrEqual(MEHENDI_VISIT_WINDOW_MINUTES);
  });

  test("bridal books 2 dedicated artists at HALF the catalog duration each", () => {
    const bridal = svc({ name: "Elbow Length Bridal Mehendi", duration: 200, packingRole: "BRIDAL" });
    const pack = packTeamTasks([line(bridal, 1, { subCategory: "Bridal" })], mapOf(bridal), { isMehendi: true });

    expect(pack.requiredCount).toBe(2);
    expect(pack.dedicatedMinutes).toEqual([100, 100]); // 200 / 2 artists
    expect(pack.makespanMinutes).toBe(100); // elapsed, not 200
  });

  test("feet add-on pairs onto a hand task (same guest, one artist)", () => {
    const hand = svc({ name: "Palm Length Mehendi", duration: 90, packingRole: "HAND" });
    const feet = svc({ name: "Basic Feet", duration: 60, packingRole: "FEET_ADDON" });
    const pack = packTeamTasks(
      [line(hand, 1), line(feet, 1)],
      mapOf(hand, feet),
      { isMehendi: true }
    );

    expect(pack.requiredCount).toBe(1);
    expect(pack.taskBins).toEqual([150]); // 90 + 60 combined block
  });

  test("name-based fallback still detects bridal without packingRole", () => {
    const bridal = svc({ name: "Above Elbow Bridal Mehendi", duration: 480 });
    const pack = packTeamTasks([line(bridal, 1)], mapOf(bridal), { isMehendi: true });

    expect(pack.requiredCount).toBe(2);
    expect(pack.dedicatedMinutes).toEqual([240, 240]);
  });
});

describe("packTeamTasks — AC", () => {
  test("2nd+ units of the same line get the multi-unit time discount", () => {
    const deep = svc({ name: "Deep AC service", duration: 75, skillTier: 1 });
    const pack = packTeamTasks([line(deep, 3, { category: "ac" })], mapOf(deep), { isAC: true });

    // 75 + 56 + 56 = 187 min — fits one tech inside the 240-min visit window.
    expect(pack.requiredCount).toBe(1);
    expect(pack.bins[0].minutes).toBe(75 + 56 + 56);
  });

  test("big multi-unit jobs split into balanced technician visits", () => {
    const deep = svc({ name: "Deep AC service", duration: 75, skillTier: 1 });
    const pack = packTeamTasks([line(deep, 5, { category: "ac" })], mapOf(deep), { isAC: true });

    // 75 + 4×56 = 299 min → 1 tech would exceed... no: 299 ≤ 240? No — 299 > 240,
    // so 2 techs with balanced loads (not 240 + 59).
    expect(pack.requiredCount).toBe(2);
    const loads = pack.bins.map((b) => b.minutes).sort((a, b) => a - b);
    expect(loads[1]).toBeLessThanOrEqual(AC_VISIT_WINDOW_MINUTES);
    expect(loads[1] - loads[0]).toBeLessThanOrEqual(75);
  });

  test("technician-tier tasks mark their bin tier 2; cleanings stay tier 1", () => {
    const gas = svc({ name: "Gas refill & check-up", duration: 150, skillTier: 2 });
    const lite = svc({ name: "Lite AC service", duration: 45, skillTier: 1 });
    const pack = packTeamTasks(
      [line(gas, 1, { category: "ac" }), line(lite, 3, { category: "ac" })],
      mapOf(gas, lite),
      { isAC: true }
    );

    // 150 + 45 + 34 + 34 = 263 > 240 → 2 partners; the gas bin needs tier 2,
    // and at least one bin stays tier-1 so a serviceman can take it.
    expect(pack.requiredCount).toBe(2);
    expect(pack.bins.some((b) => b.tier === 2)).toBe(true);
    expect(pack.bins.some((b) => b.tier === 1)).toBe(true);
  });
});

describe("planTeamAssignment — mixed teams", () => {
  const entry = (id, { skillTier = 1, canBridal = true, canGuest = true } = {}) => ({
    partner: { _id: id, skillTier },
    canBridal,
    canGuest,
    score: 50,
  });

  test("technician bin goes to the technician, cleaning bin to the serviceman", () => {
    const teamPack = {
      bins: [
        { minutes: 184, tier: 2, kind: "GUEST" },
        { minutes: 79, tier: 1, kind: "GUEST" },
      ],
      requiredCount: 2,
    };
    // Serviceman ranks HIGHER but must not take the tier-2 bin.
    const ranked = [entry("serviceman", { skillTier: 1 }), entry("tech", { skillTier: 2 })];
    const plan = planTeamAssignment(ranked, teamPack);

    expect(plan).not.toBeNull();
    expect(plan[0].bin.tier).toBe(2);
    expect(plan[0].entry.partner._id).toBe("tech");
    expect(plan[1].entry.partner._id).toBe("serviceman");
  });

  test("bridal bins require bridal-capable artists; guest artists fill the rest", () => {
    const teamPack = {
      bins: [
        { minutes: 100, tier: 1, kind: "BRIDAL" },
        { minutes: 100, tier: 1, kind: "BRIDAL" },
        { minutes: 200, tier: 1, kind: "GUEST" },
      ],
      requiredCount: 3,
    };
    const ranked = [
      entry("guestOnly", { canBridal: false }),
      entry("bridal1"),
      entry("bridal2"),
    ];
    const plan = planTeamAssignment(ranked, teamPack);

    expect(plan).not.toBeNull();
    const bridalPartners = plan.filter((p) => p.bin.kind === "BRIDAL").map((p) => p.entry.partner._id);
    expect(bridalPartners.sort()).toEqual(["bridal1", "bridal2"]);
    expect(plan.find((p) => p.bin.kind === "GUEST").entry.partner._id).toBe("guestOnly");
  });

  test("returns null when headcount is met but a ROLE cannot be filled", () => {
    const teamPack = {
      bins: [
        { minutes: 100, tier: 1, kind: "BRIDAL" },
        { minutes: 100, tier: 1, kind: "GUEST" },
      ],
      requiredCount: 2,
    };
    const ranked = [entry("g1", { canBridal: false }), entry("g2", { canBridal: false })];
    expect(planTeamAssignment(ranked, teamPack)).toBeNull();
  });

  test("empty-bins pack (plumbing) plans a single partner", () => {
    const plan = planTeamAssignment([entry("solo")], { bins: [], requiredCount: 1 });
    expect(plan).toHaveLength(1);
    expect(plan[0].entry.partner._id).toBe("solo");
  });

  test("partnerFitsBin blocks under-tier partners from tier-2 bins only", () => {
    const tech = entry("t", { skillTier: 2 });
    const serviceman = entry("s", { skillTier: 1 });
    const tier2Bin = { minutes: 150, tier: 2, kind: "GUEST" };
    const tier1Bin = { minutes: 45, tier: 1, kind: "GUEST" };
    expect(partnerFitsBin(tech, tier2Bin)).toBe(true);
    expect(partnerFitsBin(serviceman, tier2Bin)).toBe(false);
    expect(partnerFitsBin(serviceman, tier1Bin)).toBe(true);
  });
});

describe("calculateDurationMinutesFromRequest — elapsed makespan", () => {
  test("bridal elapsed time reflects the 2 parallel artists", () => {
    const bridal = svc({ name: "Elbow Length Bridal Mehendi", duration: 200, packingRole: "BRIDAL" });
    const minutes = calculateDurationMinutesFromRequest(
      [line(bridal, 1)],
      mapOf(bridal),
      false
    );
    expect(minutes).toBe(100); // not 200 — two artists work in parallel
  });

  test("guest party elapsed time is the balanced per-artist share", () => {
    const guests = svc({ name: "Mehendi for Guests", duration: 30, packingRole: "INDEPENDENT" });
    const minutes = calculateDurationMinutesFromRequest(
      [line(guests, 20)],
      mapOf(guests),
      false
    );
    // 20 atomic 30-min tasks over 3 artists split 7/7/6 → longest share 210.
    expect(minutes).toBe(210);
  });

  test("non-team categories keep the summed duration", () => {
    const plumbing = svc({ name: "Plumbing", duration: 60 });
    const minutes = calculateDurationMinutesFromRequest(
      [line(plumbing, 2, { category: "plumbing" })],
      mapOf(plumbing),
      false
    );
    expect(minutes).toBe(120);
  });

  test("a long single-partner cart blocks its full length — no 240-min cap", () => {
    // One plumber does all of it: 120 + 60 + 60 + 60 + 35 = 335 min. The
    // old cap blocked 240 and left the last 95 min double-bookable. (A salon
    // cart this long now splits across beauticians — see the salon suite.)
    const plumbing = { category: "plumbing" };
    const cart = [
      svc({ name: "Bathroom fitting", duration: 120 }),
      svc({ name: "Tap replacement", duration: 60 }),
      svc({ name: "Flush repair", duration: 60 }),
      svc({ name: "Drain cleaning", duration: 60 }),
      svc({ name: "Leak check", duration: 35 }),
    ];
    const minutes = calculateDurationMinutesFromRequest(
      cart.map((s) => line(s, 1, plumbing)),
      mapOf(...cart),
      false
    );
    expect(minutes).toBe(335);
  });

  test("short jobs still block at least one hour", () => {
    const threading = svc({ name: "Eyebrow threading", duration: 10 });
    const minutes = calculateDurationMinutesFromRequest(
      [line(threading, 1, { category: "salon-for-women" })],
      mapOf(threading),
      false
    );
    expect(minutes).toBe(60);
  });

  test("an AC makespan is not truncated either", () => {
    const install = svc({ name: "Central AC installation", duration: 400, skillTier: 2 });
    const minutes = calculateDurationMinutesFromRequest(
      [line(install, 1, { category: "ac" })],
      mapOf(install),
      true
    );
    expect(minutes).toBe(400); // the old 360 ceiling under-blocked by 40 min
  });
});

describe("packTeamTasks — salon / self-care", () => {
  const salonLine = (service, quantity = 1) =>
    line(service, quantity, { category: "Salon for Women" });
  const junior = { partner: { _id: "jr", skillTier: 1 }, canBridal: true, canGuest: true };
  const senior = { partner: { _id: "sr", skillTier: 2 }, canBridal: true, canGuest: true };

  // 120 + 60 + 60 + 60 + 35 = 335 min — more than one beautician's visit.
  function longCart() {
    return [
      svc({ name: "Full body waxing", duration: 120 }),
      svc({ name: "Deluxe pedicure", duration: 60 }),
      svc({ name: "Instant glow facial", duration: 60 }),
      svc({ name: "Hair spa", duration: 60 }),
      svc({ name: "Deluxe manicure", duration: 35 }),
    ];
  }

  test("a cart inside the visit window is ONE beautician, summed duration", () => {
    const facial = svc({ name: "Hydration facial", duration: 60 });
    const threading = svc({ name: "Eyebrow threading", duration: 15 });
    const pack = packTeamTasks(
      [salonLine(facial), salonLine(threading)],
      mapOf(facial, threading),
      { isSalon: true }
    );
    expect(pack.requiredCount).toBe(1);
    expect(pack.bins).toEqual([{ minutes: 75, tier: 1, kind: "GUEST" }]);
    expect(pack.makespanMinutes).toBe(75);
  });

  test("a cart longer than the visit window splits across beauticians", () => {
    const cart = longCart();
    const pack = packTeamTasks(cart.map((s) => salonLine(s)), mapOf(...cart), { isSalon: true });
    expect(pack.requiredCount).toBe(2);
    for (const bin of pack.bins) {
      expect(bin.minutes).toBeLessThanOrEqual(SALON_VISIT_WINDOW_MINUTES);
    }
    expect(pack.bins.reduce((sum, b) => sum + b.minutes, 0)).toBe(335);
    expect(pack.makespanMinutes).toBe(180);
  });

  test("elapsed duration of a long salon cart is the parallel makespan", () => {
    const cart = longCart();
    const minutes = calculateDurationMinutesFromRequest(
      cart.map((s) => salonLine(s)),
      mapOf(...cart),
      false
    );
    expect(minutes).toBe(180); // was 335 with one beautician
  });

  test("categoryType SALON is detected even when the name gives no hint", () => {
    const glowCat = { name: "Glow Studio", slug: "glow-studio", categoryType: "SALON" };
    const cart = longCart().map((s) => ({ ...s, category: glowCat }));
    const minutes = calculateDurationMinutesFromRequest(
      cart.map((s) => line(s, 1, { category: "" })),
      mapOf(...cart),
      false
    );
    expect(minutes).toBe(180);
  });

  test("a tier-2 service makes its bin senior-only", () => {
    const korean = svc({ name: "Korean glass-skin facial", duration: 90, skillTier: 2 });
    const pack = packTeamTasks([salonLine(korean)], mapOf(korean), { isSalon: true });
    expect(pack.bins).toEqual([{ minutes: 90, tier: 2, kind: "GUEST" }]);
    expect(planTeamAssignment([junior], pack)).toBeNull();
    expect(planTeamAssignment([junior, senior], pack)[0].entry.partner._id).toBe("sr");
  });

  test("mixed tiers in a split cart: only the tier-2 share needs a senior", () => {
    const korean = svc({ name: "Korean glass-skin facial", duration: 90, skillTier: 2 });
    const wax = svc({ name: "Full body waxing", duration: 120 });
    const pedi = svc({ name: "Deluxe pedicure", duration: 60 });
    const pack = packTeamTasks(
      [salonLine(korean), salonLine(wax), salonLine(pedi)],
      mapOf(korean, wax, pedi),
      { isSalon: true }
    );
    expect(pack.requiredCount).toBe(2);
    expect(pack.bins.filter((b) => b.tier === 2)).toHaveLength(1);

    // Junior ranked first still can't take the senior share.
    const plan = planTeamAssignment([junior, senior], pack);
    expect(plan).toHaveLength(2);
    expect(plan.find((p) => p.bin.tier === 2).entry.partner._id).toBe("sr");
  });

  test("AC and mehendi keep their own packers even if isSalon is passed", () => {
    const guests = svc({ name: "Mehendi for Guests", duration: 30, packingRole: "INDEPENDENT" });
    const pack = packTeamTasks([line(guests, 20)], mapOf(guests), { isMehendi: true, isSalon: true });
    expect(pack.requiredCount).toBe(3); // mehendi sizing, unchanged
  });
});
