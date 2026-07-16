-- Migration 006: Link users to tenants

ALTER TABLE users
    ADD COLUMN tenant_id VARCHAR(36) NULL AFTER role,
    ADD INDEX idx_users_tenant (tenant_id);

-- Backfill: assign all existing users to default tenant
UPDATE users SET tenant_id = 'default-tenant-id' WHERE tenant_id IS NULL;

-- Auto-create tenant + assign admin role for new users
-- Handled in application code (passport.ts)
