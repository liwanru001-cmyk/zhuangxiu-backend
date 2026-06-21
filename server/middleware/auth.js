const jwt = require('jsonwebtoken');
const db = require('../config/db');

module.exports = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ code: 401, message: '未登录' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [rows] = await db.query(
      'SELECT id, phone, nickname, avatar, city, role FROM users WHERE id = ?',
      [decoded.userId]
    );
    if (!rows[0]) return res.status(401).json({ code: 401, message: '用户不存在' });
    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ code: 401, message: '登录已过期' });
  }
};
