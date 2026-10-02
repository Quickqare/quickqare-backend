require("dotenv").config();
const mongoose = require("mongoose");
const Rating = require("../models/Rating");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");
const {
  roundRating,
  refreshPartnerRating,
  refreshServiceRating,
} = require("../services/rating.service");

/*
 * Rebuilds every partner's and service's rating from its Rating documents.
 *
 * Why: until the Sept 2026 fix each new review replaced the stored average —
 * Partner had no totalReviews field (Service had neither field), so the running
 * count was always zero. A partner's stored rating is therefore just their most
 * recent review. This recomputes rating + totalReviews from the Rating
 * collection with the same code every new rating now runs. Partners/services
 * nobody has rated keep their defaults.
 *
 * Dry-run by default; pass --apply to write. Safe to re-run.
 *
 * Usage: node scripts/recomputeRatings.js [MONGO_URI] [--apply]
 */

async function recompute(Model, label, ratingKey, refresh, apply) {
  const groups = await Rating.aggregate([
    { $match: { [ratingKey]: { $ne: null } } },
    { $group: { _id: `$${ratingKey}`, average: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);

  let rated = 0;
  let changed = 0;
  for (const group of groups) {
    const doc = await Model.findById(group._id).select("rating totalReviews").lean();
    if (!doc) continue; // rated, but since deleted
    rated += 1;

    const rating = roundRating(group.average);
    if (doc.rating === rating && doc.totalReviews === group.count) continue;

    changed += 1;
    console.log(
      `[${label}] ${group._id}: rating ${doc.rating ?? "-"} -> ${rating}, ` +
        `totalReviews ${doc.totalReviews ?? "-"} -> ${group.count}` +
        (apply ? "" : " (dry-run)")
    );
    if (apply) await refresh(group._id);
  }

  console.log(
    `[${label}] ${changed} of ${rated} rated ${label}(s) ` +
      (apply ? "updated." : "would change (dry-run).")
  );
}

async function run() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const uri = process.env.MONGO_URI || args.find((a) => !a.startsWith("--"));
  if (!uri) {
    console.error("Usage: node scripts/recomputeRatings.js <MONGO_URI> [--apply]");
    process.exit(1);
  }
  await mongoose.connect(uri);

  await recompute(Partner, "partner", "partnerId", refreshPartnerRating, apply);
  await recompute(Service, "service", "serviceId", refreshServiceRating, apply);

  if (!apply) console.log("Dry-run — pass --apply to write.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
