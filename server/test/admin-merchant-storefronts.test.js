const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../services/admin-merchant-storefronts');

test('merchant storefront list includes review and distinct frontend/billing display states', async () => {
  const queries = [];
  const db = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('COUNT(*) AS total')) return [[{ total: 1 }]];
      if (sql.includes('FROM phone_location_cache')) return [[]];
      return [[{
        user_id: 70,
        nickname: '装修小达人',
        phone: '13800138000',
        city: '北京',
        verified_status: 'approved',
        verified_until: '2027-01-01 00:00:00',
        verified_applied_at: '2026-10-01 00:00:00',
        review_note: '资料齐全',
        directory_visible: 1,
        billing_shop_visible: 0,
        entitlement_id: 1,
        entitlement_reason: 'refund_closed',
        entitlement_expired: 1,
        shop_name: '好住建材',
        category_group: '建材',
        categories: JSON.stringify(['瓷砖地板']),
        service_types: JSON.stringify(['测量', '配送']),
        service_area: '北京朝阳',
        product_count: '4',
        case_count: '2',
        last_active_at: '2026-10-14 10:00:00',
      }]];
    },
  };

  const result = await service.list(db, { keyword: '好住' });
  assert.equal(result.total, 1);
  assert.equal(result.merchants[0].verification_label, '已通过');
  assert.equal(result.merchants[0].review_note, '资料齐全');
  assert.equal(result.merchants[0].verified_until, '2027-01-01 00:00:00');
  assert.equal(result.merchants[0].directory_visible, true);
  assert.equal(result.merchants[0].billing_shop_visible, false);
  assert.equal(result.merchants[0].display_mismatch, true);
  assert.equal(result.merchants[0].billing_display_label, '已关闭');
  assert.deepEqual(result.merchants[0].categories, ['瓷砖地板']);
  assert.deepEqual(result.merchants[0].service_types, ['测量', '配送']);
  assert.equal(result.merchants[0].product_count, 4);
  assert.equal(result.merchants[0].case_count, 2);
  assert.ok(queries[1].sql.includes('merchant_products'));
  assert.ok(queries[1].sql.includes('merchant_cases'));
  assert.ok(queries[1].sql.includes('billing_entitlements'));
});

test('review, missing shop name, and expired admission each prevent frontend display', () => {
  const state = service.displayState;
  assert.equal(state({ shop_name: '万象', verified_status: 'pending' }).display_reason, '待审核');
  assert.equal(state({ verified_status: 'approved' }).display_reason, '未填写店铺名称');
  assert.equal(state({ shop_name: '好住', verified_status: 'approved', directory_visible: 0 }).display_reason, '入驻审核有效期已过');
  assert.equal(state({ shop_name: '好住', verified_status: 'suspended', billing_shop_visible: 1 }).directory_visible, false);
});

test('billing display distinguishes missing, active, paused, expired, and closed entitlements', () => {
  const state = service.displayState;
  assert.equal(state({}).billing_display_label, '未开通');
  assert.equal(state({ entitlement_id: 1, billing_shop_visible: 1 }).billing_display_label, '有效');
  assert.equal(state({ entitlement_id: 1, entitlement_reason: 'manual_suspend', entitlement_expired: 1 }).billing_display_label, '已暂停');
  assert.equal(state({ entitlement_id: 1, entitlement_expired: 1 }).billing_display_label, '已到期');
  assert.equal(state({ entitlement_id: 1, entitlement_reason: 'refund_closed', entitlement_expired: 1 }).billing_display_label, '已关闭');
  assert.equal(state({ entitlement_id: 1 }).billing_display_label, '未生效');
});

test('merchant storefront list rejects unsupported verification filters', async () => {
  await assert.rejects(
    service.list({}, { verification_status: 'anything' }),
    { message: '认证状态不正确', status: 400 }
  );
});
