import { readFileSync } from 'node:fs';
const definitionUrl = new URL('../config/definition.json', import.meta.url);
export const defaultDefinition = Object.freeze(JSON.parse(readFileSync(definitionUrl, 'utf8')));
