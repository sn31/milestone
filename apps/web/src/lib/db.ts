import { createDb, type Db } from "@milestone/core";

let db: Db | null = null;
export function getDb(): Db {
  db ??= createDb();
  return db;
}
