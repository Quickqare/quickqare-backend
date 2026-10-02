require("dotenv").config();
const mongoose = require("mongoose");
const Coupon = require("../models/coupon");
const Referral = require("../models/Referral");

/*
 * Binds every already-issued referral reward coupon to the customer it was
 * issued for (Coupon.assignedTo = Referral.referredId).
 *
 * Why: until the Sept 2026 fix, referral rewards were unassigned single-use
 * codes — the public GET /api/coupons/available feed listed them, and whoever
 * redeemed one first got it. New rewards are issued with assignedTo; unassigned
 * coupons are treated as general promo codes, so without this pass the rewards
 * already issued stay public.
 *
 * Also reports active REF… coupons that no referral points at — those can't be
 * bound automatically; deactivate them in the admin panel if they're unused.
 *
 * Dry-run by default; pass --apply to write.
 *
 * Usage: node scripts/bindReferralCoupons.js [MONGO_URI] [--apply]
 */

async function run() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const uri = process.env.MONGO_URI || args.find((a) => !a.startsWith("--"));
  if (!uri) {
    console.error("Usage: node scripts/bindReferralCoupons.js <MONGO_URI> [--apply]");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const referrals = await Referral.find({ couponId: { $ne: null } })
    .select("couponId referredId")
    .lean();

  const linkedCouponIds = new Set();
  let bound = 0;

  for (const referral of referrals) {
    linkedCouponIds.add(String(referral.couponId));
    const coupon = await Coupon.findById(referral.couponId).select("code assignedTo").lean();
    if (!coupon) continue;

    if (coupon.assignedTo) {
      if (String(coupon.assignedTo) !== String(referral.referredId)) {
        console.log(
          `MISMATCH ${coupon.code}: assigned to ${coupon.assignedTo}, ` +
            `referral says ${referral.referredId} — left as is`
        );
      }
      continue;
    }

    bound += 1;
    console.log(`${coupon.code} -> customer ${referral.referredId}${apply ? "" : " (dry-run)"}`);
    if (apply) {
      await Coupon.updateOne(
        { _id: coupon._id, assignedTo: null },
        { $set: { assignedTo: referral.referredId } }
      );
    }
  }

  const unlinked = await Coupon.find({ code: /^REF\d/, assignedTo: null, isActive: true })
    .select("code usedCount")
    .lean();
  let unlinkedCount = 0;
  for (const coupon of unlinked) {
    if (linkedCouponIds.has(String(coupon._id))) continue;
    unlinkedCount += 1;
    console.log(
      `UNLINKED ${coupon.code} (used ${coupon.usedCount || 0}x) — no referral points at it, ` +
        `still public; deactivate it in the admin panel if unused`
    );
  }

  console.log(
    `${bound} referral coupon(s) bound${apply ? "" : " (dry-run — pass --apply to write)"}, ` +
      `${unlinkedCount} unlinked REF coupon(s) still public.`
  );
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
