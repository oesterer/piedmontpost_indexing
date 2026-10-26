import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const SITE_DIR=path.resolve(process.env.SEARCH_SITE_DIR||path.join(ROOT,'../piedmontpost'));
export const OUTPUT_DIR=path.resolve(process.env.SEARCH_OUTPUT_DIR||path.join(ROOT,'output'));
