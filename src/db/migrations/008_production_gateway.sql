-- Migration 008: Production Gateway Layer
-- Adds usage logging, plan limits, and health tracking

CREATE TABLE IF NOT EXISTS tenant_usage_log (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    provider VARCHAR(20) NOT NULL,
    model VARCHAR(100) NOT NULL,
    prompt_tokens INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    total_tokens INT NOT NULL DEFAULT 0,
    latency_ms INT NOT NULL DEFAULT 0,
    intent VARCHAR(50) NOT NULL DEFAULT 'unknown',
    success TINYINT(1) NOT NULL DEFAULT 1,
    error_message TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_tenant_date (tenant_id, created_at),
    INDEX idx_tenant_intent (tenant_id, intent),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_health (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    wa_connected TINYINT(1) NOT NULL DEFAULT 0,
    wa_phone VARCHAR(20) NULL,
    last_message_at TIMESTAMP NULL,
    last_ai_call_at TIMESTAMP NULL,
    last_backend_call_at TIMESTAMP NULL,
    backend_healthy TINYINT(1) NULL,
    error_count INT NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    last_error_at TIMESTAMP NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_tenant_health (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
