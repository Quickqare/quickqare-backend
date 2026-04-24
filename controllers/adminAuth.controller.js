const jwt = require("jsonwebtoken");

const ADMIN_EMAIL = "admin@quickqare.com";
const ADMIN_PASSWORD = "admin123"; // later store in DB

exports.loginAdmin = async (req, res) => {
  const { email, password } = req.body;

  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Invalid admin credentials" });
  }

  const token = jwt.sign(
    { role: "admin" },
    process.env.JWT_SECRET,
    { expiresIn: "1d" }
  );

  res.json({
    success: true,
    token,
  });
};
