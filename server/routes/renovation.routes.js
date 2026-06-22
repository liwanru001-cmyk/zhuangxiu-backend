const express = require('express');
const auth = require('../middleware/auth');
const controller = require('../controllers/renovation.controller');
const asyncHandler = require('../utils/async-handler');
const {
  ensureUploadDir,
  setUploadedFilePermissions,
} = require('../utils/upload-permissions');
const multer = require('multer');
const path = require('path');

const router = express.Router();
const inspectionKbEnabled = process.env.FEATURE_INSPECTION_KB === 'true';

function inspectionKbGate(req, res, next) {
  if (!inspectionKbEnabled) {
    return res.status(404).json({ code: 404, message: '验收标准库功能未启用', data: null });
  }
  next();
}
const protectedRoute = [asyncHandler(auth)];

const floorPlanDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'floor-plans')
);
const floorPlanUpload = multer({
  storage: multer.diskStorage({
    destination: floorPlanDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
      callback(null, `owner-${req.user.id}-${Date.now()}${extension}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    callback(null, file.mimetype.startsWith('image/'));
  },
});
const projectImageDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'project-spaces')
);
const projectImageUpload = multer({
  storage: multer.diskStorage({
    destination: projectImageDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
      callback(
        null,
        `project-${req.params.id}-user-${req.user.id}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
      );
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, callback) => {
    callback(null, file.mimetype.startsWith('image/'));
  },
});
const inspectionImageDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'inspections')
);
const inspectionImageUpload = multer({
  storage: multer.diskStorage({
    destination: inspectionImageDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
      callback(
        null,
        `inspection-project-${req.params.id}-user-${req.user.id}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
      );
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 9 },
  fileFilter: (req, file, callback) => {
    callback(null, file.mimetype.startsWith('image/'));
  },
});
const actionItemMediaDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'action-items')
);
const actionItemMediaUpload = multer({
  storage: multer.diskStorage({
    destination: actionItemMediaDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(
        null,
        `action-project-${req.params.id}-user-${req.user.id}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
      );
    },
  }),
  limits: { fileSize: 60 * 1024 * 1024, files: 9 },
  fileFilter: (req, file, callback) => {
    callback(
      null,
      file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')
    );
  },
});
const checkInMediaDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'check-ins')
);
const checkInMediaUpload = multer({
  storage: multer.diskStorage({
    destination: checkInMediaDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(
        null,
        `checkin-project-${req.params.id}-user-${req.user.id}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
      );
    },
  }),
  limits: { fileSize: 60 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const isKnownMediaExtension = [
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.webp',
      '.heic',
      '.heif',
      '.mp4',
      '.mov',
      '.m4v',
    ].includes(extension);
    callback(
      null,
      file.mimetype.startsWith('image/') ||
        file.mimetype.startsWith('video/') ||
        isKnownMediaExtension
    );
  },
});
const expenseMediaDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'expenses')
);
const expenseMediaUpload = multer({
  storage: multer.diskStorage({
    destination: expenseMediaDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
      callback(
        null,
        `expense-project-${req.params.id}-user-${req.user.id}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
      );
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 9 },
  fileFilter: (req, file, callback) => {
    callback(null, file.mimetype.startsWith('image/'));
  },
});
const designDocumentDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'design-documents')
);
const designDocumentUpload = multer({
  storage: multer.diskStorage({
    destination: designDocumentDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
      callback(
        null,
        `design-project-${req.params.id}-user-${req.user.id}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
      );
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    callback(null, file.mimetype.startsWith('image/'));
  },
});
const handoverMediaDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'handovers')
);
const handoverMediaUpload = multer({
  storage: multer.diskStorage({
    destination: handoverMediaDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
      callback(
        null,
        `handover-project-${req.params.id}-user-${req.user.id}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
      );
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 9 },
  fileFilter: (req, file, callback) => {
    callback(null, file.mimetype.startsWith('image/'));
  },
});
const materialMediaDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'materials')
);
const materialMediaUpload = multer({
  storage: multer.diskStorage({
    destination: materialMediaDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
      callback(
        null,
        `material-project-${req.params.id}-user-${req.user.id}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
      );
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 9 },
  fileFilter: (req, file, callback) => {
    callback(null, file.mimetype.startsWith('image/'));
  },
});

// 公开/基础
router.get('/stages', asyncHandler(controller.getStages));

// 业主 - 装修档案
router.get('/projects', ...protectedRoute, asyncHandler(controller.getProjects));
router.get(
  '/projects/accessible',
  ...protectedRoute,
  asyncHandler(controller.getAccessibleProjects)
);
router.get('/projects/:id', ...protectedRoute, asyncHandler(controller.getProjectDetail));
router.put('/projects/:id/info', ...protectedRoute, asyncHandler(controller.updateProjectInfo));
router.get(
  '/projects/:id/info-change-requests',
  ...protectedRoute,
  asyncHandler(controller.getProjectInfoChangeRequests)
);
router.post(
  '/projects/:id/info-change-requests',
  ...protectedRoute,
  asyncHandler(controller.createProjectInfoChangeRequest)
);
router.put(
  '/projects/:id/info-change-requests/:requestId',
  ...protectedRoute,
  asyncHandler(controller.handleProjectInfoChangeRequest)
);
router.get('/projects/:id/tasks', ...protectedRoute, asyncHandler(controller.getProjectTasks));
router.get(
  '/projects/:id/todos',
  ...protectedRoute,
  asyncHandler(controller.getProjectTodos)
);
router.post(
  '/projects/:id/action-items',
  ...protectedRoute,
  actionItemMediaUpload.array('media', 9),
  setUploadedFilePermissions,
  asyncHandler(controller.createProjectActionItem)
);
router.post(
  '/projects/:id/action-items/:itemId/feedback',
  ...protectedRoute,
  actionItemMediaUpload.array('media', 9),
  setUploadedFilePermissions,
  asyncHandler(controller.submitProjectActionItemFeedback)
);
router.get('/projects/:id/progress', ...protectedRoute, asyncHandler(controller.getProjectProgress));
router.get(
  '/projects/:id/work-item-templates',
  ...protectedRoute,
  asyncHandler(controller.getProjectWorkItemTemplates)
);
router.put(
  '/projects/:id/work-item-templates/:templateKey/status',
  ...protectedRoute,
  asyncHandler(controller.updateProjectWorkItemTemplateStatus)
);
router.get(
  '/projects/:id/progress-proposal',
  ...protectedRoute,
  asyncHandler(controller.getProgressProposal)
);
router.post(
  '/projects/:id/progress-proposal',
  ...protectedRoute,
  asyncHandler(controller.submitProgressProposal)
);
router.put(
  '/projects/:id/progress-proposal/:proposalId',
  ...protectedRoute,
  asyncHandler(controller.reviewProgressProposal)
);
router.put(
  '/projects/:id/pace',
  ...protectedRoute,
  asyncHandler(controller.updateProjectPace)
);
router.put(
  '/projects/:id/tasks/:taskId/plan',
  ...protectedRoute,
  asyncHandler(controller.planProjectTask)
);
router.post(
  '/projects/:id/tasks',
  ...protectedRoute,
  asyncHandler(controller.createProjectTask)
);
router.delete(
  '/projects/:id/tasks/:taskId',
  ...protectedRoute,
  asyncHandler(controller.deleteProjectTask)
);
router.put(
  '/projects/:id/stages/:stageId/complete',
  ...protectedRoute,
  asyncHandler(controller.completeProjectStage)
);
router.get(
  '/projects/:id/space-change-requests',
  ...protectedRoute,
  asyncHandler(controller.getProjectSpaceChangeRequests)
);
router.put(
  '/projects/:id/space-change-requests/:requestId',
  ...protectedRoute,
  asyncHandler(controller.handleProjectSpaceChangeRequest)
);
router.get(
  '/projects/:id/case-shares',
  ...protectedRoute,
  asyncHandler(controller.getProjectCaseShares)
);
router.post(
  '/projects/:id/case-shares',
  ...protectedRoute,
  asyncHandler(controller.createProjectCaseShare)
);
router.put(
  '/projects/:id/case-shares/:caseId',
  ...protectedRoute,
  asyncHandler(controller.handleProjectCaseShare)
);
router.get(
  '/projects/:id/progress-items',
  ...protectedRoute,
  asyncHandler(controller.getProjectProgressItems)
);
router.post(
  '/projects/:id/progress-items',
  ...protectedRoute,
  asyncHandler(controller.createProjectProgressItem)
);
router.put(
  '/projects/:id/progress-items/:itemId',
  ...protectedRoute,
  asyncHandler(controller.updateProjectProgressItem)
);
router.delete(
  '/projects/:id/progress-items/:itemId',
  ...protectedRoute,
  asyncHandler(controller.deleteProjectProgressItem)
);
router.get(
  '/projects/:id/inspections',
  ...protectedRoute,
  asyncHandler(controller.getProjectInspections)
);
router.get(
  '/projects/:id/inspection-templates',
  ...protectedRoute,
  inspectionKbGate,
  asyncHandler(controller.getProjectInspectionTemplates)
);
router.get(
  '/projects/:id/inspection-templates/:templateId',
  ...protectedRoute,
  inspectionKbGate,
  asyncHandler(controller.getProjectInspectionTemplateDetail)
);
router.post(
  '/projects/:id/inspections',
  ...protectedRoute,
  inspectionImageUpload.array('images', 9),
  setUploadedFilePermissions,
  asyncHandler(controller.createProjectInspection)
);
router.put(
  '/projects/:id/inspections/:inspectionId/review',
  ...protectedRoute,
  asyncHandler(controller.reviewProjectInspection)
);
router.post(
  '/projects/:id/inspections/:inspectionId/resubmit',
  ...protectedRoute,
  inspectionImageUpload.array('images', 9),
  setUploadedFilePermissions,
  asyncHandler(controller.resubmitProjectInspection)
);
router.get('/projects/:id/members', ...protectedRoute, asyncHandler(controller.getProjectMembers));
router.get(
  '/projects/:id/check-ins',
  ...protectedRoute,
  asyncHandler(controller.getProjectCheckIns)
);
router.post(
  '/projects/:id/check-ins',
  ...protectedRoute,
  checkInMediaUpload.array('media', 10),
  setUploadedFilePermissions,
  asyncHandler(controller.createProjectCheckIn)
);
router.put(
  '/projects/:id/check-ins/:checkInId/share-members',
  ...protectedRoute,
  asyncHandler(controller.updateProjectCheckInShares)
);
router.post(
  '/projects/:id/check-ins/:checkInId/share-to-circle',
  ...protectedRoute,
  asyncHandler(controller.shareProjectCheckInToCircle)
);
router.delete(
  '/projects/:id/check-ins/:checkInId',
  ...protectedRoute,
  asyncHandler(controller.deleteProjectCheckIn)
);
router.get(
  '/projects/:id/expenses',
  ...protectedRoute,
  asyncHandler(controller.getProjectExpenses)
);
router.post(
  '/projects/:id/expenses',
  ...protectedRoute,
  expenseMediaUpload.array('receipts', 9),
  setUploadedFilePermissions,
  asyncHandler(controller.createProjectExpense)
);
router.put(
  '/projects/:id/expenses/:expenseId',
  ...protectedRoute,
  asyncHandler(controller.updateProjectExpense)
);
router.delete(
  '/projects/:id/expenses/:expenseId',
  ...protectedRoute,
  asyncHandler(controller.deleteProjectExpense)
);
router.get(
  '/projects/:id/design-documents',
  ...protectedRoute,
  asyncHandler(controller.getProjectDesignDocuments)
);
router.post(
  '/projects/:id/design-documents/upload',
  ...protectedRoute,
  designDocumentUpload.single('image'),
  setUploadedFilePermissions,
  asyncHandler(controller.uploadProjectDesignDocument)
);
router.post(
  '/projects/:id/design-documents',
  ...protectedRoute,
  asyncHandler(controller.createProjectDesignDocument)
);
router.put(
  '/projects/:id/design-documents/:documentId/status',
  ...protectedRoute,
  asyncHandler(controller.updateProjectDesignDocumentStatus)
);
router.get(
  '/projects/:id/handovers',
  ...protectedRoute,
  asyncHandler(controller.getProjectHandovers)
);
router.post(
  '/projects/:id/handovers',
  ...protectedRoute,
  handoverMediaUpload.array('images', 9),
  setUploadedFilePermissions,
  asyncHandler(controller.createProjectHandover)
);
router.put(
  '/projects/:id/handovers/:handoverId/status',
  ...protectedRoute,
  asyncHandler(controller.updateProjectHandoverStatus)
);
router.get(
  '/projects/:id/materials',
  ...protectedRoute,
  asyncHandler(controller.getProjectMaterials)
);
router.post(
  '/projects/:id/materials',
  ...protectedRoute,
  materialMediaUpload.array('images', 9),
  setUploadedFilePermissions,
  asyncHandler(controller.createProjectMaterial)
);
router.put(
  '/projects/:id/materials/:materialId/confirm',
  ...protectedRoute,
  asyncHandler(controller.confirmProjectMaterial)
);
router.get(
  '/projects/:id/spaces',
  ...protectedRoute,
  asyncHandler(controller.getProjectSpaces)
);
router.post(
  '/projects/:id/spaces',
  ...protectedRoute,
  asyncHandler(controller.createProjectSpace)
);
router.delete(
  '/projects/:id/spaces/:spaceId',
  ...protectedRoute,
  asyncHandler(controller.deleteProjectSpace)
);
router.post(
  '/projects/:id/spaces/:spaceId/images',
  ...protectedRoute,
  projectImageUpload.array('images', 12),
  setUploadedFilePermissions,
  asyncHandler(controller.uploadProjectSpaceImages)
);
router.put(
  '/projects/:id/spaces/:spaceId/images/:imageId/default',
  ...protectedRoute,
  asyncHandler(controller.setDefaultProjectSpaceImage)
);
router.delete(
  '/projects/:id/spaces/:spaceId/images/:imageId',
  ...protectedRoute,
  asyncHandler(controller.deleteProjectSpaceImage)
);
router.delete(
  '/projects/:id/members/:memberId',
  ...protectedRoute,
  asyncHandler(controller.removeProjectMember)
);
router.get('/member-candidates', ...protectedRoute, asyncHandler(controller.getMemberCandidates));
router.post('/member-requests', ...protectedRoute, asyncHandler(controller.requestProjectMember));
router.get(
  '/projects/:id/member-requests',
  ...protectedRoute,
  asyncHandler(controller.getSentMemberRequests)
);
router.delete(
  '/projects/:id/member-requests/:requestId',
  ...protectedRoute,
  asyncHandler(controller.cancelMemberRequest)
);
router.get(
  '/member-requests/received',
  ...protectedRoute,
  asyncHandler(controller.getReceivedMemberRequests)
);
router.put(
  '/member-requests/:id',
  ...protectedRoute,
  asyncHandler(controller.handleMemberRequest)
);
router.get('/stages/:id/tasks', ...protectedRoute, asyncHandler(controller.getStageTasks));
router.get('/checklist', ...protectedRoute, asyncHandler(controller.getChecklist));

router.post('/setup', ...protectedRoute, asyncHandler(controller.setup));
router.post(
  '/floor-plan',
  ...protectedRoute,
  floorPlanUpload.single('floor_plan'),
  setUploadedFilePermissions,
  asyncHandler(controller.uploadFloorPlan)
);
router.get('/calendar', ...protectedRoute, asyncHandler(controller.getCalendar));
router.get('/tips', ...protectedRoute, asyncHandler(controller.getTips));
router.get('/stage/:stageId', ...protectedRoute, asyncHandler(controller.getStageDetail));
router.put('/task/:taskId', ...protectedRoute, asyncHandler(controller.updateTask));
router.put('/info', ...protectedRoute, asyncHandler(controller.updateInfo));
router.delete('/', ...protectedRoute, asyncHandler(controller.resetProject));

// 业主 - 找设计师
router.get('/users', ...protectedRoute, asyncHandler(controller.listUsers));
router.post('/designer-request', ...protectedRoute, asyncHandler(controller.requestDesigner));
router.post('/designer', ...protectedRoute, asyncHandler(controller.bindDesigner));
router.delete('/designer', ...protectedRoute, asyncHandler(controller.unbindDesigner));

// 设计师 - 我的工地
router.get('/my-projects', ...protectedRoute, asyncHandler(controller.getMyProjects));
router.get('/my-requests', ...protectedRoute, asyncHandler(controller.getReceivedRequests));
router.put('/my-requests/:id', ...protectedRoute, asyncHandler(controller.handleRequest));
router.get('/project-owners', ...protectedRoute, asyncHandler(controller.searchProjectOwners));
router.post('/project-invitations', ...protectedRoute, asyncHandler(controller.inviteProjectOwner));
router.get('/project-invitations', ...protectedRoute, asyncHandler(controller.getProjectInvitations));
router.put('/project-invitations/:id', ...protectedRoute, asyncHandler(controller.handleProjectInvitation));
router.get('/designers', ...protectedRoute, asyncHandler(controller.getDesigners));

// 设计师 - 管理任务
router.put('/task/:taskId', ...protectedRoute, asyncHandler(controller.updateTask));
router.put('/task/:taskId/plan', ...protectedRoute, asyncHandler(controller.planTask));
router.post('/task', ...protectedRoute, asyncHandler(controller.addTask));
router.put('/stage/:stageId/complete', ...protectedRoute, asyncHandler(controller.completeStage));

module.exports = router;
