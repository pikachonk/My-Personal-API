CREATE TABLE work_ai_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  last_error TEXT NOT NULL DEFAULT ''
);
INSERT INTO work_ai_settings(id, enabled) VALUES(1, 0);

CREATE TABLE work_ai_suggestions (
  label TEXT PRIMARY KEY,
  classification TEXT NOT NULL CHECK(classification IN ('pending', 'work', 'personal', 'unsure')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE work_ai_quota (
  day TEXT PRIMARY KEY,
  used INTEGER NOT NULL CHECK(used >= 0)
);
