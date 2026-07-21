const mongoose = require("mongoose");

/* =====================================================
   OBJECT-ID PARAM VALIDATION
   Returns 400 for a malformed :id BEFORE it reaches a controller, instead of
   letting an invalid id turn into a Mongoose CastError that controllers catch
   and report as a blanket 500. Client error → 4xx, not 5xx.

   Usage: router.get("/:bookingId", validateObjectId("bookingId"), handler)
===================================================== */
module.exports = (paramName = "id") => (req, res, next) => {
  const value = req.params[paramName];
  if (!mongoose.Types.ObjectId.isValid(String(value || ""))) {
    return res.status(400).json({
      success: false,
      message: `Invalid ${paramName}`,
    });
  }
  return next();
};
