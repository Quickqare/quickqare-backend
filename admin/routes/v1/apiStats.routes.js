const express = require("express");
const ApiCallStat = require("../../../models/ApiCallStat");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const { PERMISSIONS } = require("../../constants/permissions");
const { success, fail } = require("../../utils/response");

const router = express.Router();
router.use(authenticateAdmin, authorize(PERMISSIONS.ANALYTICS_READ));

const GOOGLE_SOURCES = [
  "partner_heartbeat",
  "partner_available_svc",
  "customer_reverse_geocode",
  "customer_address_search",
];
const ADMIN_SOURCES = [
  "admin_live_tracking",
  "admin_partner_location",
  "admin_location_ping",
];
const ALL_SOURCES = [...GOOGLE_SOURCES, ...ADMIN_SOURCES];

const COST_PER_1000 = 5; // USD — Google Maps Geocoding API

function dateRange(days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/*
GET /api/v1/admin/api-stats?days=30
Returns daily stats grouped by source for the last N days (default 30, max 90).
*/
router.get("/", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const dates = dateRange(days);
    const fromDate = dates[0];

    const rows = await ApiCallStat.find({ date: { $gte: fromDate } })
      .sort({ date: 1 })
      .lean();

    // Build a map: date → source → stat
    const byDate = {};
    for (const date of dates) byDate[date] = {};
    for (const row of rows) {
      if (byDate[row.date]) byDate[row.date][row.source] = row;
    }

    // Daily breakdown
    const daily = dates.map((date) => {
      const entry = { date };
      let totalGoogle = 0, totalCacheHits = 0, totalAdmin = 0;

      for (const src of GOOGLE_SOURCES) {
        const stat = byDate[date][src] || {};
        entry[src] = {
          googleCalls: stat.googleCalls || 0,
          cacheHits:   stat.cacheHits   || 0,
          total:       stat.total       || 0,
        };
        totalGoogle    += stat.googleCalls || 0;
        totalCacheHits += stat.cacheHits   || 0;
      }
      for (const src of ADMIN_SOURCES) {
        const stat = byDate[date][src] || {};
        entry[src] = { total: stat.total || 0 };
        totalAdmin += stat.total || 0;
      }

      entry.totals = {
        googleCalls: totalGoogle,
        cacheHits:   totalCacheHits,
        adminActivity: totalAdmin,
        estimatedCostUsd: Number(((totalGoogle / 1000) * COST_PER_1000).toFixed(4)),
      };
      return entry;
    });

    // Period summaries
    function sumDays(n) {
      const slice = daily.slice(-n);
      const googleCalls   = slice.reduce((s, d) => s + d.totals.googleCalls,   0);
      const cacheHits     = slice.reduce((s, d) => s + d.totals.cacheHits,     0);
      const adminActivity = slice.reduce((s, d) => s + d.totals.adminActivity, 0);
      const total         = googleCalls + cacheHits;
      return {
        googleCalls,
        cacheHits,
        adminActivity,
        total,
        cacheHitRate: total > 0 ? Number(((cacheHits / total) * 100).toFixed(1)) : 0,
        estimatedCostUsd: Number(((googleCalls / 1000) * COST_PER_1000).toFixed(4)),
      };
    }

    // Per-source totals over the full period
    const bySource = {};
    for (const src of ALL_SOURCES) {
      const googleCalls   = rows.filter(r => r.source === src).reduce((s, r) => s + (r.googleCalls || 0), 0);
      const cacheHits     = rows.filter(r => r.source === src).reduce((s, r) => s + (r.cacheHits   || 0), 0);
      const total         = rows.filter(r => r.source === src).reduce((s, r) => s + (r.total       || 0), 0);
      bySource[src] = {
        googleCalls,
        cacheHits,
        total,
        cacheHitRate: total > 0 ? Number(((cacheHits / total) * 100).toFixed(1)) : 0,
        estimatedCostUsd: Number(((googleCalls / 1000) * COST_PER_1000).toFixed(4)),
        isGoogleSource: GOOGLE_SOURCES.includes(src),
      };
    }

    return success(res, {
      periods: {
        today:   sumDays(1),
        week:    sumDays(7),
        month:   sumDays(30),
        custom:  sumDays(days),
      },
      bySource,
      daily,
      meta: { days, fromDate, costPer1000: COST_PER_1000 },
    }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "API_STATS_FAILED", "Unable to fetch API stats", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
