import {
  pgTable as _pgTable,
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Re-export with same signatures for schema definition
export {
  _pgTable as pgTable,
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
};
