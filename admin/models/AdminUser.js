const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const { ADMIN_ROLES } = require("../constants/permissions");

const adminUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: Object.values(ADMIN_ROLES), required: true, index: true },
    isActive: { type: Boolean, default: true, index: true },
    twoFaEnabled: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

adminUserSchema.methods.verifyPassword = function verifyPassword(plainPassword) {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

adminUserSchema.statics.hashPassword = function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, 10);
};

module.exports = mongoose.model("AdminUser", adminUserSchema);
