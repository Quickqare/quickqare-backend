const router = require("express").Router();
const Job = require("../models/Job");
const dispatchJob = require("../services/dispatcher.service");
const ServiceMan = require("../models/ServiceMan");

/* Create Job */
router.post("/create", async (req, res) => {
  const job = await Job.create(req.body);
  dispatchJob(job);
  res.json(job);
});

/* Accept Job */
router.post("/accept", async (req, res) => {
  const { jobId, serviceManId } = req.body;

  const job = await Job.findById(jobId);
  if (!job || job.status !== "SEARCHING") {
    return res.status(400).json({ error: "Job already assigned" });
  }

  job.status = "ASSIGNED";
  job.assignedTo = serviceManId;
  await job.save();

  await ServiceMan.findByIdAndUpdate(serviceManId, {
    $inc: { remainingJobs: -1 },
  });

  res.json({ success: true });
});

/* Reject Job */
router.post("/reject", async (req, res) => {
  res.json({ success: true });
});

module.exports = router;
