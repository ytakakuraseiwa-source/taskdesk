CREATE TABLE task_history (
  user_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('comment', 'result')),
  text TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (user_id, task_id, id),
  FOREIGN KEY (user_id, task_id) REFERENCES tasks(user_id, id)
);
CREATE INDEX task_history_by_date ON task_history(user_id, task_id, created DESC, id);
