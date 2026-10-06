/**
 * Partner duty crons (auto-accept stays; the system makes sure partners know
 * their jobs and notices early when one is about to be missed):
 *   - tomorrow's advance bookings are assigned from 19:00 (evening before);
 *   - the stale-booking cleanup no longer cancels QUEUED advance bookings;
 *   - no-show detection covers auto-accepted (CONFIRMED) jobs;
 *   - 20:00 "Tomorrow" and 07:00 "Today" summaries, once per day;
 *   - day-of checks: T-60 not seen, T-15 leave nudge, T+20 late;
 *   - inactivity pause; nightly reset of the urgent-jobs switch; expired
 *     suspensions lift by themselves.
 */
jest.mock("../services/pushNotification.service", () => ({
  JOB_ALERTS_CHANNEL: "job_alerts",
  sendPartnerPush: jest.fn().mockResolvedValue(undefined),
  notifyPartner: jest.fn(),
  notifyCustomerOfBookingStatus: jest.fn(),
  sendJobAssignedPush: jest.fn(),
  sendJobCancelledPush: jest.fn(),
  sendPushNotification: jest.fn(),
}));
jest.mock("../services/assignmentEngine", () => ({
  assignBooking: jest.fn().mockResolvedValue(null),
  reassignBooking: jest.fn().mockResolvedValue(undefined),
  getUseH3Flag: jest.fn().mockResolvedValue(false),
  isACBooking: jest.fn(() => false),
  computeRequiredPartners: jest.fn(),
}));

const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Partner = require("../models/Partner");
const BookingTimeline = require("../admin/models/BookingTimeline");
const push = require("../services/pushNotification.service");
const { assignBooking } = require("../services/assignmentEngine");
const {
  dispatchQueuedBookings,
  cancelStaleBookings,
  detectNoShowPartners,
} = require("../services/cron.service");
const duty = require("../services/partnerDuty.service");

const HOUR = 60 * 60 * 1000;
// Test clock: days relative to 10 Oct 2026, local time.
const at = (day, hour, minute = 0) => new Date(2026, 9, 10 + day, hour, minute);

let seq = 0;
function makePartner(overrides = {}) {
  seq += 1;
  return Partner.create({
    name: `Partner ${seq}`,
    phone: `98760${String(seq).padStart(5, "0")}`,
    password: "Secret123",
    approvalStatus: "APPROVED",
    fcmToken: `token-${seq}`,
    ...overrides,
  });
}

function makeBooking(partner, start, overrides = {}) {
  return Booking.create({
    user: new mongoose.Types.ObjectId(),
    services: [{ serviceId: new mongoose.Types.ObjectId(), name: "Facial", quantity: 1, price: 500, lineTotal: 500 }],
    serviceCategory: "Salon for Women",
    baseAmount: 500,
    totalAmount: 590,
    scheduledDate: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
    scheduledTime: start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    scheduledStartAt: start,
    location: { type: "Point", coordinates: [88.36, 22.57] },
    pincode: "700016",
    address: "12 Park Street",
    payment: { status: "PAID" },
    partner: partner ? partner._id : null,
    status: "CONFIRMED",
    assignedAt: new Date(start.getTime() - 20 * HOUR),
    ...overrides,
  });
}

const timelineOf = async (bookingId) =>
  (await BookingTimeline.find({ bookingId }).sort({ createdAt: 1 }).lean()).map((t) => t.eventType);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("evening-before dispatch", () => {
  test("from 19:00, tomorrow's QUEUED bookings are assigned; later days wait", async () => {
    const tomorrow = await makeBooking(null, at(1, 10), { status: "QUEUED", assignedAt: null });
    const dayAfter = await makeBooking(null, at(2, 10), { status: "QUEUED", assignedAt: null });

    await dispatchQueuedBookings(at(0, 19, 30));

    expect(assignBooking).toHaveBeenCalledTimes(1);
    expect(String(assignBooking.mock.calls[0][0])).toBe(String(tomorrow._id));
    expect((await Booking.findById(tomorrow._id).lean()).status).toBe("SEARCHING");
    expect((await Booking.findById(dayAfter._id).lean()).status).toBe("QUEUED");
  });

  test("before 19:00 tomorrow's bookings are not dispatched yet", async () => {
    await makeBooking(null, at(1, 10), { status: "QUEUED", assignedAt: null });

    await dispatchQueuedBookings(at(0, 15));

    expect(assignBooking).not.toHaveBeenCalled();
  });
});

describe("stale-booking cleanup", () => {
  test("a QUEUED advance booking isn't cancelled while it waits; one past its start is", async () => {
    const now = new Date();
    const advance = await makeBooking(null, new Date(now.getTime() + 5 * 24 * HOUR), {
      status: "QUEUED",
      assignedAt: null,
    });
    const missed = await makeBooking(null, new Date(now.getTime() - 2 * HOUR), {
      status: "QUEUED",
      assignedAt: null,
    });
    // Neither touched for 3 days.
    await Booking.collection.updateMany({}, { $set: { updatedAt: new Date(now.getTime() - 72 * HOUR) } });

    await cancelStaleBookings(now);

    expect((await Booking.findById(advance._id).lean()).status).toBe("QUEUED");
    const cancelled = await Booking.findById(missed._id).lean();
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.refundStatus).toBe("PENDING");
  });
});

describe("no-show detection covers auto-accepted jobs", () => {
  test("a CONFIRMED job 2h+ past its start moves to rescheduling with a strike", async () => {
    const partner = await makePartner();
    const booking = await makeBooking(partner, at(0, 10));

    await detectNoShowPartners(at(0, 12, 30));

    expect((await Booking.findById(booking._id).lean()).status).toBe("NEEDS_RESCHEDULING");
    const fresh = await Partner.findById(partner._id).lean();
    expect(fresh.noShowCount).toBe(1);
    expect(fresh.weeklyCancelCount).toBe(1);
    expect(push.notifyCustomerOfBookingStatus).toHaveBeenCalledTimes(1);
    expect(push.notifyCustomerOfBookingStatus.mock.calls[0][1]).toBe("NEEDS_RESCHEDULING");
    expect(await timelineOf(booking._id)).toEqual(["PARTNER_NO_SHOW"]);
  });

  test("a CONFIRMED job only 1h past its start is left alone", async () => {
    const booking = await makeBooking(await makePartner(), at(0, 10));

    await detectNoShowPartners(at(0, 11));

    expect((await Booking.findById(booking._id).lean()).status).toBe("CONFIRMED");
  });
});

describe("job summaries", () => {
  test("20:00 — one 'Tomorrow' summary per partner, starting with their first job", async () => {
    const ravi = await makePartner();
    const noToken = await makePartner({ fcmToken: "" });
    await makeBooking(ravi, at(1, 14));
    await makeBooking(ravi, at(1, 10));
    await makeBooking(noToken, at(1, 11));
    await makeBooking(ravi, at(2, 10)); // day after tomorrow — not in this summary

    expect(await duty.sendEveningSummaries(at(0, 20, 15))).toBe(1);
    const [token, message] = push.sendPartnerPush.mock.calls[0];
    expect(token).toBe(ravi.fcmToken);
    expect(message.title).toBe("Tomorrow: 2 jobs");
    expect(message.body).toBe("First at 10:00 AM — Facial. Open the app to see your schedule.");

    // A later run the same evening doesn't repeat it.
    expect(await duty.sendEveningSummaries(at(0, 21))).toBe(0);
  });

  test("no evening summary before 20:00 or during quiet hours", async () => {
    await makeBooking(await makePartner(), at(1, 10));

    expect(await duty.sendEveningSummaries(at(0, 18))).toBe(0);
    expect(await duty.sendEveningSummaries(at(0, 22, 30))).toBe(0);
    expect(push.sendPartnerPush).not.toHaveBeenCalled();
  });

  test("07:00 — 'Today' summary counts jobs assigned overnight", async () => {
    const ravi = await makePartner();
    await makeBooking(ravi, at(1, 10), { assignedAt: at(0, 23, 30) }); // assigned in quiet hours
    await makeBooking(ravi, at(1, 15), { assignedAt: at(0, 12) });

    expect(await duty.sendMorningSummaries(at(1, 7, 10))).toBe(1);
    const [, message] = push.sendPartnerPush.mock.calls[0];
    expect(message.title).toBe("Today: 2 jobs");
    expect(message.body).toBe("First at 10:00 AM — Facial. 1 new since last night.");
  });
});

describe("day-of checks", () => {
  test("T-60: not seen → urgent alert + team alert, once", async () => {
    const partner = await makePartner({ seenSignalAt: at(-1, 9) });
    const booking = await makeBooking(partner, at(0, 10));

    expect(await duty.checkUnseenJobs(at(0, 9, 10))).toBe(1);
    const [token, message] = push.sendPartnerPush.mock.calls[0];
    expect(token).toBe(partner.fcmToken);
    expect(message.type).toBe("JOB_UNSEEN_ALERT");
    expect(message.loud).toBe(true);
    expect(await timelineOf(booking._id)).toEqual(["PARTNER_NOT_SEEN"]);

    expect(await duty.checkUnseenJobs(at(0, 9, 20))).toBe(0);
  });

  test("T-60: no alert when the job was seen, or the partner's app can't report 'seen'", async () => {
    const seenPartner = await makePartner({ seenSignalAt: at(-1, 9) });
    const oldAppPartner = await makePartner(); // older app build: never sent the signal
    const seenJob = await makeBooking(seenPartner, at(0, 10));
    await makeBooking(oldAppPartner, at(0, 10));
    await duty.markJobsSeen(seenPartner._id, [seenJob._id], at(0, 8));

    expect(await duty.checkUnseenJobs(at(0, 9, 10))).toBe(0);
    expect(push.sendPartnerPush).not.toHaveBeenCalled();
  });

  test("T-15: 'time to leave' nudge when nobody is on the way", async () => {
    const partner = await makePartner();
    await makeBooking(partner, at(0, 10));
    await makeBooking(partner, at(0, 12)); // not yet
    await makeBooking(await makePartner(), at(0, 10), { status: "ON_THE_WAY" });

    expect(await duty.nudgeLeaveTime(at(0, 9, 50))).toBe(1);
    expect(push.sendPartnerPush.mock.calls[0][1].type).toBe("JOB_LEAVE_NUDGE");
  });

  test("T+20: start passed and nobody on the way → partner + team alert, once", async () => {
    const partner = await makePartner();
    const booking = await makeBooking(partner, at(0, 10));
    await makeBooking(await makePartner(), at(0, 10), { status: "ON_THE_WAY" });

    expect(await duty.alertLateStarts(at(0, 10, 25))).toBe(1);
    const [, message] = push.sendPartnerPush.mock.calls[0];
    expect(message.type).toBe("JOB_LATE_ALERT");
    expect(message.loud).toBe(true);
    expect(await timelineOf(booking._id)).toEqual(["PARTNER_LATE"]);

    expect(await duty.alertLateStarts(at(0, 10, 40))).toBe(0);
  });
});

describe("inactivity pause", () => {
  test("3+ days without opening the app → paused, told, and the team hears about their jobs", async () => {
    const now = at(0, 11);
    const idle = await makePartner({ lastActiveAt: at(-5, 10), lastOnlineAt: at(-5, 10) });
    const active = await makePartner({ lastActiveAt: at(-1, 10) });
    const job = await makeBooking(idle, at(1, 10));

    expect(await duty.pauseInactivePartners(now)).toBe(1);

    const paused = await Partner.findById(idle._id).lean();
    expect(paused.inactivePausedAt).toEqual(now);
    expect(paused.inactivePauseReason).toBe("INACTIVE");
    expect((await Partner.findById(active._id).lean()).inactivePausedAt).toBeNull();
    expect(push.sendPartnerPush.mock.calls[0][1].type).toBe("ACCOUNT_PAUSED");
    expect(await timelineOf(job._id)).toEqual(["PARTNER_PAUSED"]);
  });

  test("no pausing during quiet hours", async () => {
    await makePartner({ lastActiveAt: at(-5, 10), lastOnlineAt: at(-5, 10) });

    expect(await duty.pauseInactivePartners(at(0, 23))).toBe(0);
  });
});

describe("urgent-jobs switch and suspensions", () => {
  test("the night reset switches urgent jobs off; a daytime run leaves them on", async () => {
    const partner = await makePartner({ isOnline: true });

    expect(await duty.resetUrgentAvailabilityAtNight(at(0, 14))).toBe(0);
    expect((await Partner.findById(partner._id).lean()).isOnline).toBe(true);

    expect(await duty.resetUrgentAvailabilityAtNight(at(0, 22, 30))).toBe(1);
    expect((await Partner.findById(partner._id).lean()).isOnline).toBe(false);
  });

  test("an expired strike suspension lifts by itself", async () => {
    const due = await makePartner({ isAvailable: false, suspendedUntil: at(-1, 10) });
    const running = await makePartner({ isAvailable: false, suspendedUntil: at(2, 10) });

    expect(await duty.liftExpiredSuspensions(at(0, 12))).toBe(1);

    const lifted = await Partner.findById(due._id).lean();
    expect(lifted.isAvailable).toBe(true);
    expect(lifted.suspendedUntil).toBeNull();
    expect((await Partner.findById(running._id).lean()).isAvailable).toBe(false);
  });
});
