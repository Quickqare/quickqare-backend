/**
 * PATCH /api/user/profile — updateProfile controller + validator.
 *
 * The web profile page sends { name, email, gender }; the mobile app sends
 * only { name, gender }. Email must be optional: updated when present
 * (including "" to clear it), untouched when absent, and rejected when
 * malformed.
 */
const { validationResult } = require("express-validator");

const User = require("../models/User");
const { updateProfile } = require("../controllers/user.controller");
const { updateProfileValidator } = require("../middlewares/validators");

// Minimal mock Express res that records status + body.
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function runValidators(body) {
  const req = { body };
  for (const validator of updateProfileValidator) {
    await validator.run(req);
  }
  return { errors: validationResult(req), body: req.body };
}

describe("updateProfile controller", () => {
  let user;

  beforeEach(async () => {
    user = await User.create({
      phone: "9876543210",
      name: "Old Name",
      gender: "Male",
      email: "old@example.com",
    });
  });

  const makeReq = (body) => ({ body, user: { id: user._id.toString() } });

  test("mobile shape (no email) updates name/gender and leaves email untouched", async () => {
    const res = mockRes();
    await updateProfile(makeReq({ name: "New Name", gender: "Other" }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    const saved = await User.findById(user._id);
    expect(saved.name).toBe("New Name");
    expect(saved.gender).toBe("Other");
    expect(saved.email).toBe("old@example.com");
  });

  test("web shape updates email and tracks the change in profileEdits", async () => {
    const res = mockRes();
    await updateProfile(
      makeReq({ name: "New Name", gender: "Female", email: "new@example.com" }),
      res
    );

    expect(res.statusCode).toBe(200);

    const saved = await User.findById(user._id);
    expect(saved.email).toBe("new@example.com");

    const lastEdit = saved.profileEdits[saved.profileEdits.length - 1];
    expect(lastEdit.changes.email).toEqual({
      from: "old@example.com",
      to: "new@example.com",
    });
  });

  test("empty-string email clears the saved email", async () => {
    const res = mockRes();
    await updateProfile(makeReq({ name: "Old Name", gender: "Male", email: "" }), res);

    expect(res.statusCode).toBe(200);
    const saved = await User.findById(user._id);
    expect(saved.email).toBe("");
  });

  test("still enforces the 3-edits-per-year limit", async () => {
    const now = new Date();
    user.profileEdits.push({ date: now }, { date: now }, { date: now });
    await user.save();

    const res = mockRes();
    await updateProfile(makeReq({ name: "Blocked", gender: "Male" }), res);

    expect(res.statusCode).toBe(429);
    const saved = await User.findById(user._id);
    expect(saved.name).toBe("Old Name");
  });
});

describe("updateProfileValidator email rules", () => {
  const base = { name: "Some Name", gender: "Male" };

  test("accepts a missing email", async () => {
    const { errors } = await runValidators({ ...base });
    expect(errors.isEmpty()).toBe(true);
  });

  test("accepts an empty-string email (clear)", async () => {
    const { errors } = await runValidators({ ...base, email: "" });
    expect(errors.isEmpty()).toBe(true);
  });

  test("accepts and trims a valid email", async () => {
    const { errors, body } = await runValidators({ ...base, email: " user@example.com " });
    expect(errors.isEmpty()).toBe(true);
    expect(body.email).toBe("user@example.com");
  });

  test("rejects a malformed email", async () => {
    const { errors } = await runValidators({ ...base, email: "not-an-email" });
    expect(errors.isEmpty()).toBe(false);
  });
});
