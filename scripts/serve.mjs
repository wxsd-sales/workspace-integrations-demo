import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startStaticServer } from "./lib/server.mjs";

const root = join(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  "webapp",
);
const port = Number(process.env.PORT) || 8080;

const { url } = await startStaticServer({ root, port });

console.log(`Serving ${root}`);
console.log(`  App: ${url}/`);
console.log("\nPress Ctrl+C to stop.");
