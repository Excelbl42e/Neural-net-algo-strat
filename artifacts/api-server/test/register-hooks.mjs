/** Installs ts-resolve-hook for the test run: `node --import ./test/register-hooks.mjs --test ...` */
import { register } from "node:module";
register("./ts-resolve-hook.mjs", import.meta.url);
