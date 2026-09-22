const test = require('node:test');
const assert = require('node:assert/strict');
const dbPath = require.resolve('../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
const { isSelectableMainDesignDocument } = require('../controllers/renovation.controller');

const image = {
  project_id: 91,
  space_key: '2',
  is_current: 1,
  status: 'pending',
  file_type: 'image',
  mime_type: 'image/jpeg',
  file_url: '/uploads/bedroom.jpg',
};

test('main rendering must reference a current image document in the same space', () => {
  assert.equal(isSelectableMainDesignDocument(image, 91, 2), true);
  assert.equal(isSelectableMainDesignDocument({ ...image, project_id: 92 }, 91, 2), false);
  assert.equal(isSelectableMainDesignDocument({ ...image, space_key: '1' }, 91, 2), false);
  assert.equal(isSelectableMainDesignDocument({ ...image, is_current: 0 }, 91, 2), false);
  assert.equal(isSelectableMainDesignDocument({ ...image, status: 'voided' }, 91, 2), false);
  assert.equal(isSelectableMainDesignDocument({ ...image, file_type: 'pdf', mime_type: 'application/pdf' }, 91, 2), false);
  assert.equal(isSelectableMainDesignDocument({ ...image, file_url: '' }, 91, 2), false);
});
