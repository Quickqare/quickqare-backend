/*
=====================================================
ACK TIMEOUT SERVICE
Schedules a 2-minute acknowledgment window for
auto-accepted bookings. If the partner does not
emit an ACK event within the window, the system
automatically reassigns the booking and penalises
the partner's reliability score.

DEPENDENCY OPTIONS (pick one):
  Option A — BullMQ (recommended for production)
    npm install bullmq ioredis
  Option B — In-process setTimeout (simpler, no Redis)
    Use ACKQ_DRIVER=memory in env (or no BullMQ installed)

Set env: ACKQ_DRIVER=bullmq | memory
         REDIS_URL=redis://localhost:6379 (for bullmq)
=====================================================
*/

const ACK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/*
=====================================================
ACKNOWLEDGED BOOKING REGISTRY
Tracks which bookings have been ACK'd so the
timeout job can skip them if the partner tapped
on time.
=====================================================
*/
const acknowledgedBookings = new Set();

function markAcknowledged(bookingId) {
  acknowledgedBookings.add(String(bookingId));
}

function isAcknowledged(bookingId) {
  return acknowledgedBookings.has(String(bookingId));
}

/*
=====================================================
TIMEOUT HANDLER
Called when the ACK window expires.
=====================================================
*/
async function handleAckTimeout(bookingId, partnerId) {
  try {
    if (isAcknowledged(bookingId)) {
      // Partner tapped "Acknowledge" in time — nothing to do.
      acknowledgedBookings.delete(bookingId);
      return;
    }

    console.warn(
      `ACK timeout: booking ${bookingId} unacknowledged by partner ${partnerId}. Triggering reassignment.`
    );

    const { reassignBooking } = require("./assignmentEngine");
    await reassignBooking(bookingId, partnerId);
  } catch (err) {
    console.error("ACK timeout handler error:", err);
  }
}

/*
=====================================================
BULLMQ DRIVER (production)
Uses Redis-backed queue for reliability across
restarts and multiple server instances.
=====================================================
*/
let bullQueue = null;
let bullWorker = null;

async function initBullMQ() {
  try {
    const { Queue, Worker } = require("bullmq");
    const IORedis = require("ioredis");
    const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: null,
    });

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
      console.error(`ACK timeout job ${job?.id} failed:`, err.message);
    });

    console.log("ACK timeout service initialised (BullMQ driver)");
    return true;
  } catch (err) {
    console.warn(
      "BullMQ not available, falling back to in-process timeout driver:",
      err.message
    );
    return false;
  }
}

/*
=====================================================
IN-PROCESS DRIVER (development / fallback)
Simple setTimeout — works without Redis.
Not suitable for multi-instance deployments.
=====================================================
*/
const inProcessTimers = new Map();

function scheduleInProcess(bookingId, partnerId) {
  const key = String(bookingId);
  // Clear any existing timer for this booking (idempotent)
  if (inProcessTimers.has(key)) {
    clearTimeout(inProcessTimers.get(key));
  }
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
  if (driverEnv === "bullmq" || driverEnv === "") {
    useBullMQ = await initBullMQ();
  }
  driverReady = true;
}

/**
 * Schedule a 2-minute ACK timeout for an auto-accepted booking.
 * If the partner acknowledges via socket before expiry, call cancelAckTimeout().
 *
 * @param {string|ObjectId} bookingId
 * @param {string|ObjectId} partnerId
 */
async function scheduleAckTimeout(bookingId, partnerId) {
  if (!driverReady) await init();

  const bid = String(bookingId);
  const pid = String(partnerId);

  if (useBullMQ && bullQueue) {
    // BullMQ: delay = 2 minutes, no retries (one-shot)
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
 * Cancel a pending ACK timeout (partner tapped "Acknowledge" in time).
 * Call this from your Socket.io ACK event handler.
 *
 * @param {string|ObjectId} bookingId
 */
async function cancelAckTimeout(bookingId) {
  const bid = String(bookingId);
  markAcknowledged(bid);

  if (useBullMQ && bullQueue) {
    // BullMQ jobs can't easily be removed by payload; the acknowledged flag
    // in handleAckTimeout() is the canonical cancellation mechanism.
    // For completeness, attempt to drain jobs with matching data (best effort).
    try {
      const delayed = await bullQueue.getDelayed();
      for (const job of delayed) {
        if (job.data?.bookingId === bid) {
          await job.remove();
          break;
        }
      }
    } catch {
      // Non-fatal — the acknowledged flag will prevent action on expiry.
    }
  } else {
    cancelInProcess(bid);
  }
}

// Initialise on first import
init().catch((err) =>
  console.error("ACK timeout service init error:", err.message)
);

module.exports = {
  scheduleAckTimeout,
  cancelAckTimeout,
  markAcknowledged,
};
