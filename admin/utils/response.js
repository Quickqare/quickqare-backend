const success = (res, data, meta = {}) => {
  return res.json({
    success: true,
    data,
    error: null,
    meta,
  });
};

const fail = (res, statusCode, code, message, details = null, meta = {}) => {
  return res.status(statusCode).json({
    success: false,
    data: null,
    error: { code, message, details },
    meta,
  });
};

module.exports = { success, fail };
