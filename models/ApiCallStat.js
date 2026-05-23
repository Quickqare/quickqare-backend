const mongoose = require("mongoose");

/*
=====================================================
API CALL STAT
Tracks Google Maps API usage per source per day.
One document per (date, source) pair — upserted on
every tracked call so writes are cheap.
=====================================================
*/
const apiCallStatSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true }, // "2026-05-21"
    source: { type: String, required: true, index: true },
    // Sources:
    //   partner_heartbeat        — partner app location update
    //   partner_available_svc    — partner checks available services
    //   customer_reverse_geocode — customer app reverse geocode
    //   customer_address_search  — customer app address search
    //   admin_live_tracking      — admin fetches all partner live locations
    //   admin_partner_location   — admin fetches single partner location
    //   admin_location_ping      — admin pings all partners for location

    googleCalls: { type: Number, default: 0 }, // actual Google API calls made
    cacheHits:   { type: Number, default: 0 }, // served from cache (no Google call)
    total:       { type: Number, default: 0 }, // total requests = googleCalls + cacheHits
  },
  { timestamps: true }
);

apiCallStatSchema.index({ date: 1, source: 1 }, { unique: true });

module.exports = mongoose.model("ApiCallStat", apiCallStatSchema);
