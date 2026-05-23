const ApiCallStat = require("../models/ApiCallStat");

function todayString() {
  return new Date().toISOString().slice(0, 10); // "2026-05-21"
}

// Fire-and-forget — never throws, never blocks the request path.
async function trackApiCall(source, { cacheHit = false } = {}) {
  try {
    await ApiCallStat.findOneAndUpdate(
      { date: todayString(), source },
      {
        $inc: {
          total:       1,
          googleCalls: cacheHit ? 0 : 1,
          cacheHits:   cacheHit ? 1 : 0,
        },
      },
      { upsert: true }
    );
  } catch (_) {
    // Stats tracking is non-critical — swallow errors silently
  }
}

module.exports = { trackApiCall };
