CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires);
CREATE TABLE tasks (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('todo', 'doing', 'done')),
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE ai_usage (
  user_id TEXT NOT NULL REFERENCES users(id),
  day TEXT NOT NULL,
  requests INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
