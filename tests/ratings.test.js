/**
 * Partner / service rating summaries.
 *
 * `rating` must be the average of every rating the partner (and service) has
 * received, with `totalReviews` counting them. It used to be recomputed as
 * (oldAvg * totalReviews + new) / (totalReviews + 1) with totalReviews missing
 * from both schemas — so the count was always 0 and each review replaced the
 * whole average.
 */
const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const Rating = require("../models/Rating");
const Service = require("../models/service.model");
const User = require("../models/User");
const { submitRating } = require("../controllers/rating.controller");

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

let customer;
let partner;
let service;

beforeEach(async () => {
  customer = await User.create({ phone: "9000000001", name: "Customer" });
  partner = await Partner.create({ name: "Partner", phone: "9000000002", password: "Secret123" });
  service = await Service.create({ name: "Facial", price: 500 });
});

const completedBooking = () =>
  Booking.create({
    user: customer._id,
    partner: partner._id,
    primaryService: service._id,
    baseAmount: 500,
    totalAmount: 500,
    scheduledDate: new Date("2026-07-01T00:00:00.000Z"),
    scheduledTime: "10:00 AM",
    location: { type: "Point", coordinates: [77.59, 12.97] },
    pincode: "560001",
    status: "COMPLETED",
  });

async function rate(value) {
  const booking = await completedBooking();
  const res = mockRes();
  await submitRating({ body: { bookingId: booking._id, rating: value }, user: { id: customer._id } }, res);
  expect(res.statusCode).toBe(201);
}

const summaryOf = async (Model, id) => {
  const { rating, totalReviews } = await Model.findById(id).lean();
  return { rating, totalReviews };
};

test("a partner's rating averages every review instead of taking the latest", async () => {
  await rate(5);
  await rate(5);
  await rate(1);

  expect(await summaryOf(Partner, partner._id)).toEqual({ rating: 3.67, totalReviews: 3 });
  expect(await summaryOf(Service, service._id)).toEqual({ rating: 3.67, totalReviews: 3 });
});

test("ratings submitted at the same time are all counted", async () => {
  const values = [5, 4, 3, 5, 2, 4, 1, 5];
  await Promise.all(values.map(rate));

  const average = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
  expect(await summaryOf(Partner, partner._id)).toEqual({ rating: average, totalReviews: values.length });
  expect(await summaryOf(Service, service._id)).toEqual({ rating: average, totalReviews: values.length });
});

test("a summary left wrong by the old code is corrected by the next rating", async () => {
  // Two earlier reviews (5 and 4) whose partner summary was overwritten.
  for (const value of [5, 4]) {
    const booking = await completedBooking();
    await Rating.create({
      bookingId: booking._id,
      partnerId: partner._id,
      serviceId: service._id,
      customerId: customer._id,
      rating: value,
    });
  }
  await Partner.collection.updateOne({ _id: partner._id }, { $set: { rating: 4 }, $unset: { totalReviews: "" } });

  await rate(3);

  expect(await summaryOf(Partner, partner._id)).toEqual({ rating: 4, totalReviews: 3 });
});

test("an unrated partner keeps the default, and ineligible ratings change nothing", async () => {
  expect(await summaryOf(Partner, partner._id)).toEqual({ rating: 5, totalReviews: 0 });

  const booking = await completedBooking();
  await Booking.updateOne({ _id: booking._id }, { $set: { status: "CANCELLED" } });
  const res = mockRes();
  await submitRating({ body: { bookingId: booking._id, rating: 1 }, user: { id: customer._id } }, res);

  expect(res.statusCode).toBe(400);
  expect(await summaryOf(Partner, partner._id)).toEqual({ rating: 5, totalReviews: 0 });
  expect(await Rating.countDocuments({ partnerId: partner._id })).toBe(0);
});

test("rating the same booking twice is rejected and counted once", async () => {
  const booking = await completedBooking();
  const submit = () => {
    const res = mockRes();
    return submitRating(
      { body: { bookingId: booking._id, rating: 2 }, user: { id: customer._id } },
      res
    ).then(() => res);
  };

  expect((await submit()).statusCode).toBe(201);
  expect((await submit()).statusCode).toBe(400);
  expect(await summaryOf(Partner, partner._id)).toEqual({ rating: 2, totalReviews: 1 });
});
