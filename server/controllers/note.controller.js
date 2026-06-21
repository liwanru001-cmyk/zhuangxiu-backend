const db = require('../config/db');
const { success, error } = require('../utils/response');

const ALLOWED_SOURCE_TYPES = new Set([
  'site_photos',
  'complaint',
  'site_check_in',
  'question',
  'good_item',
  'inspiration',
]);
const SOURCE_TYPE_OPTIONS = [
  { value: 'site_photos', label: '工地美照', visible_in_feed: true },
  { value: 'complaint', label: '大家吐槽', visible_in_feed: true },
  { value: 'question', label: '问题汇总', visible_in_feed: true },
  { value: 'good_item', label: '好物推荐', visible_in_feed: true },
  { value: 'inspiration', label: '创意灵感', visible_in_feed: true },
  { value: 'site_check_in', label: '工地打卡', visible_in_feed: false },
];
const ALLOWED_DECORATION_STYLES = new Set([
  'modern',
  'cream',
  'wood',
  'nordic',
  'french',
  'new_chinese',
  'light_luxury',
  'american',
]);
const DECORATION_STYLE_OPTIONS = [
  { value: 'modern', label: '现代简约' },
  { value: 'cream', label: '奶油风' },
  { value: 'wood', label: '原木风' },
  { value: 'nordic', label: '北欧风' },
  { value: 'french', label: '法式' },
  { value: 'new_chinese', label: '新中式' },
  { value: 'light_luxury', label: '轻奢' },
  { value: 'american', label: '美式' },
];
const ALLOWED_PUBLISH_ROLES = new Set([
  'owner',
  'designer',
  'merchant',
  'project_manager',
  'project_supervisor',
]);
const ALLOWED_QUESTION_AUDIENCES = new Set([
  'owner',
  'designer',
  'merchant',
  'project_manager',
  'project_supervisor',
  'user',
  'all',
]);
const NOTE_MEDIA_LIMITS = {
  maxImages: 9,
  maxVideos: 1,
  maxImageBytes: 2 * 1024 * 1024,
  maxVideoBytes: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
};

async function removeUploadedNoteFiles(files) {
  if (!files?.length) return;
  const fs = require('fs/promises');
  await Promise.allSettled(files.map((file) => fs.unlink(file.path)));
}

// 首页笔记列表（瀑布流分页）
async function list(req, res) {
  const {
    tab = 'recommend',
    page = 1,
    pageSize = 20,
    city,
    keyword,
    category,
    style,
    source_type: sourceType,
    sort = 'new',
  } = req.query;
  const currentPage = Math.max(parseInt(page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(pageSize) || 20, 1), 50);
  const offset = (currentPage - 1) * limit;

  let where = 'n.status = 1';
  const params = [];

  if (tab === 'follow') {
    // 关注用户的笔记
    where += ` AND n.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?)`;
    params.push(req.user?.id || 0);
  }
  if (tab === 'local' && city) {
    where += ` AND REPLACE(n.city, '市', '') = REPLACE(?, '市', '')`;
    params.push(city);
  }
  if (keyword) {
    where += ` AND (n.title LIKE ? OR n.content LIKE ?)`;
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (category) {
    where += ` AND n.category = ?`;
    params.push(category);
  }
  if (style) {
    if (!ALLOWED_DECORATION_STYLES.has(style)) {
      return error(res, '无效的装修风格');
    }
    where += ` AND n.decoration_style = ?`;
    params.push(style);
  }
  if (sourceType) {
    if (!ALLOWED_SOURCE_TYPES.has(sourceType)) {
      return error(res, '无效的内容来源');
    }
    where += ` AND n.source_type = ?`;
    params.push(sourceType);
  }

  const orderBy =
    sort === 'hot'
      ? `(n.likes_count * 3 + n.comments_count * 4 + n.collections_count * 2 + n.views_count) DESC, n.created_at DESC`
      : 'n.created_at DESC';

  // 笔记基础信息 + 图片 + 作者
  const [notes] = await db.query(
    `SELECT n.id, n.title, n.content, n.source_type, n.stage_id,
            COALESCE(n.publish_role, u.role) AS publish_role,
            n.question_audience, n.decoration_style,
            n.city, n.location,
            n.likes_count, n.comments_count, n.collections_count,
            n.views_count, n.created_at,
            u.id AS user_id, u.nickname AS author_name, u.avatar AS author_avatar,
            GROUP_CONCAT(DISTINCT t.name) AS tags
     FROM notes n
     JOIN users u ON n.user_id = u.id
     LEFT JOIN note_tags nt ON n.id = nt.note_id
     LEFT JOIN tags t ON nt.tag_id = t.id
     WHERE ${where}
     GROUP BY n.id
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  // 每个笔记的前三张图和热门评论
  for (const note of notes) {
    const [images] = await db.query(
      'SELECT url FROM note_images WHERE note_id = ? ORDER BY sort_order ASC LIMIT 3',
      [note.id]
    );
    note.cover_image = images[0]?.url || '';
    note.images = images;
    const [topComments] = await db.query(
      `SELECT c.content, c.likes_count, u.nickname
       FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.note_id = ? AND c.status = 1
       ORDER BY c.likes_count DESC, c.created_at DESC
       LIMIT 1`,
      [note.id]
    );
    note.top_comment = topComments[0] || null;
    note.tags = note.tags ? note.tags.split(',').filter(Boolean) : [];
  }

  // 总条数
  const [totalRows] = await db.query(
    `SELECT COUNT(DISTINCT n.id) as total FROM notes n WHERE ${where}`,
    params
  );

  return success(res, {
    notes,
    total: totalRows[0].total,
    page: currentPage,
    pageSize: limit,
  });
}

async function feedOptions(req, res) {
  const [cityRows] = await db.query(
    `SELECT TRIM(TRAILING '市' FROM city) AS city, COUNT(*) AS notes_count
     FROM notes
     WHERE status = 1 AND city IS NOT NULL AND city <> ''
     GROUP BY TRIM(TRAILING '市' FROM city)
     ORDER BY notes_count DESC, city ASC
     LIMIT 50`
  );
  const [styleRows] = await db.query(
    `SELECT decoration_style AS value, COUNT(*) AS notes_count
     FROM notes
     WHERE status = 1 AND decoration_style IS NOT NULL AND decoration_style <> ''
     GROUP BY decoration_style
     ORDER BY notes_count DESC
     LIMIT 50`
  );

  const styleLabelMap = new Map(
    DECORATION_STYLE_OPTIONS.map((item) => [item.value, item.label])
  );
  const styles = styleRows.map((row) => ({
    value: row.value,
    label: styleLabelMap.get(row.value) || row.value,
    notes_count: row.notes_count,
  }));

  return success(res, {
    sources: SOURCE_TYPE_OPTIONS,
    styles,
    default_styles: DECORATION_STYLE_OPTIONS,
    cities: cityRows,
  });
}

// 笔记详情
async function detail(req, res) {
  const { id } = req.params;

  const visibilityParams = req.user ? [id, req.user.id] : [id];
  const visibilityWhere = req.user
    ? 'n.id = ? AND (n.status = 1 OR (n.user_id = ? AND n.status IN (1, 3)))'
    : 'n.id = ? AND n.status = 1';
  const [notes] = await db.query(
    `SELECT n.*, u.nickname AS author_name, u.avatar AS author_avatar,
            GROUP_CONCAT(DISTINCT t.name) AS tags
     FROM notes n
     JOIN users u ON n.user_id = u.id
     LEFT JOIN note_tags nt ON n.id = nt.note_id
     LEFT JOIN tags t ON nt.tag_id = t.id
     WHERE ${visibilityWhere}
     GROUP BY n.id`,
    visibilityParams
  );

  if (notes.length === 0) {
    return error(res, '笔记不存在', 404);
  }

  const note = notes[0];
  note.tags = note.tags ? note.tags.split(',').filter(Boolean) : [];

  // 图片列表
  const [images] = await db.query(
    'SELECT id, url, sort_order FROM note_images WHERE note_id = ? ORDER BY sort_order ASC',
    [id]
  );
  note.images = images;

  // 视频
  const [videos] = await db.query(
    'SELECT id, url, cover_url, duration FROM note_videos WHERE note_id = ?',
    [id]
  );
  note.videos = videos;

  // 当前用户是否已点赞/收藏
  if (req.user) {
    const [likeRows] = await db.query('SELECT id FROM likes WHERE user_id = ? AND note_id = ?', [req.user.id, id]);
    note.is_liked = likeRows.length > 0;
    const [collectRows] = await db.query('SELECT id FROM collections WHERE user_id = ? AND note_id = ?', [req.user.id, id]);
    note.is_collected = collectRows.length > 0;
  } else {
    note.is_liked = false;
    note.is_collected = false;
  }

  // 浏览 +1
  await db.query('UPDATE notes SET views_count = views_count + 1 WHERE id = ?', [id]);

  return success(res, note);
}

async function uploadMedia(req, res) {
  const files = req.files || [];
  if (!files.length) return error(res, '请选择需要上传的图片或视频');

  const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic']);
  const path = require('path');
  const images = [];
  const videos = [];
  const host = `${req.protocol}://${req.get('host')}`;
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size || 0;
    const extension = path.extname(file.originalname).toLowerCase();
    const media = {
      url: `${host}/uploads/notes/${file.filename}`,
      original_name: file.originalname,
      size: file.size || 0,
    };
    if (file.mimetype.startsWith('image/') || imageExtensions.has(extension)) {
      if ((file.size || 0) > NOTE_MEDIA_LIMITS.maxImageBytes) {
        await removeUploadedNoteFiles(files);
        return error(res, '单张图片不能超过 2MB');
      }
      images.push(media.url);
    } else {
      if ((file.size || 0) > NOTE_MEDIA_LIMITS.maxVideoBytes) {
        await removeUploadedNoteFiles(files);
        return error(res, '单个视频不能超过 10MB');
      }
      videos.push({ ...media, cover_url: '', duration: 0 });
    }
  }
  if (totalBytes > NOTE_MEDIA_LIMITS.maxTotalBytes) {
    await removeUploadedNoteFiles(files);
    return error(res, '本次上传总大小不能超过 20MB');
  }
  if (images.length > NOTE_MEDIA_LIMITS.maxImages) {
    await removeUploadedNoteFiles(files);
    return error(res, '最多上传 9 张图片');
  }
  if (videos.length > NOTE_MEDIA_LIMITS.maxVideos) {
    await removeUploadedNoteFiles(files);
    return error(res, '最多上传 1 个视频');
  }
  return success(res, {
    images,
    video: videos[0] || null,
    policy: {
      image_max_mb: Math.round(NOTE_MEDIA_LIMITS.maxImageBytes / 1024 / 1024),
      video_max_mb: Math.round(NOTE_MEDIA_LIMITS.maxVideoBytes / 1024 / 1024),
      total_max_mb: Math.round(NOTE_MEDIA_LIMITS.maxTotalBytes / 1024 / 1024),
      storage_tier: 'hot_local',
    },
  });
}

// 发布笔记
async function create(req, res) {
  const {
    title,
    content,
    source_type: sourceType,
    stage_id: stageId,
    publish_role: publishRole,
    question_audience: questionAudience,
    images = [],
    video,
    tags = [],
    category,
    decoration_style: decorationStyle,
    location,
    city,
  } = req.body;

  if (!title?.trim()) return error(res, '标题不能为空');
  if (!content?.trim()) return error(res, '内容不能为空');
  if (!ALLOWED_SOURCE_TYPES.has(sourceType)) return error(res, '无效的内容来源');
  const stageRequired = sourceType === 'question';
  if (
    stageRequired &&
    (!Number.isInteger(Number(stageId)) ||
      Number(stageId) < 1 ||
      Number(stageId) > 8)
  ) {
    return error(res, '装修阶段不正确');
  }
  if (
    stageId != null &&
    stageId !== '' &&
    (!Number.isInteger(Number(stageId)) ||
      Number(stageId) < 1 ||
      Number(stageId) > 8)
  ) {
    return error(res, '装修阶段不正确');
  }
  if (!ALLOWED_PUBLISH_ROLES.has(publishRole)) return error(res, '发布身份不正确');
  if (
    sourceType === 'question' &&
    !ALLOWED_QUESTION_AUDIENCES.has(questionAudience)
  ) {
    return error(res, '提问对象不正确');
  }
  if (
    decorationStyle &&
    !['complaint', 'good_item', 'inspiration'].includes(sourceType) &&
    !ALLOWED_DECORATION_STYLES.has(decorationStyle)
  ) {
    return error(res, '无效的装修风格');
  }
  if (decorationStyle && String(decorationStyle).trim().length > 30) {
    return error(res, '装修风格最多 30 个字');
  }
  if (
    !['question', 'complaint', 'inspiration'].includes(sourceType) &&
    images.length === 0 &&
    !video
  ) {
    return error(res, '请至少上传一张图片或视频');
  }
  if (images.length > 9) return error(res, '最多上传 9 张图片');

  const [result] = await db.query(
    `INSERT INTO notes
     (user_id, title, content, source_type, stage_id, publish_role,
      question_audience, category, decoration_style, location, city, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      req.user.id,
      title.trim(),
      content.trim(),
      sourceType,
      stageId == null || stageId === '' ? null : Number(stageId),
      publishRole,
      sourceType === 'question' ? questionAudience : null,
      category || '',
      String(decorationStyle || '').trim(),
      location || '',
      city || '',
    ]
  );

  const noteId = result.insertId;

  // 插入图片
  for (let i = 0; i < images.length; i++) {
    await db.query(
      'INSERT INTO note_images (note_id, url, sort_order) VALUES (?, ?, ?)',
      [noteId, images[i], i]
    );
  }

  // 插入视频
  if (video) {
    await db.query(
      'INSERT INTO note_videos (note_id, url, cover_url, duration) VALUES (?, ?, ?, ?)',
      [noteId, video.url, video.cover_url || '', video.duration || 0]
    );
  }

  // 插入标签
  for (const tagName of tags) {
    // 标签不存在则创建
    await db.query('INSERT IGNORE INTO tags (name) VALUES (?)', [tagName]);
    const [tagRows] = await db.query('SELECT id FROM tags WHERE name = ?', [tagName]);
    if (tagRows[0]) {
      await db.query('INSERT IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)', [noteId, tagRows[0].id]);
    }
  }

  return success(res, { id: noteId }, '发布成功');
}

// 点赞
async function toggleLike(req, res) {
  const { id } = req.params;
  const [existing] = await db.query('SELECT id FROM likes WHERE user_id = ? AND note_id = ?', [req.user.id, id]);

  if (existing.length > 0) {
    await db.query('DELETE FROM likes WHERE user_id = ? AND note_id = ?', [req.user.id, id]);
    await db.query('UPDATE notes SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = ?', [id]);
    return success(res, { liked: false });
  } else {
    await db.query('INSERT IGNORE INTO likes (user_id, note_id) VALUES (?, ?)', [req.user.id, id]);
    await db.query('UPDATE notes SET likes_count = likes_count + 1 WHERE id = ?', [id]);
    return success(res, { liked: true });
  }
}

// 收藏
async function toggleCollect(req, res) {
  const { id } = req.params;
  const [existing] = await db.query('SELECT id FROM collections WHERE user_id = ? AND note_id = ?', [req.user.id, id]);

  if (existing.length > 0) {
    await db.query('DELETE FROM collections WHERE user_id = ? AND note_id = ?', [req.user.id, id]);
    await db.query('UPDATE notes SET collections_count = GREATEST(collections_count - 1, 0) WHERE id = ?', [id]);
    return success(res, { collected: false });
  } else {
    await db.query('INSERT IGNORE INTO collections (user_id, note_id) VALUES (?, ?)', [req.user.id, id]);
    await db.query('UPDATE notes SET collections_count = collections_count + 1 WHERE id = ?', [id]);
    return success(res, { collected: true });
  }
}

async function recordView(req, res) {
  const noteId = Number(req.params.id);
  const [notes] = await db.query(
    'SELECT id FROM notes WHERE id = ? AND status = 1',
    [noteId]
  );
  if (!notes[0]) return error(res, '笔记不存在', 404);

  await db.query(
    `INSERT INTO note_view_history (user_id, note_id, viewed_at)
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE viewed_at = NOW()`,
    [req.user.id, noteId]
  );
  await db.query(
    `DELETE h FROM note_view_history h
     LEFT JOIN (
       SELECT id FROM (
         SELECT id
         FROM note_view_history
         WHERE user_id = ?
         ORDER BY viewed_at DESC, id DESC
         LIMIT 100
       ) recent
     ) keep_rows ON keep_rows.id = h.id
     WHERE h.user_id = ? AND keep_rows.id IS NULL`,
    [req.user.id, req.user.id]
  );
  return success(res, null);
}

// 评论列表
async function listComments(req, res) {
  const { id } = req.params;
  const { page = 1, pageSize = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(pageSize);

  const [comments] = await db.query(
    `SELECT c.*, u.nickname, u.avatar
     FROM comments c
     JOIN users u ON c.user_id = u.id
     WHERE c.note_id = ? AND c.status = 1
     ORDER BY c.created_at DESC
     LIMIT ? OFFSET ?`,
    [id, parseInt(pageSize), offset]
  );

  const [totalRows] = await db.query('SELECT COUNT(*) as total FROM comments WHERE note_id = ? AND status = 1', [id]);

  return success(res, { comments, total: totalRows[0].total });
}

// 发表评论
async function createComment(req, res) {
  const { id } = req.params;
  const { content, reply_to } = req.body;

  if (!content?.trim()) return error(res, '评论不能为空');

  const [result] = await db.query(
    'INSERT INTO comments (user_id, note_id, reply_to, content) VALUES (?, ?, ?, ?)',
    [req.user.id, id, reply_to || null, content.trim()]
  );

  await db.query('UPDATE notes SET comments_count = comments_count + 1 WHERE id = ?', [id]);

  return success(res, { id: result.insertId });
}

// 搜索
async function search(req, res) {
  const { keyword, type = 'all', page = 1, pageSize = 20 } = req.query;
  if (!keyword?.trim()) return error(res, '请输入搜索关键词');

  const offset = (parseInt(page) - 1) * parseInt(pageSize);
  const results = { notes: [], tags: [], users: [] };

  if (type === 'all' || type === 'notes') {
    const [notes] = await db.query(
      `SELECT n.id, n.title, n.content, n.source_type, n.likes_count, n.comments_count, n.created_at,
              u.nickname AS author_name, u.avatar AS author_avatar,
              (SELECT url FROM note_images WHERE note_id = n.id ORDER BY sort_order ASC LIMIT 1) AS cover_image
       FROM notes n
       JOIN users u ON n.user_id = u.id
       WHERE n.status = 1 AND (n.title LIKE ? OR n.content LIKE ?)
       ORDER BY n.created_at DESC
       LIMIT ? OFFSET ?`,
      [`%${keyword}%`, `%${keyword}%`, parseInt(pageSize), offset]
    );
    results.notes = notes;
  }

  if (type === 'all' || type === 'tags') {
    const [tags] = await db.query(
      'SELECT id, name, notes_count FROM tags WHERE name LIKE ? ORDER BY notes_count DESC LIMIT 10',
      [`%${keyword}%`]
    );
    results.tags = tags;
  }

  if (type === 'all' || type === 'users') {
    const [users] = await db.query(
      'SELECT id, nickname, avatar FROM users WHERE nickname LIKE ? LIMIT 10',
      [`%${keyword}%`]
    );
    results.users = users;
  }

  return success(res, results);
}

module.exports = {
  list,
  feedOptions,
  detail,
  uploadMedia,
  create,
  toggleLike,
  toggleCollect,
  recordView,
  listComments,
  createComment,
  search,
};
