-- ============================================================================
-- 025_metrics_admin_bootstrap.sql — P1.30：metrics admin 门禁的前置数据补齐
--
-- 背景：/api/metrics(/history) 起加「非个人社区 owner」门禁，但默认社区
-- （Default Server）由种子逻辑创建，owner_id 为 NULL（index.ts 自动播种）
-- 或仅有 created_by（db/seed.ts）——不回填则门禁上线后没有任何用户是 admin，
-- 管理后台运行指标页对所有部署永久 403（自锁）。
--
-- 本迁移（幂等，可重入）：
--   1. 非个人社区 owner_id IS NULL 且 created_by 非空 → owner_id := created_by
--      （创建者即部署者/社区发起人的既有语义）；
--   2. 所有非个人社区：owner_id 非空但缺 server_members owner 行 → 补齐
--      （isOrgOwner/isInstanceAdmin 双口径之一，成员列表页也依赖该行展示）。
--
-- created_by 亦为 NULL 的（自动播种全新部署）不在此回填——由 index.ts 启动
-- bootstrap「默认社区无主且已有用户 → 擢升最早注册用户」在后续启动覆盖。
-- ============================================================================

UPDATE servers SET owner_id = created_by
 WHERE personal = false AND owner_id IS NULL AND created_by IS NOT NULL;

INSERT INTO server_members (server_id, user_id, role)
SELECT s.id, s.owner_id, 'owner'
  FROM servers s
 WHERE s.personal = false
   AND s.owner_id IS NOT NULL
ON CONFLICT (server_id, user_id) DO UPDATE SET role = 'owner';
-- 既有 member 行（如经邀请加入的创建者）升级为 owner，避免「owner 在成员页显示为
-- member」的口径分裂；ON CONFLICT DO UPDATE 同时覆盖「缺行补行」与「有行升级」。
