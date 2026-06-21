const jwt = require('jsonwebtoken');
const db = require('../config/db');

module.exports = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return next();

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [rows] = await db.query(
      'SELECT id, phone, nickname, avatar, city, role FROM users WHERE id = ?',
      [decoded.userId]
    );
    if (rows[0]) req.user = rows[0];
  } catch (_) {
    // Public endpoints should still work when an optional token is absent or stale.
  }
  return next();
};
