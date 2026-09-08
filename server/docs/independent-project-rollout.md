# Independent designer projects: backend rollout

Deployment scope: backend only. Existing frontend files and desktop installations are not published by this workflow.

## Release sequence

1. Run all backend tests; check current backend health without modifying its process.
2. Stage backend and preserve production configuration and runtime files.
3. Back up the database. Run `node scripts/run-pending-migrations.js` while old backend remains serving.
4. Run `node scripts/check-independent-project-schema.js`. Missing columns, incorrect legacy defaults or NOT NULL owner/date fields stop deployment.
5. Smoke-test staged backend on port 3099; only then activate and restart PM2. The single-worker restart can cause a brief connection interruption.
6. Check health again. Activation failure restores the previous backend code, retaining the additive schema; do not restore NOT NULL constraints after independent rows exist.

The migration inspects each column to resume interrupted MySQL DDL, obtains a named lock, limits metadata-lock waits to 15 seconds and avoids repeated ALTERs. MySQL DDL is not transactional; failure does not undo earlier additions. Existing owner projects retain owner IDs, dates and defaults. Startup checks the migration before listening and does not run this migration implicitly.

## Opening to new desktop

`FEATURE_INDEPENDENT_PROJECTS` must be exactly `true` to create projects or send/respond to owner invitations. Absent/false is closed. Keep it closed for this initial production release.

Only compatible desktop clients send `X-ZXW-Projects: independent-desktop-v1` on API requests, including uploads. This is a compatibility contract, not an authorization credential. Designer role and active project membership remain mandatory.

Authenticated `GET /api/renovation/features` exposes `data.independent_projects`. New desktop should use it to show the create/invite actions. Updating backend does not add this protocol to an already installed desktop app: update/test the desktop before enabling the production flag and reloading backend environment.

Legacy project lists and default-project selection exclude designer-created projects, even after an owner joins. Legacy direct project access returns 409 with an upgrade message; owner invitations return an empty list. Old owner-wide bind/unbind invitation operations always exclude independent projects.

Turning the flag off stops new independent create/invite/respond actions. Compatible clients can still access and prepare existing independent projects. It does not revoke membership or hide existing work.

## Validation

`npm test --prefix server`

`node server/scripts/verify-independent-projects.js /tmp/zxw-project-mysql.XXXXXX/mysql.sock`

The latter requires an explicit disposable socket-only MySQL instance and never loads production configuration. It checks interrupted/repeated migrations, old project preservation, old/new list separation, real preparation operations, membership isolation and owner acceptance retaining the original project.
