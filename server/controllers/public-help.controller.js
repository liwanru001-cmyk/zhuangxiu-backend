const db = require('../config/db');
const { success } = require('../utils/response');

async function listHelpFaqs(_req, res) {
  const [rows] = await db.query(
    `SELECT id, question, answer, updated_at
     FROM help_faqs
     WHERE is_active = 1
     ORDER BY sort_order ASC, id ASC
     LIMIT 10`
  );
  return success(res, { faqs: rows });
}

module.exports = { listHelpFaqs };
