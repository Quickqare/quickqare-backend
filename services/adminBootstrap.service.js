const AdminUser = require("../admin/models/AdminUser");
const { ADMIN_ROLES } = require("../admin/constants/permissions");
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

async function ensureBootstrapAdmin() {
  const enabled =
    String(process.env.ADMIN_BOOTSTRAP_ENABLED || "").toLowerCase() === "true";

  if (!enabled) {
    return { enabled: false, changed: false };
  }

  const email = String(process.env.ADMIN_BOOTSTRAP_EMAIL || "")
    .trim()
    .toLowerCase();
  const password = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || "").trim();
  const name = String(process.env.ADMIN_BOOTSTRAP_NAME || "QuickQare Admin").trim();
  const role = String(
    process.env.ADMIN_BOOTSTRAP_ROLE || ADMIN_ROLES.SUPER_ADMIN
  ).trim();

  if (!email || !password) {
    console.warn(
      "[admin-bootstrap] skipped: ADMIN_BOOTSTRAP_EMAIL or ADMIN_BOOTSTRAP_PASSWORD missing"
    );
    return { enabled: true, changed: false };
  }

  const passwordHash = await AdminUser.hashPassword(password);
  const existing = await AdminUser.findOne({ email });

  if (!existing) {
    await AdminUser.create({
      name,
      email,
      passwordHash,
      role,
      isActive: true,
      twoFaEnabled: true,
    });

    console.log(`[admin-bootstrap] created admin user: ${email}`);
    return { enabled: true, changed: true, created: true };
  }

  let changed = false;

  if (existing.name !== name) {
    existing.name = name;
    changed = true;
  }

  if (existing.role !== role) {
    existing.role = role;
    changed = true;
  }

  if (!existing.isActive) {
    existing.isActive = true;
    changed = true;
  }

  existing.passwordHash = passwordHash;
  changed = true;

  if (changed) {
    await existing.save();
    console.log(`[admin-bootstrap] updated admin user: ${email}`);
  }

  return { enabled: true, changed, created: false };
}

module.exports = {
  ensureBootstrapAdmin,
};
