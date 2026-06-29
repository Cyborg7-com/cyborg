#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// fileURLToPath instead of import.meta.dirname so we don't require Node 20.11+.
const here = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(resolve(here, "dist", "cli.js")).href);
