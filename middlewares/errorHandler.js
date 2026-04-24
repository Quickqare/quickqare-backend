/* =====================================================
   GLOBAL ERROR HANDLER (PRODUCTION SAFE)
===================================================== */
module.exports = (err, req, res, next) => {
  console.error("🔥 Error:", err);

  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal Server Error";

  /* =====================
     MONGOOSE CAST ERROR
     Invalid ObjectId
  ===================== */
  if (err.name === "CastError") {
    statusCode = 400;
    message = `Invalid ${err.path}: ${err.value}`;
  }

  /* =====================
     MONGOOSE VALIDATION ERROR
  ===================== */
  if (err.name === "ValidationError") {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((val) => val.message)
      .join(", ");
  }

  /* =====================
     DUPLICATE KEY ERROR
  ===================== */
  if (err.code === 11000) {
    statusCode = 400;
    const field = Object.keys(err.keyValue)[0];
    message = `${field} already exists`;
  }

  /* =====================
     JWT ERRORS
  ===================== */
  if (err.name === "JsonWebTokenError") {
    statusCode = 401;
    message = "Invalid token";
  }

  if (err.name === "TokenExpiredError") {
    statusCode = 401;
    message = "Token expired";
  }

  /* =====================
     FINAL RESPONSE
  ===================== */
  res.status(statusCode).json({
    success: false,
    message,

    // show stack only in development
    ...(process.env.NODE_ENV === "development" && {
      stack: err.stack,
    }),
  });
};