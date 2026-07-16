ALTER TABLE tenant_ai_config ADD COLUMN business_knowledge LONGTEXT NULL AFTER system_prompt;

ALTER TABLE tenant_ai_config ADD COLUMN webhook_schema LONGTEXT NULL AFTER business_knowledge;

ALTER TABLE tenant_ai_config ADD COLUMN response_instructions TEXT NULL AFTER response_template;
