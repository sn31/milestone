import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type StoredFile = {
  name: string;
  size: number;
  sha256: string;
  mime: string;
};

export const storedFileSchema: Schema<StoredFile> = s.object<StoredFile>({
  name: s.string(),
  size: s.int(),
  sha256: s.string(),
  mime: s.string(),
});
