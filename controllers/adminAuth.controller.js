const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

exports.loginAdmin = async (req, res) => {
  const { email, password } = req.body;

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;

  if (!adminEmail || !adminPasswordHash) {
    console.error("[admin] ADMIN_EMAIL or ADMIN_PASSWORD_HASH env vars not configured");
    return res.status(503).json({ message: "Admin auth not configured" });
  }

  const emailMatch = email === adminEmail;
  const passwordMatch = await bcrypt.compare(password, adminPasswordHash);

  if (!emailMatch || !passwordMatch) {
    return res.status(401).json({ message: "Invalid admin credentials" });
  }

  const token = jwt.sign(
    { role: "admin" },
    process.env.JWT_SECRET,
    { expiresIn: "1d" }
  );

  res.json({ success: true, token });
};
