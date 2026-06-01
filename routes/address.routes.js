const express = require("express");
const router = express.Router();
const userAuth = require("../middlewares/userAuth");
const {
  getAddresses,
  saveAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
} = require("../controllers/address.controller");

router.get("/", userAuth, getAddresses);
router.post("/", userAuth, saveAddress);
router.patch("/:id", userAuth, updateAddress);
router.delete("/:id", userAuth, deleteAddress);
router.patch("/:id/default", userAuth, setDefaultAddress);

module.exports = router;
