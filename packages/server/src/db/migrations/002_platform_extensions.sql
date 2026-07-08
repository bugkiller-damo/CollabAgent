-- ============================================================
-- Phase 0: 平台扩展 — 多租户 / 资产 / 渗透任务 / 病例库 / 告警 / 审计
-- ============================================================
-- 向后兼容：所有新表使用 IF NOT EXISTS，ALTER 使用 ADD COLUMN IF NOT EXISTS
-- ============================================================

-- ---- 1. 组织扩展（servers 表增加多级组织支持） ----

ALTER TABLE servers ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'subsidiary';
ALTER TABLE servers ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES servers(id);
ALTER TABLE servers ADD COLUMN IF NOT EXISTS level INT NOT NULL DEFAULT 2;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE servers ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}';
ALTER TABLE servers ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_servers_type ON servers(type);
CREATE INDEX IF NOT EXISTS idx_servers_parent ON servers(parent_id);

COMMENT ON COLUMN servers.type      IS '组织层级: group=集团, subsidiary=子公司';
COMMENT ON COLUMN servers.level     IS '1=group(集团), 2=subsidiary(子公司)';
COMMENT ON COLUMN servers.config    IS '监管策略 JSON (ScanStrategy/SecurityControl/CaseDistribution/AlertReport)';

-- ---- 2. 资产表 ----

CREATE TABLE IF NOT EXISTS assets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subsidiary_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    ip              INET NOT NULL,
    hostname        VARCHAR(255),
    domain          VARCHAR(255),
    os              VARCHAR(100),
    open_ports      INTEGER[] DEFAULT '{}',
    services        JSONB DEFAULT '[]',
    fingerprints    JSONB DEFAULT '{}',
    asset_level     VARCHAR(20) NOT NULL DEFAULT 'general',
    tags            TEXT[] DEFAULT '{}',
    status          VARCHAR(20) NOT NULL DEFAULT 'active',
    discovered_at   TIMESTAMPTZ DEFAULT now(),
    last_seen_at    TIMESTAMPTZ DEFAULT now(),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assets_subsidiary   ON assets(subsidiary_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_subsidiary_ip ON assets(subsidiary_id, ip);
CREATE INDEX IF NOT EXISTS idx_assets_level         ON assets(asset_level);
CREATE INDEX IF NOT EXISTS idx_assets_tags          ON assets USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_assets_services      ON assets USING GIN(services jsonb_path_ops);

COMMENT ON TABLE  assets           IS '子公司资产清单（IP/域名/服务/指纹/等级）';

-- ---- 3. 渗透任务表 ----

DO $$ BEGIN
    CREATE TYPE task_status AS ENUM (
        'pending', 'queued', 'running', 'paused',
        'completed', 'failed', 'terminated', 'cancelled'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE task_priority AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS penetration_tasks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subsidiary_id       UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    task_type           VARCHAR(50) NOT NULL,
    task_name           VARCHAR(255) NOT NULL,
    status              task_status NOT NULL DEFAULT 'pending',
    priority            task_priority NOT NULL DEFAULT 'MEDIUM',
    scan_profile        VARCHAR(20) DEFAULT 'standard',
    targets             JSONB NOT NULL,
    allowed_operations  TEXT[] DEFAULT '{}',
    restricted_operations TEXT[] DEFAULT '{}',
    max_concurrency     INT DEFAULT 10,
    timeout_seconds     INT DEFAULT 3600,
    checkpoints         JSONB DEFAULT '[]',
    progress_percent    INT DEFAULT 0,
    total_targets       INT DEFAULT 0,
    completed_targets   INT DEFAULT 0,
    findings_summary    JSONB DEFAULT '{}',
    engine_ref          VARCHAR(255),
    callback_url        VARCHAR(500),
    idempotency_key     VARCHAR(64) UNIQUE,
    created_by          UUID NOT NULL,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tasks_subsidiary    ON penetration_tasks(subsidiary_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status        ON penetration_tasks(subsidiary_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority      ON penetration_tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_created       ON penetration_tasks(created_at DESC);

-- ---- 4. 渗透结果表 ----

CREATE TABLE IF NOT EXISTS penetration_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         UUID NOT NULL REFERENCES penetration_tasks(id) ON DELETE CASCADE,
    target          INET NOT NULL,
    hostname        VARCHAR(255),
    vuln_id         VARCHAR(100),
    title           VARCHAR(500) NOT NULL,
    cvss_score      DECIMAL(3,1),
    severity        VARCHAR(20) NOT NULL,
    vuln_type       VARCHAR(50) NOT NULL,
    affected_component JSONB,
    attack_path     JSONB,
    exploit_evidence JSONB,
    remediation     JSONB,
    discovered_at   TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_results_task       ON penetration_results(task_id);
CREATE INDEX IF NOT EXISTS idx_results_severity   ON penetration_results(severity);

-- ---- 5. 攻击图表 ----

CREATE TABLE IF NOT EXISTS attack_graphs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         UUID NOT NULL REFERENCES penetration_tasks(id) ON DELETE CASCADE,
    nodes           JSONB NOT NULL,
    edges           JSONB NOT NULL,
    version         INT NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_task_version ON attack_graphs(task_id, version);

-- ---- 6. 病例库表 ----

DO $$ BEGIN
    CREATE TYPE case_status AS ENUM (
        'draft', 'pending_review', 'published', 'rejected', 'archived'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS cases (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subsidiary_id       UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    status              case_status NOT NULL DEFAULT 'draft',
    version             INT NOT NULL DEFAULT 1,
    title               VARCHAR(500) NOT NULL,
    cve_id              VARCHAR(50),
    cvss_score          DECIMAL(3,1) NOT NULL,
    severity            VARCHAR(20) NOT NULL,
    vuln_type           VARCHAR(50) NOT NULL,
    affected_component  JSONB,
    tags                TEXT[] DEFAULT '{}',
    entry_point         TEXT,
    chain_summary       TEXT,
    final_impact        TEXT,
    poc_summary         TEXT,
    poc_access_level    VARCHAR(20) DEFAULT 'restricted',
    verification_ref    VARCHAR(500),
    remediation_immediate  TEXT,
    remediation_workaround TEXT,
    remediation_long_term  TEXT,
    affected_fingerprints JSONB DEFAULT '[]',
    distribution_status JSONB DEFAULT '{"totalPushed":0, "confirmedFixed":0, "notApplicable":0, "pending":0}',
    related_case_ids     UUID[] DEFAULT '{}',
    reviewer_id          UUID,
    review_comment       TEXT,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),
    published_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cases_subsidiary   ON cases(subsidiary_id);
CREATE INDEX IF NOT EXISTS idx_cases_status       ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_severity     ON cases(severity);
CREATE INDEX IF NOT EXISTS idx_cases_cve          ON cases(cve_id);
CREATE INDEX IF NOT EXISTS idx_cases_tags         ON cases USING GIN(tags);

-- ---- 7. 告警规则表 ----

CREATE TABLE IF NOT EXISTS alert_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subsidiary_id       UUID REFERENCES servers(id) ON DELETE CASCADE,
    name                VARCHAR(200) NOT NULL,
    description         TEXT,
    severity            VARCHAR(20) NOT NULL,
    metric              VARCHAR(100) NOT NULL,
    condition           JSONB NOT NULL,
    channels            TEXT[] NOT NULL DEFAULT '{in_app}',
    notify_interval_min INT DEFAULT 30,
    enabled             BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_subsidiary ON alert_rules(subsidiary_id);

-- ---- 8. 告警记录表 ----

CREATE TABLE IF NOT EXISTS alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id         UUID REFERENCES alert_rules(id) ON DELETE SET NULL,
    subsidiary_id   UUID REFERENCES servers(id) ON DELETE CASCADE,
    severity        VARCHAR(20) NOT NULL,
    title           VARCHAR(500) NOT NULL,
    detail          TEXT,
    source          VARCHAR(200),
    status          VARCHAR(20) NOT NULL DEFAULT 'unacknowledged',
    channels_used   TEXT[] DEFAULT '{}',
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by UUID,
    resolved_at     TIMESTAMPTZ,
    trace_id        VARCHAR(64),
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_status      ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_severity    ON alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_subsidiary  ON alerts(subsidiary_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created     ON alerts(created_at DESC);

-- ---- 9. 适配器注册表 ----

CREATE TABLE IF NOT EXISTS adapters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(200) NOT NULL,
    adapter_type    VARCHAR(50) NOT NULL,
    provider        VARCHAR(100) NOT NULL,
    endpoint        VARCHAR(500),
    auth_type       VARCHAR(20) DEFAULT 'api_key',
    auth_config     JSONB DEFAULT '{}',
    options         JSONB DEFAULT '{}',
    health_status   VARCHAR(20) DEFAULT 'unknown',
    enabled         BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_adapters_type ON adapters(adapter_type);

-- ---- 10. 审计日志表 ----

CREATE TABLE IF NOT EXISTS audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subsidiary_id   UUID REFERENCES servers(id) ON DELETE SET NULL,
    actor_id        UUID NOT NULL,
    actor_type      VARCHAR(20) NOT NULL,
    action          VARCHAR(100) NOT NULL,
    target_type     VARCHAR(50),
    target_id       VARCHAR(100),
    detail          JSONB DEFAULT '{}',
    ip_address      INET,
    user_agent      TEXT,
    trace_id        VARCHAR(64),
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_subsidiary   ON audit_logs(subsidiary_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor        ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action       ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created      ON audit_logs(created_at DESC);

-- ---- 11. RBAC 角色表 ----

CREATE TABLE IF NOT EXISTS roles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL UNIQUE,
    description     TEXT,
    is_system       BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    resource        VARCHAR(100) NOT NULL,
    action          VARCHAR(50) NOT NULL,
    constraint_type VARCHAR(20) DEFAULT 'allow',
    scope           VARCHAR(20) DEFAULT 'global',
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(role_id, resource, action)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);

-- ---- 12. 系统预置角色 ----

INSERT INTO roles (name, description, is_system) VALUES
    ('system_admin',    '系统管理员：全部权限', true),
    ('security_analyst', '安全分析师：只读+分析', true),
    ('pen_tester',      '渗透测试员：执行权限', true),
    ('approval_admin',  '审批管理员：审核病例/审批高风险', true),
    ('auditor',         '审计员：只读审计', true),
    ('subsidiary_admin','子公司管理员：本公司全权', true)
ON CONFLICT (name) DO NOTHING;

-- ---- 13. agents 表扩展 ----

ALTER TABLE agents ADD COLUMN IF NOT EXISTS role VARCHAR(50);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS capabilities JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN agents.role IS '智能体角色（brain/coordinator/recon/planner/execution/privilege/lateral）';
