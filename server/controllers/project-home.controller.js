'use strict';

const db = require('../config/db');
const renovation = require('./renovation.controller');
const { success } = require('../utils/response');

// Reuse the existing read endpoints' role checks and media URL handling.
async function read(handler, req) {
  let status = 200;
  let payload;
  await handler(req, {
    status(value) { status = value; return this; },
    json(value) { payload = value; return value; },
  });
  if (status !== 200 || !payload) {
    const failure = new Error(payload?.message || '读取失败');
    failure.status = status;
    throw failure;
  }
  return payload.data;
}

function createHomeController(handlers = renovation, database = db) {
  return async function home(req, res) {
    // Authorize before reading any project subresource.
    let calendar;
    try { calendar = await read(handlers.getProjectDetail, req); }
    catch (e) {
      if (e.status) return res.status(e.status).json({ code: e.status, message: e.message, data: null });
      throw e;
    }
    const id = Number(req.params.id);
    const unavailable = [];
    const section = async (key, load) => {
      try { return await load(); }
      catch (_) { unavailable.push(key); return null; }
    };
    const [members, todos, documents, handovers, materials, spaces, productCount, covers] = await Promise.all([
      section('members', () => read(handlers.getProjectMembers, req)),
      section('todos', () => read(handlers.getProjectTodos, req)),
      section('documents', () => read(handlers.getProjectDesignDocuments, req)),
      section('handovers', () => read(handlers.getProjectHandovers, req)),
      section('materials', () => read(handlers.getProjectMaterials, req)),
      section('spaces', async () => {
        // Unlike getProjectSpaces, the homepage must not initialize default spaces.
        const [rows] = await database.query(
          'SELECT id, project_id, name, sort_order, is_default, main_design_document_id FROM project_spaces WHERE project_id = ? ORDER BY sort_order, id',
          [id]
        );
        return rows;
      }),
      section('products', async () => {
        const [[row]] = await database.query('SELECT COUNT(*) AS total FROM project_scheme_products p JOIN project_design_schemes s ON s.id=p.scheme_id AND s.version_no=1 WHERE p.project_id=?', [id]);
        return Number(row.total);
      }),
      section('cover', async () => {
        // Private showcase covers are only visible to their owner.
        const [rows] = await database.query("SELECT cover_image FROM project_showcases WHERE project_id=? AND (owner_user_id=? OR (visibility IN ('participants','public') AND status='published')) ORDER BY id DESC LIMIT 1", [id, req.user.id]);
        return rows;
      }),
    ]);
    const selectableMainDocument = (document, space) => document
      && Number(document.id) === Number(space.main_design_document_id)
      && String(document.space_key) === String(space.id)
      && document.is_current !== false
      && Number(document.is_current ?? 1) === 1
      && !['voided', 'archived', 'superseded'].includes(String(document.status))
      && (document.file_type === 'image' || String(document.mime_type || '').startsWith('image/'))
      && String(document.file_url || '').trim() !== '';
    const homeSpaces = spaces?.map(space => {
      const document = documents?.find(item => selectableMainDocument(item, space));
      const imageUrl = document && (document.preview_url || document.file_url);
      return {
        ...space,
        images: imageUrl ? [{
          id: Number(document.id),
          space_id: Number(space.id),
          image_type: 'rendering',
          image_url: imageUrl,
          is_primary: true,
          source_type: 'design_document',
        }] : [],
      };
    });
    const counts = {};
    if (documents) for (const doc of documents) {
      if (doc.is_current === false || doc.is_current === 0 || doc.status === 'voided') continue;
      counts[doc.category] = (counts[doc.category] || 0) + 1;
    }
    const floorPlan = calendar.project.floor_plan_image;
    if (documents && floorPlan && !documents.some(doc => doc.file_url === floorPlan && doc.is_current !== false && doc.is_current !== 0 && doc.status !== 'voided')) {
      counts.original_floor_plan = (counts.original_floor_plan || 0) + 1;
    }
    const cover = covers?.[0]?.cover_image || homeSpaces?.find(s => s.images.length)?.images[0].image_url || calendar.project.floor_plan_image || null;
    return success(res, {
      calendar, members, todos, spaces: homeSpaces, product_count: productCount,
      document_counts: documents ? counts : null,
      handover_count: handovers?.length ?? null,
      material_count: materials?.length ?? null,
      cover_url: cover, unavailable,
    });
  };
}

module.exports = { home: createHomeController(), createHomeController };
