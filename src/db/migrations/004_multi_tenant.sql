-- Migration 004: Multi-Tenant SaaS Schema
-- Adds tenant isolation for WhatsApp gateway

CREATE TABLE IF NOT EXISTS tenants (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    plan ENUM('free', 'pro', 'enterprise') NOT NULL DEFAULT 'free',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_wa_accounts (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    client_id VARCHAR(100) NOT NULL UNIQUE,
    phone VARCHAR(20) NOT NULL,
    display_name VARCHAR(255) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    auth_session_path VARCHAR(255) NOT NULL DEFAULT './data/auth',
    last_ready_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_config (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    config_key VARCHAR(64) NOT NULL,
    config_value TEXT NULL,
    is_secret TINYINT(1) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_tenant_config (tenant_id, config_key),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_ai_config (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    provider ENUM('groq', 'openai', 'custom') NOT NULL DEFAULT 'groq',
    api_key TEXT NULL,
    model VARCHAR(100) NOT NULL DEFAULT 'llama-3.1-8b-instant',
    system_prompt TEXT NULL,
    response_template TEXT NULL,
    max_tokens INT NOT NULL DEFAULT 256,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_tenant_ai (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_api_keys (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    key_prefix VARCHAR(20) NOT NULL,
    permissions JSON NULL,
    expires_at TIMESTAMP NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed default tenant for existing data
INSERT IGNORE INTO tenants (id, name, slug, is_active, plan) VALUES
    ('default-tenant-id', 'Default Tenant', 'default', 1, 'pro');

-- Link existing agent to default tenant
INSERT IGNORE INTO tenant_wa_accounts (id, tenant_id, client_id, phone, display_name, is_active, auth_session_path)
SELECT
    UUID() as id,
    'default-tenant-id' as tenant_id,
    client_id,
    phone,
    display_name,
    is_active,
    './data/auth' as auth_session_path
FROM agents
ON DUPLICATE KEY UPDATE phone = VALUES(phone);
