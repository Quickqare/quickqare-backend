const express = require("express");
const Service = require("../../../models/service.model");
const LearnedStat = require("../../../models/LearnedStat");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const { PERMISSIONS } = require("../../constants/permissions");
const { success, fail } = require("../../utils/response");
const {
  LEARNED_DURATION_MIN_FACTOR,
  LEARNED_DURATION_MAX_FACTOR,
  LEARNED_DURATION_MIN_SAMPLES,
  DEFAULT_TRAVEL_BUFFER_MINUTES,
  AC_TRAVEL_BUFFER_MINUTES,
  TRAVEL_BUFFER_GENERAL_MIN,
  TRAVEL_BUFFER_GENERAL_MAX,
  TRAVEL_BUFFER_AC_MIN,
  TRAVEL_BUFFER_AC_MAX,
} = require("../../../services/scheduling_service");

const router = express.Router();

// Read-only visibility into what the nightly learning crons have inferred so
// far — learned per-service durations and per-category travel buffers — next to
// the admin-entered defaults and the ±40% clamp band the scheduler enforces.
// Purely observational: this endpoint never writes, it just mirrors the exact
// values serviceDurationMinutes / getLearnedTravelBuffers feed the scheduler so
// an operator can sanity-check them before trusting (or extending) the learners.
router.use(authenticateAdmin, authorize(PERMISSIONS.ANALYTICS_READ));

// Kept in sync with cron.service.js LEARNED_TRAVEL_MIN_BATCH — the number of
// clean transit samples a category needs before its buffer is written at all.
const TRAVEL_MIN_SAMPLES = 10;

router.get("/overview", async (req, res) => {
  try {
    const minSamples = LEARNED_DURATION_MIN_SAMPLES;

    // ── Learned service durations ────────────────────────────────────────────
    const services = await Service.find({})
      .select("name duration learnedDurationMinutes learnedDurationSamples isActive updatedAt category")
      .populate("category", "name slug")
      .sort({ name: 1 })
      .lean();

    const durations = services.map((s) => {
      const base = Math.max(Number(s.duration) || 60, 1);
      const learned = Number(s.learnedDurationMinutes);
      const samples = Number(s.learnedDurationSamples) || 0;
      const hasLearned = Number.isFinite(learned) && learned > 0;
      // Mirror serviceDurationMinutes: the learned value only overrides the
      // admin duration once it clears the sample floor, and is always clamped
      // to ±40% of the admin value.
      const active = hasLearned && samples >= minSamples;
      const clampLo = Math.round(base * LEARNED_DURATION_MIN_FACTOR);
      const clampHi = Math.round(base * LEARNED_DURATION_MAX_FACTOR);
      const effective = active
        ? Math.round(
            Math.min(
              Math.max(learned, base * LEARNED_DURATION_MIN_FACTOR),
              base * LEARNED_DURATION_MAX_FACTOR
            )
          )
        : base;
      // clamped = the raw learned value fell outside the band, so the scheduler
      // is using a pinned edge value rather than the observed one (a signal the
      // real duration may be drifting past what the ±40% guard allows).
      const clamped = active && (learned < clampLo || learned > clampHi);
      const deltaPct = active ? Math.round(((effective - base) / base) * 100) : null;

      return {
        serviceId: s._id,
        name: s.name,
        category: s.category?.name || null,
        isActive: s.isActive !== false,
        adminDuration: base,
        learnedDuration: hasLearned ? Math.round(learned) : null,
        samples,
        effectiveDuration: effective,
        active,
        clampLo,
        clampHi,
        clamped,
        deltaPct,
        updatedAt: s.updatedAt || null,
      };
    });

    // ── Learned travel buffers (LearnedStat "travelBuffer") ──────────────────
    const doc = await LearnedStat.findOne({ key: "travelBuffer" }).lean();
    const data = doc?.data || {};
    const sampleCounts = data.samples || {};

    const buildBuffer = (cat, def, lo, hi) => {
      const learned = Number(data[cat]);
      const hasLearned = Number.isFinite(learned) && learned > 0;
      const samples = Number(sampleCounts[cat]) || 0;
      // The cron already clamps on write; clamp again here defensively so the
      // reported "effective" always matches what cachedFlatTravelBuffer serves.
      const effective = hasLearned ? Math.round(Math.min(Math.max(learned, lo), hi)) : def;
      return {
        learned: hasLearned ? Math.round(learned) : null,
        samples,
        default: def,
        effective,
        clampLo: lo,
        clampHi: hi,
        active: hasLearned,
      };
    };

    const travelBuffers = {
      general: buildBuffer(
        "general",
        DEFAULT_TRAVEL_BUFFER_MINUTES,
        TRAVEL_BUFFER_GENERAL_MIN,
        TRAVEL_BUFFER_GENERAL_MAX
      ),
      ac: buildBuffer(
        "ac",
        AC_TRAVEL_BUFFER_MINUTES,
        TRAVEL_BUFFER_AC_MIN,
        TRAVEL_BUFFER_AC_MAX
      ),
      updatedAt: doc?.updatedAt || null,
    };

    return success(
      res,
      {
        durations,
        travelBuffers,
        meta: {
          minSamples,
          minFactor: LEARNED_DURATION_MIN_FACTOR,
          maxFactor: LEARNED_DURATION_MAX_FACTOR,
          travelMinSamples: TRAVEL_MIN_SAMPLES,
          totalServices: durations.length,
          servicesLearning: durations.filter((x) => x.active).length,
          servicesClamped: durations.filter((x) => x.clamped).length,
          generatedAt: new Date(),
        },
      },
      { requestId: req.requestId }
    );
  } catch (error) {
    return fail(
      res,
      500,
      "LEARNING_OVERVIEW_FAILED",
      "Unable to fetch learning insights",
      error.message,
      { requestId: req.requestId }
    );
  }
});

module.exports = router;
