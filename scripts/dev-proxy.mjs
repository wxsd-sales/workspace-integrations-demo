import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startStaticServer } from "./lib/server.mjs";
import { handleWebexProxy } from "./lib/webex-proxy.mjs";

const root = join(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  "webapp",
);
const port = Number(process.env.PORT) || 8080;

const { url } = await startStaticServer({
  root,
  port,
  handleRequest: handleWebexProxy,
});

console.log(`Serving ${root} with a localhost Webex API proxy`);
console.log(`  App:   ${url}/`);
console.log(`  Proxy: ${url}/proxy?url=`);
console.log(
  "\nOpen the app URL above. Webex requests are forwarded from /proxy.",
);
console.log(
  "This helper binds to 127.0.0.1 only and is not used on GitHub Pages.",
);
console.log("\nPress Ctrl+C to stop.");
