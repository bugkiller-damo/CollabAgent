-- P1.23：提醒可靠性——daily@HH:MM 按 IANA 时区计算。
-- reminders.timezone 存 IANA 时区名（如 Asia/Shanghai）：
--   * daemon 跑在用户机器上，创建提醒时随附本机 IANA 时区（server 缺省落自己的本地 tz）；
--   * scheduler 重排时按该 tz 计算下一个 HH:MM 槽位，server 换机器/改 TZ 不再隐性改变触发时刻；
--   * NULL（存量行）回退 server 本地时区，行为与迁移前一致。
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS timezone VARCHAR(64);
