require('dotenv').config();
const storageService = require('../services/storage.service');

storageService.checkStorageConnection()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(`Storage check failed: ${err.message}`);
    process.exit(1);
  });
