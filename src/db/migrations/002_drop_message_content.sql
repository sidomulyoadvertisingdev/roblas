-- 002_drop_message_content.sql
-- Privacy: hapus konten pesan dari log, cukup simpan panjangnya untuk audit.

ALTER TABLE send_log
  DROP COLUMN message,
  ADD COLUMN message_length INT UNSIGNED NOT NULL DEFAULT 0 AFTER phone_to;

ALTER TABLE incoming_log
  DROP COLUMN body,
  ADD COLUMN body_length INT UNSIGNED NOT NULL DEFAULT 0 AFTER from_phone;
