/*
=====================================================
ACK TIMEOUT SERVICE
Schedules a 2-minute acknowledgment window after a
booking is assigned. If the partner does not emit an
acknowledgeJob/acceptJob socket event within the
window, the system reassigns the booking.

DB-BASED ACK CHECK (no in-memory state)
The old approach stored acknowledged booking IDs in
a Set(). That Set is lost on process restart, causing
false reassignments for bookings acknowledged just
before the server went down.

The new approach queries the booking document:
  - booking.ackReceivedAt is set → already acknowledged
  - booking.status is terminal → skip reassignment
Server restarts are now safe.

DRIVERS
  BullMQ (recommended for multi-instance):
    Set ACKQ_DRIVER=bullmq, REDIS_URL=redis://...
  In-process setTimeout (default, single-instance):
    No extra env vars needed. Timers are lost on
    restart, but the DB check prevents false fires.
=====================================================
*/

const ACK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/* Statuses that mean the booking is already handled */
const TERMINAL_OR_ACCEPTED_STATUSES = new Set([
  "CONFIRMED",       // Auto-accepted — partner opted in, no manual ACK needed
  "PARTNER_ACCEPTED",
  "ON_THE_WAY",
  "ARRIVED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
]);

/*
=====================================================
TIMEOUT HANDLER — DB-based, no in-memory Set
=====================================================
*/
async function handleAckTimeout(bookingId, partnerId) {
  try {
    const Booking = require("../models/Booking");
    const booking = await Booking.findById(bookingId)
      .select("status ackReceivedAt")
      .lean();

    if (!booking) return;

    // Partner acknowledged via socket before timeout fired
    if (booking.ackReceivedAt) return;

    // Booking already progressed past the ACK gate
    if (TERMINAL_OR_ACCEPTED_STATUSES.has(booking.status)) return;

    console.warn(
      `[ack-timeout] Booking ${bookingId} unacknowledged by partner ${partnerId}. Triggering reassignment.`
    );

    const { reassignBooking } = require("./assignmentEngine");
    await reassignBooking(bookingId, partnerId, "TIMEOUT");
  } catch (err) {
    console.error("[ack-timeout] handleAckTimeout error:", err.message);
  }
}

/*
=====================================================
BULLMQ DRIVER (production, multi-instance)
=====================================================
*/
let bullQueue = null;
let bullWorker = null;

async function initBullMQ() {
  try {
    const { Queue, Worker } = require("bullmq");
    const IORedis = require("ioredis");
    const connection = new IORedis(
      process.env.REDIS_URL || "redis://localhost:6379",
      { maxRetriesPerRequest: null }
    );

    bullQueue = new Queue("ack-timeout", { connection });

    bullWorker = new Worker(
      "ack-timeout",
      async (job) => {
        const { bookingId, partnerId } = job.data;
        await handleAckTimeout(bookingId, partnerId);
      },
      { connection }
    );

    bullWorker.on("failed", (job, err) => {
      console.error(`[ack-timeout] BullMQ job ${job?.id} failed:`, err.message);
    });

    console.log("[ack-timeout] Initialised (BullMQ driver)");
    return true;
  } catch (err) {
    console.warn(
      "[ack-timeout] BullMQ unavailable, falling back to in-process driver:",
      err.message
    );
    return false;
  }
}

/*
=====================================================
IN-PROCESS DRIVER (development / single-instance)
Timers are lost on restart, but handleAckTimeout
queries the DB so a post-restart false fire is safe.
=====================================================
*/
const inProcessTimers = new Map();

function scheduleInProcess(bookingId, partnerId) {
  const key = String(bookingId);
  if (inProcessTimers.has(key)) clearTimeout(inProcessTimers.get(key));

  const timer = setTimeout(async () => {
    inProcessTimers.delete(key);
    await handleAckTimeout(bookingId, partnerId);
  }, ACK_TIMEOUT_MS);

  inProcessTimers.set(key, timer);
}

function cancelInProcess(bookingId) {
  const key = String(bookingId);
  if (inProcessTimers.has(key)) {
    clearTimeout(inProcessTimers.get(key));
    inProcessTimers.delete(key);
  }
}

/*
=====================================================
PUBLIC API
=====================================================
*/
let driverReady = false;
let useBullMQ = false;

async function init() {
  const driverEnv = (process.env.ACKQ_DRIVER || "").toLowerCase();
  if (driverEnv === "bullmq") {
    useBullMQ = await initBullMQ();
  }
  driverReady = true;
}

/**
 * Schedule a 2-minute ACK timeout after a booking is assigned.
 * @param {string|ObjectId} bookingId
 * @param {string|ObjectId} partnerId
 */
async function scheduleAckTimeout(bookingId, partnerId) {
  if (!driverReady) await init();

  const bid = String(bookingId);
  const pid = String(partnerId);

  if (useBullMQ && bullQueue) {
    await bullQueue.add(
      "ack-check",
      { bookingId: bid, partnerId: pid },
      { delay: ACK_TIMEOUT_MS, attempts: 1, removeOnComplete: true }
    );
  } else {
    scheduleInProcess(bid, pid);
  }
}

/**
 * Cancel a pending ACK timeout. Call this when the partner sends
 * acknowledgeJob or acceptJob. Set booking.ackReceivedAt in the DB
 * before calling this so restarts stay safe.
 * @param {string|ObjectId} bookingId
 */
async function cancelAckTimeout(bookingId) {
  const bid = String(bookingId);

  if (useBullMQ && bullQueue) {
    try {
      const delayed = await bullQueue.getDelayed();
      for (const job of delayed) {
        if (job.data?.bookingId === bid) {
          await job.remove();
          break;
        }
      }
    } catch {
      // Non-fatal — DB ackReceivedAt is the canonical safety net
    }
  } else {
    cancelInProcess(bid);
  }
}

// Initialise on first import
init().catch((err) =>
  console.error("[ack-timeout] Init error:", err.message)
);

module.exports = {
  scheduleAckTimeout,
  cancelAckTimeout,
};
