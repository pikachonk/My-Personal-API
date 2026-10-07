ALTER TABLE entries ADD COLUMN nutrition_json TEXT NOT NULL DEFAULT '';

CREATE TABLE food_ai_quota (
  day TEXT PRIMARY KEY,
  used INTEGER NOT NULL CHECK(used >= 0)
);
