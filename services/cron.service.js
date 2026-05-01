function initCronJobs() {
  // Cron jobs are optional in local/dev boot.
  // Keep this as a safe no-op so the server can start
  // even when scheduled jobs are not configured yet.
  if (process.env.NODE_ENV !== "test") {
    console.log("[cron] initCronJobs skipped (no cron scheduler configured)");
  }
}

module.exports = {
  initCronJobs,
};

