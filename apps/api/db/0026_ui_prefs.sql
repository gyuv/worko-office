-- Per-user display preferences (theme, accent, text size, density, motion, glass, hidden sidebar modules). Not synced.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_prefs jsonb NOT NULL DEFAULT '{}';
