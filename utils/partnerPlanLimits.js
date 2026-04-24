module.exports.getCancelLimit = (plan) => {
  switch (plan) {
    case "elite":
      return 3;
    case "pro":
      return 2;
    case "basic":
    default:
      return 0;
  }
};
