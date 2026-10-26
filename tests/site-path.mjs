import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {SITE_DIR} from '../scripts/paths.mjs';
export const siteURL=pathToFileURL(SITE_DIR+path.sep);
