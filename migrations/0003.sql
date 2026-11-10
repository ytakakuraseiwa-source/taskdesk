ALTER TABLE task_history ADD COLUMN stage TEXT CHECK(stage IN ('doing', 'done'));
