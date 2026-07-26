/**
 * REGRESSION: "Confirm New Slot" during rescheduling must not E11000.
 *
 * SlotLock.bookingId is UNIQUE — one lock doc per booking, ever. The reschedule
 * flow releases the old lock (the doc STAYS, status RELEASED) and then reserves
 * the new window. commitSlotReservation used to SlotLock.create() a second doc
 * for the same booking, which threw E11000 straight to the customer, and —
 * because the create sat outside the capacity rollback — every failed tap also
 * leaked the just-incremented reservedUnits into the new window.
 *
 * The lock write is now an upsert that revives the booking's existing doc.
 */
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const SlotCapacity = require("../models/SlotCapacity");
const SlotLock = require("../models/SlotLock");
const {
  buildSlotKey,
  commitSlotReservation,
  markSlotLockPaid,
  releaseSlotCapacityByBookingId,
} = require("../services/slotCapacity.service");

const PINCODE = "700001";

async function makeBooking() {
  return Booking.create({
    user: new mongoose.Types.ObjectId(),
    baseAmount: 500,
    totalAmount: 500,
    scheduledDate: new Date("2026-07-23T00:00:00.000Z"),
    scheduledTime: "14:00",
    location: { type: "Point", coordinates: [88.3639, 22.5726] },
    pincode: PINCODE,
  });
}

// prepareSlotReservation upserts the SlotCapacity row before commit runs, so
// the commit's guarded findOneAndUpdate expects it to exist — seed it here.
async function seedWindow(dateKey, time, { totalUnits = 2, reservedUnits = 0 } = {}) {
  const slotKey = buildSlotKey(PINCODE, dateKey, time);
  await SlotCapacity.create({ slotKey, pincode: PINCODE, dateKey, time, totalUnits, reservedUnits });
  return slotKey;
}

// Mirrors the `prepared` shape prepareSlotReservation returns, scoped to the
// fields commitSlotReservation actually reads.
function preparedFor(dateKey, time, slotKey, { eligibleUnits = 2, requiredCount = 1 } = {}) {
  return {
    startAt: new Date(`${dateKey}T${time}:00`),
    requiredCount,
    snapshots: [{ slotKey, dateKey, time, eligibleUnits, capacity: { totalUnits: eligibleUnits } }],
  };
}

async function reserved(slotKey) {
  const cap = await SlotCapacity.findOne({ slotKey }).lean();
  return cap ? cap.reservedUnits : null;
}

describe("reschedule slot re-lock (E11000 regression)", () => {
  test("a booking whose lock was RELEASED can reserve a new window", async () => {
    const booking = await makeBooking();
    const oldKey = await seedWindow("2026-07-23", "14:00");
    const newKey = await seedWindow("2026-07-24", "10:00");

    // Original booking: reserve + pay (same as createBooking → paymentFinalize).
    const first = await commitSlotReservation(booking, preparedFor("2026-07-23", "14:00", oldKey));
    await markSlotLockPaid(booking._id);
    expect(await reserved(oldKey)).toBe(1);

    // Reschedule step 1: free the old window. The lock doc survives as RELEASED.
    const { released } = await releaseSlotCapacityByBookingId(booking._id, {
      releaseReason: "rescheduled",
    });
    expect(released).toBe(true);
    expect(await reserved(oldKey)).toBe(0);

    // Reschedule step 2: reserve the new window. This used to throw
    // E11000 duplicate key on bookingId_1 — the customer-facing failure.
    const second = await commitSlotReservation(booking, preparedFor("2026-07-24", "10:00", newKey));

    // The same doc is revived, not a second one created.
    expect(await SlotLock.countDocuments({ bookingId: booking._id })).toBe(1);
    expect(String(second.lock._id)).toBe(String(first.lock._id));
    expect(second.lock.status).toBe("PENDING_PAYMENT");
    expect(second.lock.slotKeys).toEqual([newKey]);
    expect(second.lock.releasedAt).toBeNull();
    expect(second.lock.releaseReason).toBe("");
    expect(await reserved(newKey)).toBe(1);
    expect(await reserved(oldKey)).toBe(0);

    // And the cycle keeps working: reschedule the reschedule.
    await markSlotLockPaid(booking._id);
    await releaseSlotCapacityByBookingId(booking._id, { releaseReason: "rescheduled" });
    const thirdKey = await seedWindow("2026-07-25", "16:00");
    await commitSlotReservation(booking, preparedFor("2026-07-25", "16:00", thirdKey));
    expect(await SlotLock.countDocuments({ bookingId: booking._id })).toBe(1);
    expect(await reserved(newKey)).toBe(0);
    expect(await reserved(thirdKey)).toBe(1);
  });

  test("sessionless multi-window 409 rolls back already-reserved units", async () => {
    const booking = await makeBooking();
    const okKey = await seedWindow("2026-07-24", "10:00");
    // Second window already full → commit must 409 mid-loop.
    const fullKey = await seedWindow("2026-07-24", "11:00", { totalUnits: 1, reservedUnits: 1 });

    const prepared = {
      startAt: new Date("2026-07-24T10:00:00"),
      requiredCount: 1,
      snapshots: [
        { slotKey: okKey, dateKey: "2026-07-24", time: "10:00", eligibleUnits: 2, capacity: { totalUnits: 2 } },
        { slotKey: fullKey, dateKey: "2026-07-24", time: "11:00", eligibleUnits: 1, capacity: { totalUnits: 1 } },
      ],
    };

    await expect(commitSlotReservation(booking, prepared)).rejects.toMatchObject({
      statusCode: 409,
    });

    // The first window's increment was undone — no leaked units, no lock doc.
    expect(await reserved(okKey)).toBe(0);
    expect(await SlotLock.countDocuments({ bookingId: booking._id })).toBe(0);
  });
});
