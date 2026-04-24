const express = require("express");
const router = express.Router();

const adminAuth = require("../middlewares/adminAuth");
const adminController = require("../controllers/admin.controller");

// NEW (production service system)
const categoryController = require("../controllers/category.controller");
const subCategoryController = require("../controllers/subCategory.controller");
const serviceController = require("../controllers/service.controller");
const uploadController = require("../controllers/uploadController");
const upload = require("../config/multer");

router.use(adminAuth); // protect everything here

/* =====================================================
   WITHDRAWALS
===================================================== */
router.get("/withdrawals", adminController.getWithdrawals);
router.post("/withdrawal/process", adminController.processWithdrawal);

/* =====================================================
   BOOKINGS
===================================================== */
router.get("/bookings", adminController.getAllBookings);
router.get("/booking/:bookingId", adminController.getBookingDetails);

// Force assignment
router.post("/booking/assign", adminController.forceAssignPartner);

/* =====================================================
   PARTNER MANAGEMENT
===================================================== */
router.get("/partners", adminController.getAllPartners);
router.patch("/partner/block/:partnerId", adminController.blockPartner);
router.patch("/partner/unblock/:partnerId", adminController.unblockPartner);

/* =====================================================
   WALLET MANAGEMENT
===================================================== */
router.post("/wallet/adjust", adminController.adjustWallet);

/* =====================================================
   CATEGORY MANAGEMENT (NEW - PRODUCTION)
===================================================== */

// Create category (AC, Beauty, Mehndi)
router.post("/categories", categoryController.createCategory);

// Get all categories
router.get("/categories", categoryController.getCategories);

// Update category
router.put("/categories/:id", categoryController.updateCategory);

// Delete category
router.delete("/categories/:id", categoryController.deleteCategory);

/* =====================================================
   SUBCATEGORY MANAGEMENT (NEW)
===================================================== */

// Create subcategory (Repair, Facial, etc.)
router.post("/subcategories", subCategoryController.createSubCategory);

// Get subcategories by category
router.get(
  "/subcategories/:categoryId",
  subCategoryController.getSubCategoriesByCategory
);

// Update subcategory
router.put("/subcategories/:id", subCategoryController.updateSubCategory);

// Delete subcategory
router.delete("/subcategories/:id", subCategoryController.deleteSubCategory);

/* =====================================================
   SERVICE MANAGEMENT (NEW)
===================================================== */

// Create service
router.post("/services", serviceController.createService);

// Get all services
router.get("/services", serviceController.getServices);

// Update service
router.put("/services/:id", serviceController.updateService);

// Delete service
router.delete("/services/:id", serviceController.deleteService);

/* =====================================================
   IMAGE UPLOAD (CLOUDINARY)
===================================================== */

// Upload image → returns imageUrl
router.post("/upload", upload.single("image"), uploadController.uploadImage);

module.exports = router;