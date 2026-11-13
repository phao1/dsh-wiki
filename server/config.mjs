import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultDataDir = () => path.resolve(ROOT, process.env.DSH_WIKI_DATA_DIR || '.local-data');
export const seedPath = path.join(ROOT, 'data/seed.json');
