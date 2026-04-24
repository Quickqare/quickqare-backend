const { validationResult } = require("express-validator");

/* =====================================================
   VALIDATION MIDDLEWARE (PRODUCTION SAFE)
===================================================== */
module.exports = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map((err) => ({
      field: err.path,
      message: err.msg,
    }));

    return res.status(400).json({
      success: false,
      message: formattedErrors[0]?.message || "Validation failed",
      errors: formattedErrors,
    });
  }

  next();
};