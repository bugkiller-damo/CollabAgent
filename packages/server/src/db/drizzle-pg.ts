import { pgTable as _pgTable, uuid, varchar, text, boolean, timestamp, bigint, integer, jsonb, uniqueIndex, index, primaryKey, foreignKey } from "drizzle-orm/pg-core";

// Re-export with same signatures for schema definition
export {
  _pgTable as pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  bigint,
  integer,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  foreignKey,
};
