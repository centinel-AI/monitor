BEGIN;

-- M.2.f: limpieza de residuos del modelo CentinelAI.

-- 1. Eliminar columnas created_by con FK a users.
ALTER TABLE incidents DROP COLUMN IF EXISTS created_by;
ALTER TABLE snoozed_groups DROP COLUMN IF EXISTS created_by;

-- 2. Eliminar columnas residuales de projects.
ALTER TABLE projects DROP COLUMN IF EXISTS slug;
ALTER TABLE projects DROP COLUMN IF EXISTS plan;
ALTER TABLE projects DROP COLUMN IF EXISTS stripe_id;

-- 3. Borrar la tabla users (sus FKs ya están eliminadas en paso 1).
DROP TABLE IF EXISTS users;

COMMIT;
