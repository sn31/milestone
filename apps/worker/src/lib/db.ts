/** The process's one Db (one pg pool), shared with the web app's helpers when both run in one process (tests). */
export { getDb } from "@milestone/core";
