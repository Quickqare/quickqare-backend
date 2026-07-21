/**
 * TEST DATA RESET — wipes all transactional data so the DB is clean for launch.
 * Keeps: AdminUser, AdminSession, AdminSetting, Service, Category, SubCategory,
 *        Zone, Banner, Policy, Coupon, ReferralSettings, CatalogItem.
 *
 * Protected by (defense in depth — this endpoint is irreversibly destructive):
 *   1. Admin JWT (authenticateAdmin middleware)
 *   2. SuperAdmin-only permission (authorize(SYSTEM_RESET)) — every other
 *      destructive admin route is permission-gated; this one used to be gated
 *      by authentication ALONE, so any admin (incl. SupportAdmin) could wipe
 *      the whole database. It now requires SuperAdmin like the rest.
 *   3. Blocked when NODE_ENV=production, unless ALLOW_TEST_RESET_IN_PRODUCTION
 *      is explicitly set to "true" — a deliberate, greppable opt-in for the
 *      one-time pre-launch cleanup, off by default so it can never fire by
 *      accident on a live database.
 *   4. Body must include { confirm: "RESET ALL DATA" }
 */

const express = require("express");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { success, fail } = require("../../utils/response");

const router = express.Router();

const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_IN_PRODUCTION =
  String(process.env.ALLOW_TEST_RESET_IN_PRODUCTION || "").toLowerCase() === "true";

// Refuse to even reach the handler on a production deploy unless explicitly
// opted in. Returns 403 with a clear code so a misfire is obvious in logs.
function blockInProduction(req, res, next) {
  if (IS_PRODUCTION && !ALLOW_IN_PRODUCTION) {
    return fail(
      res,
      403,
      "RESET_DISABLED_IN_PRODUCTION",
      "Test data reset is disabled in production. Set ALLOW_TEST_RESET_IN_PRODUCTION=true to enable it deliberately.",
      null,
      { requestId: req.requestId }
    );
  }
  return next();
}

router.use(authenticateAdmin, authorize(PERMISSIONS.SYSTEM_RESET), blockInProduction);

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
