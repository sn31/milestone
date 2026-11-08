import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { storedFileSchema, type StoredFile } from "./stored-file.js";

export type ApiMilestonesUploadResponse = {
  ok: boolean;
  deliveryId: string;
  files: StoredFile[];
};

export const apiMilestonesUploadResponseSchema: Schema<ApiMilestonesUploadResponse> =
  s.object<ApiMilestonesUploadResponse>({
    ok: s.boolean(),
    deliveryId: s.string(),
    files: s.array(s.lazy(() => storedFileSchema)),
  });
