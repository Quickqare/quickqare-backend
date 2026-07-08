const { body, param, query } = require("express-validator");

/* =====================================================
   USER VALIDATORS
===================================================== */

exports.registerUserValidator = [
  body("name").notEmpty().withMessage("Name is required"),

  body("phone")
    .isLength({ min: 10 })
    .withMessage("Phone must be at least 10 digits"),

  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .matches(/^(?=.*[A-Z])(?=.*\d)/)
    .withMessage("Password must contain at least one uppercase letter and one number"),
];

/* =====================================================
   USER PROFILE UPDATE VALIDATOR
===================================================== */
exports.updateProfileValidator = [
  body("name")
    .trim()
    .notEmpty().withMessage("Name is required")
    .isLength({ max: 100 }).withMessage("Name must be 100 characters or fewer"),

  body("gender")
    .trim()
    .notEmpty().withMessage("Gender is required")
    .isIn(["Male", "Female", "Other"]).withMessage("Gender must be Male, Female or Other"),

  // Optional — the web profile page edits email; mobile doesn't send it.
  // An empty string is allowed and clears the saved email.
  body("email")
    .optional({ values: "falsy" })
    .trim()
    .isEmail().withMessage("Email must be a valid email address")
    .isLength({ max: 254 }).withMessage("Email must be 254 characters or fewer"),
];

/* =====================================================
   PARTNER VALIDATORS (UPDATED FOR PRODUCTION)
   Supports multi-service system
===================================================== */
exports.registerPartnerValidator = [
  body("name").notEmpty().withMessage("Name is required"),

  body("phone")
    .isLength({ min: 10 })
    .withMessage("Phone must be at least 10 digits"),

  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .matches(/^(?=.*[A-Z])(?=.*\d)/)
    .withMessage("Password must contain at least one uppercase letter and one number"),

  body("gender")
    .notEmpty()
    .withMessage("Gender is required")
    .isIn(["MALE", "FEMALE", "OTHER"])
    .withMessage("Gender must be MALE, FEMALE or OTHER"),

  body("dateOfBirth")
    .notEmpty()
    .withMessage("dateOfBirth is required")
    .isISO8601()
    .withMessage("dateOfBirth must be in YYYY-MM-DD format"),

  // backward compatibility
  body("serviceCategory").optional().isString(),

  // new production structure
  body("serviceCategories").optional().isArray(),
];

/* =====================================================
   BOOKING VALIDATOR (PRODUCTION CART SYSTEM)
   Supports:
   - services[] (new)
   - serviceId (old)
===================================================== */
exports.createBookingValidator = [
  /* =====================
     MULTI SERVICE (NEW)
  ===================== */
  body("services")
    .optional()
    .isArray({ min: 1 })
    .withMessage("services must be an array"),

  body("services.*.serviceId")
    .optional()
    .isMongoId()
    .withMessage("valid serviceId required"),

  body("services.*.quantity")
    .optional()
    .isInt({ min: 1 })
    .withMessage("quantity must be at least 1"),

  body("services.*.price")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("price must be a non-negative number"),

  /* =====================
     CUSTOMIZATION OPTIONS (CAKES)
     Deep validation (valid flavour/addon names, pricing) happens in
     createBooking against the Service's customization config.
  ===================== */
  body("services.*.options.flavour")
    .optional()
    .isString()
    .withMessage("flavour must be a string"),

  body("services.*.options.weight")
    .optional()
    .isString()
    .withMessage("weight must be a string"),

  body("services.*.options.tiers")
    .optional()
    .isInt({ min: 1, max: 2 })
    .withMessage("tiers must be 1 or 2"),

  body("services.*.options.addons")
    .optional()
    .isArray()
    .withMessage("addons must be an array of addon names"),

  body("services.*.options.nameOnCake")
    .optional()
    .isString()
    .isLength({ max: 40 })
    .withMessage("nameOnCake must be at most 40 characters"),

  body("services.*.options.referencePhotoUrl")
    .optional()
    .isString()
    .isLength({ max: 1024 })
    .withMessage("referencePhotoUrl must be at most 1024 characters"),

  /* =====================
     PRIMARY SERVICE (NEW)
  ===================== */
  body("primaryService")
    .optional()
    .isMongoId()
    .withMessage("primaryService must be valid id"),

  /* =====================
     OLD SINGLE SERVICE FLOW
     (BACKWARD COMPATIBILITY)
  ===================== */
  body("serviceId").optional().isMongoId(),

  body("serviceCategory")
    .optional()
    .isString()
    .withMessage("serviceCategory must be string"),

  /* =====================
     COMMON BOOKING DATA
  ===================== */
  body("scheduledDate")
    .notEmpty()
    .withMessage("scheduledDate is required")
    .isISO8601()
    .withMessage("scheduledDate must be ISO format"),

  body("scheduledTime")
    .notEmpty()
    .withMessage("scheduledTime is required"),

  body("location.coordinates")
    .isArray({ min: 2, max: 2 })
    .withMessage("location coordinates required"),

  body("location.coordinates.0")
    .isFloat({ min: -180, max: 180 })
    .withMessage("longitude must be a number between -180 and 180"),

  body("location.coordinates.1")
    .isFloat({ min: -90, max: 90 })
    .withMessage("latitude must be a number between -90 and 90"),

  body("pincode")
    .notEmpty()
    .withMessage("pincode is required")
    .isLength({ min: 6, max: 6 })
    .withMessage("pincode must be 6 digits"),

  body("address")
    .notEmpty()
    .withMessage("address is required")
    .isLength({ min: 5 })
    .withMessage("address must be at least 5 characters"),

  body("couponCode")
    .optional()
    .isString()
    .withMessage("couponCode must be string"),
];
