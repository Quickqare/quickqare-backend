/**
 * New-job alerts:
 *   - ring on the loud "job_alerts" Android channel during the day;
 *   - are held back during quiet hours (22:00–07:00) — the 07:00 morning
 *     summary announces jobs assigned overnight;
 *   - a dead push token (app removed) pauses the partner's new jobs and tells
 *     the team about upcoming jobs they still hold.
 */
const mockSend = jest.fn().mockResolvedValue("message-id");
jest.mock("../config/firebase", () => ({
  apps: [{}],
  messaging: () => ({ send: (...args) => mockSend(...args) }),
}));

const mongoose = require("mongoose");
const Partner = require("../models/Partner");
const Booking = require("../models/Booking");
const BookingTimeline = require("../admin/models/BookingTimeline");
const {
  sendJobAssignedPush,
  sendPartnerPush,
  JOB_ALERTS_CHANNEL,
} = require("../services/pushNotification.service");
const { isQuietHours } = require("../utils/partnerHours");

const at = (hour, minute = 0) => new Date(2026, 9, 5, hour, minute);

beforeEach(() => mockSend.mockClear());

test("quiet hours are 22:00–07:00 local time", () => {
  expect(isQuietHours(at(21, 59))).toBe(false);
  expect(isQuietHours(at(22, 0))).toBe(true);
  expect(isQuietHours(at(3, 0))).toBe(true);
  expect(isQuietHours(at(6, 59))).toBe(true);
  expect(isQuietHours(at(7, 0))).toBe(false);
});

test("a new-job alert rings on the job-alerts channel during the day", async () => {
  await sendJobAssignedPush("token-1", "booking-1", { now: at(10) });

  expect(mockSend).toHaveBeenCalledTimes(1);
  const message = mockSend.mock.calls[0][0];
  expect(message.android.notification.channelId).toBe(JOB_ALERTS_CHANNEL);
  expect(message.android.priority).toBe("high");
  expect(message.data).toEqual({ type: "JOB_ASSIGNED", bookingId: "booking-1" });
});

test("a new-job alert is held back at night", async () => {
  await sendJobAssignedPush("token-1", "booking-1", { now: at(23, 30) });
  await sendJobAssignedPush("token-1", "booking-1", { now: at(6, 30) });

  expect(mockSend).not.toHaveBeenCalled();
});

test("only loud partner alerts use the job-alerts channel", async () => {
  await sendPartnerPush("token-1", { type: "JOB_SUMMARY", title: "Today: 2 jobs", body: "…" });
  await sendPartnerPush("token-1", { type: "JOB_LATE_ALERT", title: "Late", body: "…", loud: true });

  expect(mockSend.mock.calls[0][0].android.notification).toBeUndefined();
  expect(mockSend.mock.calls[1][0].android.notification.channelId).toBe(JOB_ALERTS_CHANNEL);
});

test("a dead push token pauses the partner and flags their upcoming jobs to the team", async () => {
  const partner = await Partner.create({
    name: "Ravi",
    phone: "9876500301",
    password: "Secret123",
    approvalStatus: "APPROVED",
    fcmToken: "dead-token",
  });
  const start = new Date(Date.now() + 26 * 60 * 60 * 1000);
  const job = await Booking.create({
    user: new mongoose.Types.ObjectId(),
    services: [{ serviceId: new mongoose.Types.ObjectId(), name: "AC Service", quantity: 1, price: 500, lineTotal: 500 }],
    baseAmount: 500,
    totalAmount: 590,
    scheduledDate: start,
    scheduledTime: "10:00 AM",
    scheduledStartAt: start,
    location: { type: "Point", coordinates: [88.36, 22.57] },
    pincode: "700016",
    partner: partner._id,
    status: "CONFIRMED",
  });

  mockSend.mockRejectedValueOnce(
    Object.assign(new Error("Requested entity was not found."), {
      code: "messaging/registration-token-not-registered",
    })
  );
  await sendPartnerPush("dead-token", { type: "JOB_SUMMARY", title: "x", body: "y" });

  const fresh = await Partner.findById(partner._id).lean();
  expect(fresh.fcmToken).toBe("");
  expect(fresh.inactivePausedAt).toBeInstanceOf(Date);
  expect(fresh.inactivePauseReason).toBe("APP_REMOVED");

  const timeline = await BookingTimeline.find({ bookingId: job._id }).lean();
  expect(timeline.map((t) => t.eventType)).toEqual(["PARTNER_PAUSED"]);
});
