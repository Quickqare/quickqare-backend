require("dotenv").config();
const mongoose = require("mongoose");
const Service = require("../models/service.model");

/*
 * Flips existing cake services from the SINCE_BOOKING refund policy (keyed on
 * hours elapsed since the order was placed) to the delivery-time-anchored
 * policy, so the refund protects the baker as delivery approaches:
 *
 *   > 48h before delivery  → 100% refund
 *   24–48h before delivery →  50% refund
 *   < 24h before delivery  →   0% refund
 *
 * Plus a grace-period override: an order PLACED with under 16h of notice gets
 * 2 hours from booking to cancel at 100% (computed per-booking at creation —
 * see freeCancelUntil in booking.controller.js).
 *
 * Existing bookings are untouched on purpose: they carry the policy snapshot
 * that was in force when the customer paid, and cancel under those rules.
 *
 * Usage: node scripts/migrateCakeCancellationPolicy.js [MONGO_URI]
 */

const CAKE_CANCELLATION_TIERS = [
  { minHoursBefore: 48, refundPercent: 100 },
  { minHoursBefore: 24, refundPercent: 50 },
  { minHoursBefore: 0, refundPercent: 0 },
];

const CAKE_CANCELLATION_GRACE = { windowMinutes: 120, appliesBelowLeadHours: 16 };

async function run() {
  const uri = process.env.MONGO_URI || process.argv[2];
  if (!uri) {
    console.error("Usage: node scripts/migrateCakeCancellationPolicy.js <MONGO_URI>");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const result = await Service.updateMany(
    { cancellationPolicyType: "SINCE_BOOKING" },
    {
      $set: {
        cancellationPolicyType: "BEFORE_SERVICE",
        cancellationTiers: CAKE_CANCELLATION_TIERS,
        cancellationGrace: CAKE_CANCELLATION_GRACE,
      },
    }
  );

  console.log(
    result.matchedCount === 0
      ? "No SINCE_BOOKING services found — nothing to migrate."
      : `Migrated ${result.modifiedCount} of ${result.matchedCount} cake service(s) to the delivery-time policy (48h/24h/0h + 2h grace under 16h notice).`
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
