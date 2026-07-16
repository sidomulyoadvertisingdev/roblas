-- Migration 007: Add tenant_id to data tables (contacts, incoming_log, send_log, agents)

-- contacts
ALTER TABLE contacts
    ADD COLUMN tenant_id VARCHAR(36) NULL AFTER id,
    ADD INDEX idx_contacts_tenant (tenant_id);

-- incoming_log
ALTER TABLE incoming_log
    ADD COLUMN tenant_id VARCHAR(36) NULL AFTER id,
    ADD INDEX idx_incoming_log_tenant (tenant_id);

-- send_log
ALTER TABLE send_log
    ADD COLUMN tenant_id VARCHAR(36) NULL AFTER id,
    ADD INDEX idx_send_log_tenant (tenant_id);

-- agents
ALTER TABLE agents
    ADD COLUMN tenant_id VARCHAR(36) NULL AFTER id,
    ADD INDEX idx_agents_tenant (tenant_id);

-- Backfill existing data to default tenant
UPDATE contacts SET tenant_id = 'default-tenant-id' WHERE tenant_id IS NULL;
UPDATE incoming_log SET tenant_id = 'default-tenant-id' WHERE tenant_id IS NULL;
UPDATE send_log SET tenant_id = 'default-tenant-id' WHERE tenant_id IS NULL;
UPDATE agents SET tenant_id = 'default-tenant-id' WHERE tenant_id IS NULL;

-- Promote hidayat to admin of default tenant
UPDATE users SET role = 'admin' WHERE email = 'hidayatsyahidin1@gmail.com';
