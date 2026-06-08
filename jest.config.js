/**
 * Jest config — runs the backend test suite against an in-memory MongoDB.
 * No real database or network is touched.
 */
module.exports = {
  testEnvironment: "node",
  setupFilesAfterEnv: ["<rootDir>/tests/setup.js"],
  testMatch: ["<rootDir>/tests/**/*.test.js"],
  testTimeout: 60000,
  // The in-memory Mongo download/boot can be slow on first run.
  forceExit: true,
};
