/**
 * Admin partner/customer detail screens hand out SIGNED links for private
 * uploads (partner selfie, job-spot selfies) when R2_PRIVATE_UPLOADS is on —
 * never the stored public URL, which would show a broken image once the
 * sensitive prefixes are made private (and leak them while they're not).
 */
Object.assign(process.env, {
  R2_ACCOUNT_ID: "testaccount",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET_NAME: "test-bucket",
  R2_PUBLIC_URL: "https://media.quickqare.test",
  R2_PRIVATE_UPLOADS: "true",
  JWT_SECRET: "test-jwt-secret",
  ADMIN_JWT_ACCESS_SECRET: "test-admin-access-secret",
  ADMIN_JWT_REFRESH_SECRET: "test-admin-refresh-secret",
  RESEND_API_KEY: "re_test",
});

jest.mock("../admin/services/email.service", () => ({
  sendAdminTwoFaCode: jest.fn().mockResolvedValue(undefined),
  sendOpsAlertEmail: jest.fn().mockResolvedValue(undefined),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const AdminUser = require("../admin/models/AdminUser");
const AdminSession = require("../admin/models/AdminSession");
const Partner = require("../models/Partner");
const User = require("../models/User");
const Booking = require("../models/Booking");

const PUBLIC = "https://media.quickqare.test";
let server;
let url;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", require("../admin/routes/v1"));
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${server.address().port}/api/v1/admin`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

async function superAdminToken() {
  const admin = await AdminUser.create({
    name: "Root",
    email: "root@example.com",
    passwordHash: "x",
    role: "SuperAdmin",
    isActive: true,
  });
  const session = await AdminSession.create({
    adminUserId: admin._id,
    refreshExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return jwt.sign(
    { type: "access", sub: String(admin._id), role: "SuperAdmin", sid: String(session._id) },
    process.env.ADMIN_JWT_ACCESS_SECRET,
    { expiresIn: 3600 }
  );
}

const get = (path, token) =>
  fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

const isSigned = (u) =>
  typeof u === "string" && u.startsWith(`${PUBLIC}/`) === false && /X-Amz-Signature=/.test(u);

async function seed() {
  const partner = await Partner.create({
    name: "Ravi",
    phone: "9876500001",
    password: "Secret123",
    selfieUrl: `${PUBLIC}/selfies/1_abc.jpg`,
  });
  const user = await User.create({ name: "Asha", phone: "9876500101" });
  await Booking.create({
    user: user._id,
    partner: partner._id,
    services: [
      {
        serviceId: new mongoose.Types.ObjectId(),
        name: "Facial",
        quantity: 1,
        price: 500,
        lineTotal: 500,
      },
    ],
    baseAmount: 500,
    totalAmount: 590,
    scheduledDate: new Date(),
    scheduledTime: "10:00 AM",
    pincode: "700016",
    address: "12 Park Street",
    location: { type: "Point", coordinates: [88.3525, 22.5526] },
    status: "COMPLETED",
    startSelfieUrl: `${PUBLIC}/job-selfies/2_def.jpg`,
  });
  return { partner, user };
}

test("GET /partners/:id signs the partner selfie and job-spot selfies", async () => {
  const token = await superAdminToken();
  const { partner } = await seed();

  const res = await get(`/partners/${partner._id}`, token);

  expect(res.status).toBe(200);
  expect(isSigned(res.body.data.selfieUrl)).toBe(true);
  expect(res.body.data.recentBookings).toHaveLength(1);
  expect(isSigned(res.body.data.recentBookings[0].startSelfieUrl)).toBe(true);
});

test("GET /customers/:id signs job-spot selfies on the customer's bookings", async () => {
  const token = await superAdminToken();
  const { user } = await seed();

  const res = await get(`/customers/${user._id}`, token);

  expect(res.status).toBe(200);
  expect(res.body.data.bookings).toHaveLength(1);
  expect(isSigned(res.body.data.bookings[0].startSelfieUrl)).toBe(true);
});
