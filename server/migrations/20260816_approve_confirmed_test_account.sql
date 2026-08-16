-- The owner explicitly confirmed this existing account as an approved test account.
UPDATE users
SET admin_status = 'approved'
WHERE phone = '13900139001'
  AND is_test_account = 1;
