BEGIN;
ALTER TABLE kudiroll_auth_sessions DROP CONSTRAINT IF EXISTS kudiroll_auth_sessions_method_check;
ALTER TABLE kudiroll_auth_sessions ADD CONSTRAINT kudiroll_auth_sessions_method_check CHECK (method IN ('wallet', 'passkey', 'email'));
ALTER TABLE kudiroll_auth_challenges DROP CONSTRAINT IF EXISTS kudiroll_auth_challenges_purpose_check;
ALTER TABLE kudiroll_auth_challenges ADD CONSTRAINT kudiroll_auth_challenges_purpose_check CHECK (purpose IN ('wallet-signin', 'passkey-register', 'passkey-signin', 'passkey-prf', 'passkey-revoke', 'email-verify', 'email-signin', 'email-link'));
INSERT INTO kudiroll_schema_migrations (version) VALUES (2) ON CONFLICT DO NOTHING;
COMMIT;
