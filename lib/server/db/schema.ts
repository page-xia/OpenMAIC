/**
 * Idempotent PostgreSQL schema for the courseware backend — stored in the SAME
 * `DATABASE_URL` database as the agent runtime / server-backed persistence.
 *
 * Layout notes:
 * - `document_stages` / `document_scenes` / `document_outlines` mirror the
 *   storage package's normalized document layout (the PG reference) with the
 *   same split/reassemble semantics; the DSL version stamp lives inside the
 *   stage `data` payload.
 * - Timestamps are DOUBLE PRECISION epoch milliseconds to match the
 *   `DocumentSummary` contract (`createdAt: number`).
 * - JSON columns use `json` (not `jsonb`) so published snapshots and stage
 *   payloads round-trip byte-identical; node-postgres parses them into
 *   objects on read.
 * - Only plain `CREATE TABLE/INDEX IF NOT EXISTS` statements, applied in one
 *   simple-query round-trip and replayed safely on every boot.
 */
export const COURSEWARE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS teachers (
  id VARCHAR(64) NOT NULL,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'teacher',
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS teachers_username_unique ON teachers (username);

CREATE TABLE IF NOT EXISTS document_stages (
  id VARCHAR(64) NOT NULL,
  name VARCHAR(512) NOT NULL,
  description TEXT NULL,
  interactive_mode BOOLEAN NULL,
  task_engine_mode BOOLEAN NULL,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  owner_id VARCHAR(64) NULL,
  data JSON NOT NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS document_stages_owner_idx ON document_stages (owner_id, id);

CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id VARCHAR(64) NOT NULL,
  id VARCHAR(128) NOT NULL,
  scene_order DOUBLE PRECISION NOT NULL,
  data JSON NOT NULL,
  PRIMARY KEY (stage_id, id),
  CONSTRAINT fk_document_scenes_stage
    FOREIGN KEY (stage_id) REFERENCES document_stages (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS document_scenes_stage_order_idx ON document_scenes (stage_id, scene_order);

CREATE TABLE IF NOT EXISTS document_outlines (
  stage_id VARCHAR(64) NOT NULL,
  data JSON NOT NULL,
  PRIMARY KEY (stage_id),
  CONSTRAINT fk_document_outlines_stage
    FOREIGN KEY (stage_id) REFERENCES document_stages (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS courses (
  id VARCHAR(64) NOT NULL,
  teacher_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  source VARCHAR(16) NOT NULL DEFAULT 'blank',
  cover_asset_id VARCHAR(80) NULL,
  published_version INT NOT NULL DEFAULT 0,
  published_at DOUBLE PRECISION NULL,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_courses_stage
    FOREIGN KEY (id) REFERENCES document_stages (id) ON DELETE CASCADE,
  CONSTRAINT fk_courses_teacher
    FOREIGN KEY (teacher_id) REFERENCES teachers (id)
);
CREATE INDEX IF NOT EXISTS courses_teacher_status_idx ON courses (teacher_id, status);
CREATE INDEX IF NOT EXISTS courses_status_updated_idx ON courses (status, updated_at);

CREATE TABLE IF NOT EXISTS course_publications (
  id VARCHAR(64) NOT NULL,
  course_id VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  snapshot JSON NOT NULL,
  published_by VARCHAR(64) NOT NULL,
  published_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_course_publications_course
    FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS course_publications_course_version
  ON course_publications (course_id, version);

-- Media bytes live in the database itself (bytea): serverless targets such as
-- Vercel have no persistent writable disk, so 'data/courseware' on a local
-- volume cannot back a one-database deployment.
CREATE TABLE IF NOT EXISTS course_assets (
  id VARCHAR(80) NOT NULL,
  course_id VARCHAR(64) NULL,
  kind VARCHAR(16) NOT NULL,
  mime_type VARCHAR(128) NULL,
  size_bytes BIGINT NULL,
  duration_sec DOUBLE PRECISION NULL,
  origin VARCHAR(16) NOT NULL,
  metadata JSON NULL,
  byte_data BYTEA NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS course_assets_course_idx ON course_assets (course_id);

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key VARCHAR(128) NOT NULL,
  value_json JSON NOT NULL,
  updated_by VARCHAR(64) NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (setting_key)
);

CREATE TABLE IF NOT EXISTS students (
  id VARCHAR(64) NOT NULL,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  invited_by_code VARCHAR(32) NULL,
  created_at DOUBLE PRECISION NOT NULL,
  last_login_at DOUBLE PRECISION NULL,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS students_username_unique ON students (username);

CREATE TABLE IF NOT EXISTS student_invites (
  code VARCHAR(32) NOT NULL,
  batch_id VARCHAR(64) NULL,
  note VARCHAR(255) NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  used_by VARCHAR(64) NULL,
  used_at DOUBLE PRECISION NULL,
  PRIMARY KEY (code),
  CONSTRAINT fk_student_invites_used_by
    FOREIGN KEY (used_by) REFERENCES students (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS student_invites_batch_idx ON student_invites (batch_id);
CREATE INDEX IF NOT EXISTS student_invites_created_by_idx ON student_invites (created_by, created_at);

CREATE TABLE IF NOT EXISTS student_course_progress (
  student_id VARCHAR(64) NOT NULL,
  course_id VARCHAR(64) NOT NULL,
  max_scene_order INT NOT NULL DEFAULT 0,
  last_scene_id VARCHAR(128) NULL,
  last_scene_order INT NULL,
  open_count INT NOT NULL DEFAULT 0,
  first_opened_at DOUBLE PRECISION NOT NULL,
  last_opened_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (student_id, course_id),
  CONSTRAINT fk_progress_student
    FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_progress_course
    FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS student_course_progress_course_idx
  ON student_course_progress (course_id);

CREATE TABLE IF NOT EXISTS student_questions (
  id VARCHAR(64) NOT NULL,
  student_id VARCHAR(64) NOT NULL,
  course_id VARCHAR(64) NULL,
  question TEXT NOT NULL,
  answer TEXT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  answered_at DOUBLE PRECISION NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_questions_student
    FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS student_questions_student_idx
  ON student_questions (student_id, created_at);
`;
