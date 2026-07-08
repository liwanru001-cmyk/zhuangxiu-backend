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

test('current entitlement rejects unsupported subjects in MVP', async () => {
  const billingService = loadBillingService({ async query() { throw new Error('should not query'); } });

  await assert.rejects(
    () => billingService.getCurrentEntitlement('designer', 7),
    (err) => err instanceof billingService.BillingError && /只支持 merchant\/company/.test(err.message)
  );
});

test('current entitlement only marks shop visible when active, not readonly, and not expired', async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /FROM billing_entitlements/);
      assert.deepEqual(params, ['merchant', 42]);
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
      assert.deepEqual(params, ['merchant', 42]);
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

test('current entitlement marks company visible from company feature', async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /WHERE subject_type = \?/);
      assert.deepEqual(params, ['company', 7]);
      return [[{
        id: 21,
        status: 'active',
        feature_json: JSON.stringify({ company_visible: true }),
        limit_json: '{}',
        readonly_mode: 0,
        reason: null,
        expire_at: future,
      }]];
    },
  };
  const billingService = loadBillingService(dbMock);

  const entitlement = await billingService.getCurrentEntitlement('company', 7);

  assert.equal(entitlement.company_visible, true);
  assert.equal(entitlement.shop_visible, false);
});

test('create company display order requires verified active company', async () => {
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /FROM companies/);
      assert.deepEqual(params, [7]);
      return [[{
        id: 7,
        name: '待认证装修公司',
        status: 'active',
        verification_status: 'pending',
      }]];
    },
  };
  const billingService = loadBillingService(dbMock);

  await assert.rejects(
    () => billingService.createCompanyDisplayOrder({
      companyId: 7,
      operatorUserId: 0,
      paymentChannel: 'manual',
      idempotencyKey: 'company-order',
    }),
    (err) => err instanceof billingService.BillingError && err.statusCode === 403
  );
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

test('create merchant display appeal requires a blocked merchant entitlement', async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const calls = [];
  const conn = {
    async beginTransaction() {
      calls.push('begin');
    },
    async query(sql, params) {
      calls.push(sql);
      if (/FROM billing_appeals/.test(sql) && /status = 'pending'/.test(sql)) {
        assert.deepEqual(params, [42]);
        return [[]];
      }
      if (/FROM billing_entitlements/.test(sql)) {
        assert.deepEqual(params, [42]);
        return [[{
          id: 88,
          status: 'active',
          feature_json: JSON.stringify({ shop_visible: true }),
          limit_json: '{}',
          readonly_mode: 1,
          reason: 'manual_suspend',
          expire_at: future,
          updated_at: future,
        }]];
      }
      if (/INSERT INTO billing_appeals/.test(sql)) {
        assert.equal(params[1], 42);
        assert.equal(params[2], 88);
        assert.equal(params[3], 'manual_suspend');
        assert.equal(params[4], '后台已暂停展示');
        assert.equal(params[5], '资料已经整改完成，请恢复展示');
        return [{ insertId: 99 }];
      }
      if (/INSERT INTO billing_audit_logs/.test(sql)) return [{ insertId: 1 }];
      if (/INSERT INTO billing_events/.test(sql)) return [{ insertId: 2 }];
      throw new Error(`unexpected conn query: ${sql}`);
    },
    async commit() {
      calls.push('commit');
    },
    async rollback() {
      calls.push('rollback');
    },
    release() {
      calls.push('release');
    },
  };
  const dbMock = {
    async query(sql, params) {
      if (/FROM merchant_profiles mp/.test(sql)) {
        assert.deepEqual(params, [42]);
        return [[{ user_id: 42, shop_name: '测试店铺' }]];
      }
      if (/INSERT INTO billing_subjects/.test(sql)) {
        assert.deepEqual(params, [42]);
        return [{ insertId: 1 }];
      }
      throw new Error(`unexpected db query: ${sql}`);
    },
    async getConnection() {
      return conn;
    },
  };
  const billingService = loadBillingService(dbMock);

  const result = await billingService.createMerchantDisplayAppeal({
    merchantUserId: 42,
    content: '资料已经整改完成，请恢复展示',
    idempotencyKey: 'appeal-42',
  });

  assert.equal(result.reused, false);
  assert.equal(result.appeal.id, 99);
  assert.equal(result.appeal.status, 'pending');
  assert.equal(result.appeal.reason_code, 'manual_suspend');
  assert.ok(calls.includes('commit'));
});

test('approve merchant display appeal restores inactive entitlement and subscription', async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const updates = [];
  const conn = {
    async beginTransaction() {},
    async query(sql, params) {
      if (/FROM billing_appeals/.test(sql)) {
        assert.deepEqual(params, [99]);
        return [[{
          id: 99,
          appeal_no: 'BA1',
          subject_type: 'merchant',
          subject_id: 42,
          appeal_type: 'merchant_display_restore',
          status: 'pending',
          entitlement_id: 88,
          reason_code: 'manual_suspend',
          reason_label: '后台已暂停展示',
          content: '已经整改',
          created_by: 42,
          created_at: future,
        }]];
      }
      if (/FROM billing_entitlements/.test(sql)) {
        assert.deepEqual(params, [88, 42]);
        return [[{
          id: 88,
          subject_type: 'merchant',
          subject_id: 42,
          subscription_id: 77,
          status: 'inactive',
          readonly_mode: 1,
          reason: 'refund_closed',
          expire_at: future,
        }]];
      }
      if (/UPDATE billing_entitlements/.test(sql)) {
        updates.push('entitlement');
        assert.deepEqual(params, [88]);
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE billing_subscriptions/.test(sql)) {
        updates.push('subscription');
        assert.deepEqual(params, [77]);
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE billing_appeals/.test(sql)) {
        updates.push('appeal');
        assert.deepEqual(params, ['审核通过，恢复展示', null, 99]);
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO billing_audit_logs/.test(sql)) return [{ insertId: 1 }];
      if (/INSERT INTO billing_events/.test(sql)) return [{ insertId: 2 }];
      throw new Error(`unexpected conn query: ${sql}`);
    },
    async commit() {
      updates.push('commit');
    },
    async rollback() {
      updates.push('rollback');
    },
    release() {},
  };
  const billingService = loadBillingService({
    async getConnection() {
      return conn;
    },
  });

  const result = await billingService.approveMerchantDisplayAppeal({
    appealId: 99,
    reason: '审核通过，恢复展示',
  });

  assert.equal(result.resumed, true);
  assert.equal(result.appeal.status, 'approved');
  assert.deepEqual(updates, ['entitlement', 'subscription', 'appeal', 'commit']);
});
