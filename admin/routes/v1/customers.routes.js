const express = require("express");
const mongoose = require("mongoose");
const User = require("../../../models/User");
const Booking = require("../../../models/Booking");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { asSingleString, getPagination } = require("../../utils/common");
const { success, fail } = require("../../utils/response");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.CUSTOMERS_MANAGE));

router.get("/", async (req, res) => {
  try {
    const q = String(asSingleString(req.query.q) || "").trim();
    const { page, pageSize, skip, limit } = getPagination(req);

    const where = q
      ? {
          $or: [
            { name: { $regex: q, $options: "i" } },
            { phone: { $regex: q, $options: "i" } },
            { email: { $regex: q, $options: "i" } },
          ],
        }
      : {};

    const [customers, total] = await Promise.all([
      User.find(where).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(where),
    ]);

    const userIds = customers.map((c) => c._id);
    const spendRows = await Booking.aggregate([
      { $match: { user: { $in: userIds }, "payment.status": "PAID" } },
      { $group: { _id: "$user", totalBookings: { $sum: 1 }, totalSpent: { $sum: "$totalAmount" } } },
    ]);
    const spendMap = new Map(spendRows.map((s) => [String(s._id), s]));

    const data = customers.map((customer) => {
      const spend = spendMap.get(String(customer._id));
      return {
        id: String(customer._id),
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        status: customer.status || "ACTIVE",
        totalBookings: spend?.totalBookings || 0,
        totalSpent: spend?.totalSpent || 0,
        createdAt: customer.createdAt,
      };
    });

    return success(res, data, { requestId: req.requestId, pagination: { page, pageSize, total } });
  } catch (error) {
    return fail(res, 500, "CUSTOMERS_LIST_FAILED", "Unable to fetch customers", error.message, {
      requestId: req.requestId,
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const customerId = asSingleString(req.params.id);
    if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid customer id", null, { requestId: req.requestId });
    }

    const [customer, bookings] = await Promise.all([
      User.findById(customerId).lean(),
      Booking.find({ user: customerId }).sort({ createdAt: -1 }).limit(50).lean(),
    ]);

    if (!customer) {
      return fail(res, 404, "NOT_FOUND", "Customer not found", null, { requestId: req.requestId });
    }

    return success(
      res,
      {
        ...customer,
        id: String(customer._id),
        bookings,
      },
      { requestId: req.requestId }
    );
  } catch (error) {
    return fail(res, 500, "CUSTOMER_FETCH_FAILED", "Unable to fetch customer", error.message, {
      requestId: req.requestId,
    });
  }
});

router.patch("/:id/status", audit("admin.customers.status"), async (req, res) => {
  try {
    const customerId = asSingleString(req.params.id);
    const status = String(req.body.status || "").toUpperCase();
    if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) {
      return fail(res, 400, "INVALID_ID", "Invalid customer id", null, { requestId: req.requestId });
    }
    if (!["ACTIVE", "BLOCKED"].includes(status)) {
      return fail(res, 400, "VALIDATION_ERROR", "status must be ACTIVE or BLOCKED", null, {
        requestId: req.requestId,
      });
    }

    const updated = await User.findByIdAndUpdate(customerId, { $set: { status } }, { new: true }).lean();
    if (!updated) {
      return fail(res, 404, "NOT_FOUND", "Customer not found", null, { requestId: req.requestId });
    }

    return success(res, updated, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "CUSTOMER_STATUS_FAILED", "Unable to update customer status", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
