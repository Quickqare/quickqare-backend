/**
 * TEST DATA RESET — wipes all transactional data so the DB is clean for launch.
 * Keeps: AdminUser, AdminSession, AdminSetting, Service, Category, SubCategory,
 *        Zone, Banner, Policy, Coupon, ReferralSettings, CatalogItem.
 *
 * Protected by:
 *   1. Admin JWT (authenticateAdmin middleware)
 *   2. Body must include { confirm: "RESET ALL DATA" }
 */

const express = require("express");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const audit = require("../../middleware/audit");
const { success, fail } = require("../../utils/response");

const router = express.Router();

router.use(authenticateAdmin);

router.post("/", audit("admin.test_reset"), async (req, res) => {
  try {
    if (req.body?.confirm !== "RESET ALL DATA") {
      return fail(
        res, 400, "CONFIRM_REQUIRED",
        'Send { "confirm": "RESET ALL DATA" } to proceed.',
        null, { requestId: req.requestId }
      );
    }

    const mongoose = require("mongoose");

    // Collections to wipe — all transactional / user-generated data
    const WIPE_COLLECTIONS = [
      "bookings",
      "partners",
      "users",
      "partnerwallet",         // PartnerWallet
      "userwallets",           // UserWallet
      "userwallettransactions",
      "wallettransactions",
      "withdrawals",
      "referrals",
      "complaints",
      "complainttimelines",
      "ratings",
      "bookingtimelines",
      "bookingassignments",
      "refunds",
      "payoutbatches",
      "disputes",
      "couponredemptions",
      "slotlocks",
      "slotcapacities",
      "jobs",
      "auditlogs",
    ];

    const db = mongoose.connection.db;
    const existingCollections = await db.listCollections().toArray();
    const existingNames = new Set(existingCollections.map((c) => c.name.toLowerCase()));

    const results = {};
    for (const col of WIPE_COLLECTIONS) {
      if (!existingNames.has(col)) {
        results[col] = 0;
        continue;
      }
      const result = await db.collection(col).deleteMany({});
      results[col] = result.deletedCount;
    }

    const totalDeleted = Object.values(results).reduce((a, b) => a + Number(b), 0);

    console.warn(
      `[test-reset] Full data reset performed by admin ${req.adminUser?.email || req.adminUser?.id}. ` +
      `${totalDeleted} documents deleted.`
    );

    return success(res, {
      message: "All test data wiped. Catalog, zones, banners, policies, coupons, and admin accounts are preserved.",
      totalDeleted,
      breakdown: results,
    }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "RESET_FAILED", "Reset failed", error.message, { requestId: req.requestId });
  }
});

module.exports = router;
