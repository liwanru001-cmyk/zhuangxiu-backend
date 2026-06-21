module.exports = {
  success: (res, data = null, message = 'success', code = 200) => {
    return res.status(code).json({ code, message, data });
  },
  error: (res, message = 'error', code = 400, data = null) => {
    return res.status(code).json({ code, message, data });
  },
};
