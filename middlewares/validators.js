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
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters"),
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
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters"),

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
    .isFloat({ min: 0.01 })
    .withMessage("price must be greater than 0"),

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
    .isFloat()
    .withMessage("longitude must be number"),

  body("location.coordinates.1")
    .isFloat()
    .withMessage("latitude must be number"),

  body("pincode")
    .notEmpty()
    .withMessage("pincode is required")
    .isLength({ min: 6, max: 6 })
    .withMessage("pincode must be 6 digits"),

  body("couponCode")
    .optional()
    .isString()
    .withMessage("couponCode must be string"),
];
