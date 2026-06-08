/**
 * CRITICAL PATH: a single partner must never be claimed for the same time slot
 * by two bookings at once.
 *
 * This exercises the exact production mechanism from assignmentEngine.js — a
 * guarded `$push` with an `$elemMatch` guard. MongoDB serialises writes to one
 * document, so when many claims race for the same slot, only the first should
 * win and the rest must see the slot already taken.
 */
const mongoose = require("mongoose");
const Partner = require("../models/Partner");

// Mirrors the claim in assignmentEngine.js: atomically take the slot only if
// the partner is not already busy at that date+time.
async function claimSlot(partnerId, date, time) {
  return Partner.findOneAndUpdate(
    {
      _id: partnerId,
      busySlots: { $not: { $elemMatch: { date, time } } },
    },
    { $push: { busySlots: { date, time } } },
    { new: true }
  );
}

async function makePartner() {
  const partner = await Partner.create({
    name: "Test Partner",
    phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    password: "hashed-irrelevant-for-this-test",
  });
  return partner;
}

describe("Partner slot claiming (double-booking prevention)", () => {
  test("only ONE of many concurrent claims for the same slot succeeds", async () => {
    const partner = await makePartner();
    const date = new Date("2026-07-01T00:00:00.000Z");
    const time = "10:00 AM";

    // Fire 10 claims for the identical slot at the same time.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimSlot(partner._id, date, time))
    );

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);

    // The partner document must hold exactly one copy of the slot — no
    // duplicate pushes slipped through.
    const fresh = await Partner.findById(partner._id);
    const matching = fresh.busySlots.filter(
      (s) => s.time === time && s.date.getTime() === date.getTime()
    );
    expect(matching).toHaveLength(1);
  });

  test("the same partner CAN be claimed for two different time slots", async () => {
    const partner = await makePartner();
    const date = new Date("2026-07-01T00:00:00.000Z");

    const a = await claimSlot(partner._id, date, "10:00 AM");
    const b = await claimSlot(partner._id, date, "02:00 PM");

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const fresh = await Partner.findById(partner._id);
    expect(fresh.busySlots).toHaveLength(2);
  });

  test("a second claim for an already-taken slot returns null", async () => {
    const partner = await makePartner();
    const date = new Date("2026-07-01T00:00:00.000Z");
    const time = "11:00 AM";

    const first = await claimSlot(partner._id, date, time);
    const second = await claimSlot(partner._id, date, time);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
