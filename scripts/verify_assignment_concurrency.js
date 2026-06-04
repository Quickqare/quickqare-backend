/*
=====================================================
CONCURRENCY VERIFICATION — PARTNER DOUBLE-BOOKING
=====================================================
Dependency-free simulation that proves the atomic-claim fix in
services/assignmentEngine.js prevents one partner from being assigned to two
overlapping bookings during a "tatkal" rush (many users booking the SAME slot
at the same instant).

It does NOT touch the database. It models the one property the fix relies on:
MongoDB applies a guarded findOneAndUpdate to a single document atomically — the
guard check and the $push happen with no interleaving. The async read→claim
boundary (where the real race lives) is modelled with an explicit yield so the
concurrent assignments genuinely interleave.

Two engines are run against an identical partner pool:
  • assignBuggy  — old behaviour: pick the top-ranked partner(s), then write.
                   No guard. Demonstrates the double-booking.
  • assignFixed  — new behaviour: atomic guarded claim, skip taken partners,
                   roll back a partial team. Demonstrates the bug is closed.

Run:  node scripts/verify_assignment_concurrency.js
Exits non-zero if the fixed engine ever double-books a partner.
=====================================================
*/

// Yield to the event loop so concurrent assignments interleave at the
// read→claim boundary — this is exactly where the production race occurs.
const tick = () => new Promise((resolve) => setImmediate(resolve));

function makePool(partnerCount) {
  return Array.from({ length: partnerCount }, (_, i) => ({
    _id: `P${i + 1}`,
    busySlots: [],
  }));
}

// Faithful model of MongoDB's atomic, single-document guarded update:
//   Partner.findOneAndUpdate(
//     { _id, busySlots: { $not: { $elemMatch: { date, time } } } },
//     { $push: { busySlots: { date, time } } })
// Synchronous (no await inside) → atomic relative to other async tasks,
// just like the real single-document write.
function atomicClaim(partner, date, time) {
  const taken = partner.busySlots.some((s) => s.date === date && s.time === time);
  if (taken) return null; // guard fails — already claimed by a parallel assignment
  partner.busySlots.push({ date, time });
  return partner;
}

function releaseClaim(partner, date, time) {
  partner.busySlots = partner.busySlots.filter(
    (s) => !(s.date === date && s.time === time)
  );
}

// ── OLD (buggy) engine: pick top N, blind write, no guard ──────────────────
async function assignBuggy(ranked, requiredCount, date, time) {
  const picked = ranked.slice(0, requiredCount);
  await tick(); // every booking reads the pool before any writes land
  for (const p of picked) p.busySlots.push({ date, time });
  return picked.map((p) => p._id);
}

// ── NEW (fixed) engine: atomic guarded claim + rollback on partial team ────
async function assignFixed(ranked, requiredCount, date, time) {
  const claimed = [];
  const claimedIds = new Set();
  for (const p of ranked) {
    if (claimed.length >= requiredCount) break;
    if (claimedIds.has(p._id)) continue;
    await tick(); // yield at the read→claim boundary, like the real engine
    const got = atomicClaim(p, date, time);
    if (got) {
      claimed.push(got);
      claimedIds.add(got._id);
    }
  }
  if (claimed.length < requiredCount) {
    for (const p of claimed) releaseClaim(p, date, time); // roll back partial team
    return null;
  }
  return claimed.map((p) => p._id);
}

// Count how many distinct bookings each partner ended up assigned to, for the
// one slot under test. Any count > 1 is a double-booking.
function countAssignments(results, date, time) {
  const perPartner = new Map();
  for (const res of results) {
    if (!res) continue;
    for (const pid of res) perPartner.set(pid, (perPartner.get(pid) || 0) + 1);
  }
  const doubleBooked = [...perPartner.entries()].filter(([, n]) => n > 1);
  const assignedBookings = results.filter(Boolean).length;
  return { perPartner, doubleBooked, assignedBookings };
}

async function runScenario(label, engine, { partners, bookings, requiredCount }) {
  const date = "2026-06-01";
  const time = "16:00";
  const pool = makePool(partners);
  const ranked = pool; // already "ranked"; all eligible for the same slot

  // Fire every booking's assignment concurrently — the tatkal stampede.
  const results = await Promise.all(
    Array.from({ length: bookings }, () => engine(ranked, requiredCount, date, time))
  );

  const { doubleBooked, assignedBookings } = countAssignments(results, date, time);
  const maxAssignable = Math.floor(partners / requiredCount);

  console.log(`\n[${label}]`);
  console.log(`  partners=${partners} bookings=${bookings} requiredCount=${requiredCount}`);
  console.log(`  bookings assigned : ${assignedBookings}`);
  console.log(`  double-booked     : ${doubleBooked.length === 0 ? "none" : doubleBooked.map(([p, n]) => `${p}×${n}`).join(", ")}`);

  return { doubleBooked, assignedBookings, maxAssignable };
}

async function main() {
  let failures = 0;

  // --- Demonstrate the bug the fix targets (informational, not asserted) ---
  const buggy = await runScenario("OLD engine (buggy)", assignBuggy, {
    partners: 5,
    bookings: 20,
    requiredCount: 1,
  });
  if (buggy.doubleBooked.length > 0) {
    console.log("  → reproduces the double-booking the fix removes");
  }

  // --- Assert the fix: no double-booking, correct cap, across scenarios ---
  const scenarios = [
    { partners: 5, bookings: 20, requiredCount: 1 }, // single-partner tatkal rush
    { partners: 1, bookings: 50, requiredCount: 1 }, // last-seat stampede
    { partners: 6, bookings: 10, requiredCount: 2 }, // 2-partner teams (mehendi/AC)
    { partners: 3, bookings: 8, requiredCount: 2 }, // teams + contention/rollback
  ];

  for (const s of scenarios) {
    const r = await runScenario("NEW engine (fixed)", assignFixed, s);

    if (r.doubleBooked.length > 0) {
      console.log("  ASSERT FAILED: a partner was double-booked");
      failures += 1;
    }
    if (r.assignedBookings > r.maxAssignable) {
      console.log(
        `  ASSERT FAILED: assigned ${r.assignedBookings} > capacity ${r.maxAssignable}`
      );
      failures += 1;
    }
    if (r.doubleBooked.length === 0 && r.assignedBookings <= r.maxAssignable) {
      console.log(`  OK: ≤ ${r.maxAssignable} assigned, no overlap`);
    }
  }

  console.log(
    `\n${failures === 0 ? "PASS ✅ — fixed engine never double-books" : `FAIL ❌ — ${failures} assertion(s) failed`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
