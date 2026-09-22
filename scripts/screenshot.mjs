import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { startStaticServer } from "./lib/server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEBAPP = join(ROOT, "webapp");
const OUT_DIR = join(ROOT, "screenshots");
const DEFAULT_WIDTH = Number(process.env.SCREENSHOT_WIDTH) || 1280;

function isExecutable(candidate) {
  if (candidate.includes("/") || candidate.includes("\\")) {
    return existsSync(candidate);
  }
  const probe = spawnSync(platform() === "win32" ? "where" : "which", [
    candidate,
  ]);
  return probe.status === 0;
}

function resolveChrome() {
  if (process.env.CHROME_BIN) {
    if (isExecutable(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
    throw new Error(
      `CHROME_BIN is set but not executable: ${process.env.CHROME_BIN}`,
    );
  }

  const candidatesByPlatform = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    linux: [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "chrome",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  };

  const candidates = candidatesByPlatform[platform()] ?? [];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  throw new Error(
    "Could not find a headless Chrome/Chromium binary. Install Google Chrome or set CHROME_BIN to its path.",
  );
}

// Headless Chrome on macOS logs some harmless noise to stderr on every run
// (display-link and sandbox task_policy_set warnings unrelated to the
// screenshot itself). Filter known lines out so real errors stay visible.
const KNOWN_NOISE = [
  /CVDisplayLinkCreateWithCGDisplay failed/,
  /task_policy_set \w+_POLICY/,
  /Trying to load the allocator multiple times/,
];

function forwardFilteredStderr(stream) {
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      if (!KNOWN_NOISE.some((pattern) => pattern.test(line))) {
        process.stderr.write(`${line}\n`);
      }
    }
  });
}

function capture(chromeBin, url, outPath, { width, height }) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--force-device-scale-factor=1",
      `--window-size=${width},${height}`,
      "--virtual-time-budget=5000",
      `--screenshot=${outPath}`,
      url,
    ];
    const child = spawn(chromeBin, args, { stdio: ["ignore", "inherit", "pipe"] });
    forwardFilteredStderr(child.stderr);
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(
            new Error(`Chrome exited with code ${code} while capturing ${url}`),
          ),
    );
  });
}

const chromeBin = resolveChrome();
mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  {
    name: "readme-screenshot-create",
    path: "/?preview=create",
    width: DEFAULT_WIDTH,
    height: 2000,
  },
  {
    name: "readme-screenshot-setup",
    path: "/?preview=setup",
    width: DEFAULT_WIDTH,
    height: 620,
  },
  {
    name: "readme-screenshot-activate",
    path: "/?preview=activate",
    width: DEFAULT_WIDTH,
    height: 1750,
  },
  {
    name: "readme-screenshot-monitor",
    path: "/?preview=monitor&focus=overview",
    width: DEFAULT_WIDTH,
    height: 1340,
  },
  {
    name: "readme-screenshot-activation",
    path: "/?preview=monitor&focus=activation",
    width: DEFAULT_WIDTH,
    height: 420,
  },
  {
    name: "readme-screenshot-long-polling",
    path: "/?preview=monitor&focus=long-polling",
    width: DEFAULT_WIDTH,
    height: 420,
  },
  {
    name: "readme-screenshot-discovery",
    path: "/?preview=monitor&focus=discovery",
    width: DEFAULT_WIDTH,
    height: 700,
  },
];

// Force each theme via the "#theme=" hash so captures are deterministic and do
// not depend on the CI runner's OS colour-scheme preference.
const themes = ["light", "dark"];

const { url, close } = await startStaticServer({ root: WEBAPP, port: 0 });
try {
  for (const target of targets) {
    for (const theme of themes) {
      const outName = `${target.name}-${theme}.png`;
      const outPath = join(OUT_DIR, outName);
      const captureUrl = `${url}${target.path}#theme=${theme}`;
      await capture(chromeBin, captureUrl, outPath, {
        width: target.width,
        height: target.height,
      });
      console.log(`Captured ${outName}`);
    }
  }
} finally {
  await close();
}
