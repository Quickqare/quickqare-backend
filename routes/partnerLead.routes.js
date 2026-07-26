const express = require("express");
const { body } = require("express-validator");
const router = express.Router();
const ProfessionalLead = require("../models/ProfessionalLead");
const validate = require("../middlewares/validate");
const { partnerLeadLimiter, partnerLeadPhoneLimiter } = require("../middlewares/rateLimiter");

/*
 * POST /api/partner-leads
 * Public — no auth. A prospective service partner leaves a phone number on
 * the "Register as a Professional" web page; ops calls them back. This is a
 * callback queue, not partner signup (see routes/partnerAuth.routes.js for
 * the real registration/KYC flow).
 */
router.post(
  "/",
  partnerLeadLimiter,
  partnerLeadPhoneLimiter,
  [
    body("name").optional({ values: "falsy" }).trim().isLength({ max: 100 }).withMessage("Name is too long"),
    body("phone").trim().isLength({ min: 10 }).withMessage("Enter a valid phone number"),
  ],
  validate,
  async (req, res) => {
    try {
      const phone = String(req.body.phone).replace(/\D/g, "").slice(-15);
      const name = String(req.body.name || "").trim().slice(0, 100);

      await ProfessionalLead.create({ name, phone, source: "web" });

      return res.json({
        success: true,
        message: "Thanks! Our team will call you shortly.",
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: "Could not submit right now. Please try again." });
    }
  }
);

module.exports = router;
