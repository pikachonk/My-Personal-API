CREATE TABLE work_rules (
  type TEXT NOT NULL CHECK(type IN ('app', 'website')),
  label TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('work', 'personal')),
  PRIMARY KEY(type, label)
);
