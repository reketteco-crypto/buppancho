import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { generatedIgnores } from "./eslint.ignores.mjs";

export default defineConfig([...nextVitals, ...nextTypescript, globalIgnores(generatedIgnores)]);
