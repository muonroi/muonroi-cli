import * as crypto from "node:crypto";
import { slugify } from "../utils/slugify.js";

const HASH_LEN = 8;
const SUFFIX_MAX_LEN = 40;

export function productSlug(idea: string): string {
  const h = crypto.createHash("sha1").update(idea).digest("hex").slice(0, HASH_LEN);
  const s = slugify(idea).slice(0, SUFFIX_MAX_LEN);
  return s ? `${h}-${s}` : h;
}
