const Booking = require("../models/Booking");

/* Statuses before the technician reaches the customer — a helper can still be
   taken off the job in these. */
const HELPER_EDITABLE_STATUSES = [
  "ASSIGNED",
  "CONFIRMED",
  "PARTNER_ACCEPTED",
  "ON_THE_WAY",
];

/* Take a helper off every job that hasn't started. Called when the technician
   link is removed or reassigned, so an unlinked helper keeps no access to
   customer addresses/phones or job reminders. Returns the affected booking ids. */
async function removeHelperFromUpcomingBookings(helperId) {
  const filter = {
    "helpers.partnerId": helperId,
    status: { $in: HELPER_EDITABLE_STATUSES },
  };
  const affected = await Booking.find(filter).select("_id").lean();
  if (!affected.length) return [];
  await Booking.updateMany(
    { _id: { $in: affected.map((b) => b._id) } },
    { $pull: { helpers: { partnerId: helperId } } }
  );
  return affected.map((b) => String(b._id));
}

module.exports = { HELPER_EDITABLE_STATUSES, removeHelperFromUpcomingBookings };
