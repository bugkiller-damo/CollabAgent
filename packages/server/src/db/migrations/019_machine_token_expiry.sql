-- 评估报告 P1.12：machine_tokens 加默认过期（90 天滚动续期）。
-- expires_at 列自 000 就存在但从未被写入——所有存量令牌永不过期（账号级全权）。
-- 此迁移把存量 NULL 行统一回填为「迁移时刻 + 90 天」：给所有部署一个完整的
-- 轮换缓冲窗口，超期未用的令牌自然失效；活跃部署靠滚动续期保活（index.ts HTTP
-- 剩余 <30 天阈值续期、ws/handler.ts 连接即续期）。新签发一律带 90 天有效期
-- （profile.ts / computers.ts）。校验侧对 NULL 宽松（存量豁免），见
-- lib/machine-token-policy.ts 的 ACTIVE_TOKEN_PREDICATE。
UPDATE machine_tokens SET expires_at = now() + interval '90 days' WHERE expires_at IS NULL;
