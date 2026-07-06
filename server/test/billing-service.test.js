const assert = require('node:assert/strict');
const test = require('node:test');

function loadBillingService(dbMock) {
  const dbPath = require.resolve('../config/db');
  const servicePath = require.resolve('../services/billing.service');
  delete require.cache[dbPath];
  delete require.cache[servicePath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock,
  };
  return require('../services/billing.service');
}

test('merchant display plan for app returns null when no published plan exists', async () => {
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /FROM billing_plans p/);
      assert.deepEqual(params, ['merchant_display_monthly']);
      return [[]];
    },
  };
  const billingService = loadBillingService(dbMock);

  const plan = await billingService.getMerchantDisplayPlanForApp();

  assert.equal(plan, null);
});

test('merchant display plan for app parses feature and limit json', async () => {
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /JOIN billing_plan_versions pv/);
      assert.deepEqual(params, ['merchant_display_monthly']);
      return [[{
        plan_id: 3,
        plan_version_id: 8,
        name: '商家展示套餐',
        price_cents: 9900,
        currency: 'CNY',
        duration_days: 365,
        feature_json: JSON.stringify({ shop_visible: true, map_visible: true }),
        limit_json: JSON.stringify({ product_limit: 50, case_limit: 20 }),
      }]];
    },
  };
  const billingService = loadBillingService(dbMock);

  const plan = await billingService.getMerchantDisplayPlanForApp();

  assert.equal(plan.plan_id, 3);
  assert.equal(plan.plan_version_id, 8);
  assert.equal(plan.price_cents, 9900);
  assert.deepEqual(plan.feature, { shop_visible: true, map_visible: true });
  assert.deepEqual(plan.limit, { product_limit: 50, case_limit: 20 });
});

test('current entitlement rejects non-merchant subjects in MVP', async () => {
  const billingService = loadBillingService({ async query() { throw new Error('should not query'); } });

  await assert.rejects(
    () => billingService.getCurrentEntitlement('company', 7),
    (err) => err instanceof billingService.BillingError && /只支持 merchant/.test(err.message)
  );
});

test('current entitlement only marks shop visible when active, not readonly, and not expired', async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /FROM billing_entitlements/);
      assert.deepEqual(params, [42]);
      return [[{
        id: 11,
        status: 'active',
        feature_json: JSON.stringify({ shop_visible: true }),
        limit_json: JSON.stringify({ product_limit: 50 }),
        readonly_mode: 0,
        reason: null,
        expire_at: future,
      }]];
    },
  };
  const billingService = loadBillingService(dbMock);

  const entitlement = await billingService.getCurrentEntitlement('merchant', 42);

  assert.equal(entitlement.id, 11);
  assert.equal(entitlement.shop_visible, true);
  assert.equal(entitlement.readonly_mode, false);
  assert.equal(entitlement.reason, null);
  assert.equal(entitlement.reason_label, null);
  assert.deepEqual(entitlement.limit, { product_limit: 50 });
});

test('current entitlement hides shop when readonly mode is enabled', async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const dbMock = {
    async query() {
      return [[{
        id: 12,
        status: 'active',
        feature_json: JSON.stringify({ shop_visible: true }),
        limit_json: '{}',
        readonly_mode: 1,
        reason: 'manual_suspend',
        expire_at: future,
      }]];
    },
  };
  const billingService = loadBillingService(dbMock);

  const entitlement = await billingService.getCurrentEntitlement('merchant', 42);

  assert.equal(entitlement.shop_visible, false);
  assert.equal(entitlement.readonly_mode, true);
  assert.equal(entitlement.reason, 'manual_suspend');
  assert.equal(entitlement.reason_label, '后台已暂停展示');
});

test('current entitlement exposes close reason even when entitlement is inactive', async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /ORDER BY \(status = 'active' AND expire_at > NOW\(\)\) DESC/);
      assert.deepEqual(params, [42]);
      return [[{
        id: 13,
        status: 'inactive',
        feature_json: JSON.stringify({ shop_visible: true }),
        limit_json: '{}',
        readonly_mode: 1,
        reason: 'refund_closed',
        expire_at: future,
      }]];
    },
  };
  const billingService = loadBillingService(dbMock);

  const entitlement = await billingService.getCurrentEntitlement('merchant', 42);

  assert.equal(entitlement.shop_visible, false);
  assert.equal(entitlement.reason, 'refund_closed');
  assert.equal(entitlement.reason_label, '后台已关闭展示权益');
});

test('create merchant display order requires merchant profile and role', async () => {
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /FROM merchant_profiles mp/);
      assert.deepEqual(params, [42]);
      return [[]];
    },
  };
  const billingService = loadBillingService(dbMock);

  await assert.rejects(
    () => billingService.createMerchantDisplayOrder({
      merchantUserId: 42,
      operatorUserId: 42,
      paymentChannel: 'manual',
      idempotencyKey: 'test-order',
    }),
    (err) => err instanceof billingService.BillingError && err.statusCode === 403
  );
});
