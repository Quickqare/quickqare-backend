const mongoose = require("mongoose");

/* =====================================================
   LEARNED STAT

   Generic key/value store for parameters the assignment
   engine LEARNS from real outcomes instead of relying on
   hardcoded guesses. One document per metric, keyed by a
   stable string. The nightly learning crons write here;
   the scheduler reads (cached) with a code-default fallback
   so a missing/empty doc never changes behaviour.

   Keys currently in use:
     "travelBuffer"     — { general, ac, samples } observed
                          transit minutes per category, EWMA-blended.
     "scoreWeightShadow" — latest snapshot of the score-weight
                          shadow report (fix 5); informational only,
                          never read by live scoring.

   Learned SERVICE durations do NOT live here — they sit on the
   Service document (learnedDurationMinutes) so the packer, which
   already loads services, needs no extra query.
===================================================== */
const learnedStatSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Free-form learned payload — shape depends on `key` (see header).
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // How many observations produced the current `data`. Lets a reader
    // ignore a metric that hasn't accumulated enough evidence yet.
    samples: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LearnedStat", learnedStatSchema);
