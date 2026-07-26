require("dotenv").config();
const mongoose = require("mongoose");
const SlotCapacity = require("../models/SlotCapacity");
const SlotLock = require("../models/SlotLock");

/*
 * Recomputes SlotCapacity.reservedUnits from live (non-RELEASED) SlotLocks.
 *
 * Why: before the July 2026 reschedule fix, commitSlotReservation incremented
 * reservedUnits and THEN crashed on SlotLock.create with E11000 (bookingId is
 * unique, and a rescheduled booking still owned its old RELEASED lock doc).
 * The create sat outside the rollback path, so every failed "Confirm New Slot"
 * tap permanently leaked units into the target window — slots looked fuller
 * than they were, and repeated taps could 409 a genuinely open window.
 *
 * Invariant restored:
 *   reservedUnits(slotKey) = sum of units of non-RELEASED locks listing that slotKey
 *
 * Only today's and future windows are touched (past windows are inert).
 * Dry-run by default; pass --apply to write.
 *
 * Usage: node scripts/reconcileSlotCapacity.js [MONGO_URI] [--apply]
 */

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

async function run() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const uri = process.env.MONGO_URI || args.find((a) => !a.startsWith("--"));
  if (!uri) {
    console.error("Usage: node scripts/reconcileSlotCapacity.js <MONGO_URI> [--apply]");
    process.exit(1);
  }
  await mongoose.connect(uri);

  // slotKey -> units actually held by live locks
  const held = new Map();
  const liveLocks = await SlotLock.aggregate([
    { $match: { status: { $ne: "RELEASED" } } },
    { $unwind: "$slotKeys" },
    { $group: { _id: "$slotKeys", units: { $sum: "$units" } } },
  ]);
  for (const row of liveLocks) {
    held.set(row._id, row.units);
  }

  const capacities = await SlotCapacity.find({ dateKey: { $gte: todayKey() } }).lean();
  let drift = 0;

  for (const cap of capacities) {
    const expected = held.get(cap.slotKey) || 0;
    if (cap.reservedUnits === expected) continue;
    drift += 1;
    console.log(
      `${cap.slotKey}: reservedUnits ${cap.reservedUnits} -> ${expected}` +
        (apply ? "" : " (dry-run)")
    );
    if (apply) {
      await SlotCapacity.updateOne(
        { _id: cap._id, reservedUnits: cap.reservedUnits },
        { $set: { reservedUnits: expected, updatedAt: new Date() } }
      );
    }
  }

  console.log(
    `Checked ${capacities.length} window(s) from ${todayKey()} onward — ` +
      `${drift} drifted${apply ? ", fixed" : ", dry-run (pass --apply to fix)"}.`
  );
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
