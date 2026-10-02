const mongoose = require("mongoose");
const Rating = require("../models/Rating");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");

/* =====================================================
   RATING SUMMARIES
   A partner's / service's `rating` is the average of its Rating documents and
   `totalReviews` is how many there are. Both are recomputed from the Rating
   collection — the source of truth — rather than folding each new score into
   the stored average. That fold is how one review used to replace a partner's
   whole average: the models had no `totalReviews`, so the running count was
   always zero. Recomputing also corrects any summary that drifted (e.g. after
   an admin removal deleted ratings) the next time the entity is rated.
===================================================== */

const MAX_PASSES = 3;

const roundRating = (average) => Math.round(average * 100) / 100;

async function refreshSummary(Model, ratingKey, id) {
  if (!id) return null;
  const _id = new mongoose.Types.ObjectId(String(id));

  let summary = null;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const [group] = await Rating.aggregate([
      { $match: { [ratingKey]: _id } },
      { $group: { _id: null, average: { $avg: "$rating" }, count: { $sum: 1 } } },
    ]);
    if (!group) return null; // not rated yet — keep the model's default

    summary = { rating: roundRating(group.average), totalReviews: group.count };
    await Model.updateOne({ _id }, { $set: summary });

    // Another rating may have landed after our aggregate and been summarised by
    // a request that finished first, in which case we just overwrote the newer
    // summary. Recount and go again so the last write is the complete one.
    const current = await Rating.countDocuments({ [ratingKey]: _id });
    if (current === group.count) break;
  }
  return summary;
}

exports.roundRating = roundRating;
exports.refreshPartnerRating = (partnerId) => refreshSummary(Partner, "partnerId", partnerId);
exports.refreshServiceRating = (serviceId) => refreshSummary(Service, "serviceId", serviceId);
