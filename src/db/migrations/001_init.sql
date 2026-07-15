-- 001_init.sql
-- Initial schema for RoroJonggrang WA Service.

CREATE TABLE IF NOT EXISTS agents (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id VARCHAR(64) NOT NULL UNIQUE,
  phone VARCHAR(30) NOT NULL,
  display_name VARCHAR(100) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_ready_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS send_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  agent_id INT UNSIGNED NOT NULL,
  phone_to VARCHAR(30) NOT NULL,
  message TEXT NOT NULL,
  status ENUM('sent','failed') NOT NULL,
  message_id VARCHAR(255) NULL,
  error TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_agent_created (agent_id, created_at),
  INDEX idx_phone (phone_to),
  CONSTRAINT fk_send_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS incoming_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  agent_id INT UNSIGNED NOT NULL,
  wa_message_id VARCHAR(255) NOT NULL,
  from_phone VARCHAR(30) NOT NULL,
  body MEDIUMTEXT NULL,
  msg_type VARCHAR(30) NULL,
  is_group TINYINT(1) NOT NULL DEFAULT 0,
  has_media TINYINT(1) NOT NULL DEFAULT 0,
  webhook_status ENUM('pending','delivered','failed','skipped') NOT NULL DEFAULT 'pending',
  webhook_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  webhook_last_error TEXT NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wa_msg (agent_id, wa_message_id),
  INDEX idx_from (from_phone),
  INDEX idx_status (webhook_status),
  CONSTRAINT fk_in_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contacts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(30) NOT NULL,
  name VARCHAR(100) NULL,
  role VARCHAR(50) NULL,
  agent_id INT UNSIGNED NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_phone_agent (phone, agent_id),
  CONSTRAINT fk_contact_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
