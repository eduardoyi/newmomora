#!/usr/bin/env node
/**
 * generate-art.mjs — generates watercolor spot art for store assets via
 * OpenAI's image generation API (model: gpt-image-2).
 *
 * The API key is read at runtime from ../supabase/.env.local (dotenv-style
 * parse, KEY=VALUE per line). It is never printed, logged, or copied
 * anywhere else. Do not add EXPO_PUBLIC_ prefixes to it and do not commit
 * any file that contains it.
 *
 * Usage:
 *   node generate-art.mjs --prompt-file prompts/feature-hero.txt \
 *     --size 1536x1024 --out art/feature-hero.png [--dry-run]
 *
 * Supported sizes (the only ones the API accepts): 1024x1024, 1536x1024,
 * 1024x1536.
 *
 * --dry-run prints the request payload (with the key redacted) and exits
 * without making any network call. This is the default safe way to test
 * the script without spending money.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPPORTED_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);
const ENV_LOCAL_PATH = path.resolve(__dirname, "..", "supabase", ".env.local");
const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";
const MODEL = "gpt-image-2";

function parseArgs(argv) {
  const args = {
    promptFile: null,
    size: "1024x1024",
    out: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--prompt-file") args.promptFile = argv[++i];
    else if (arg === "--size") args.size = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`generate-art.mjs — generate watercolor spot art via OpenAI images API

Usage:
  node generate-art.mjs --prompt-file <path> --size <size> --out <path> [--dry-run]

Options:
  --prompt-file <path>   Path to a .txt file containing the image prompt (required)
  --size <size>          One of: 1024x1024, 1536x1024, 1024x1536 (default: 1024x1024)
  --out <path>           Output PNG path (required unless --dry-run)
  --dry-run              Print the request payload (key redacted) and exit; makes no API call
  --help, -h             Show this help text
`);
}

/**
 * Minimal dotenv-style parser: KEY=VALUE per line, ignores blank lines and
 * lines starting with #. Does not handle multi-line values or export
 * prefixes beyond a simple strip. Values may be wrapped in matching single
 * or double quotes, which are stripped.
 */
function parseEnvFile(contents) {
  const env = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    let key = line.slice(0, eqIdx).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function loadApiKey() {
  let contents;
  try {
    contents = await fs.readFile(ENV_LOCAL_PATH, "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read ${ENV_LOCAL_PATH} to load OPENAI_API_KEY. ` +
        `Make sure supabase/.env.local exists and contains OPENAI_API_KEY=...`
    );
  }
  const env = parseEnvFile(contents);
  const key = env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(`OPENAI_API_KEY not found in ${ENV_LOCAL_PATH}`);
  }
  return key;
}

function redactedPayload(payload) {
  // The payload itself never contains the key (the key goes in the
  // Authorization header, not the body), but this helper exists so the
  // dry-run output is explicit about that fact for anyone reading logs.
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.promptFile) {
    console.error("Error: --prompt-file is required.\n");
    printHelp();
    process.exit(1);
  }

  if (!SUPPORTED_SIZES.has(args.size)) {
    console.error(
      `Error: unsupported --size "${args.size}". Supported sizes: ${Array.from(SUPPORTED_SIZES).join(", ")}`
    );
    process.exit(1);
  }

  if (!args.dryRun && !args.out) {
    console.error("Error: --out is required unless --dry-run is set.\n");
    printHelp();
    process.exit(1);
  }

  const promptFilePath = path.resolve(process.cwd(), args.promptFile);
  let prompt;
  try {
    prompt = (await fs.readFile(promptFilePath, "utf-8")).trim();
  } catch (err) {
    console.error(`Error: could not read prompt file at ${promptFilePath}`);
    process.exit(1);
  }

  if (!prompt) {
    console.error(`Error: prompt file ${promptFilePath} is empty.`);
    process.exit(1);
  }

  const payload = {
    model: MODEL,
    prompt,
    size: args.size,
    n: 1,
  };

  if (args.dryRun) {
    console.log("[dry-run] Would POST to:", OPENAI_IMAGES_URL);
    console.log("[dry-run] Request payload (Authorization header key is never included here):");
    console.log(JSON.stringify(redactedPayload(payload), null, 2));
    console.log(
      `[dry-run] Would write result image to: ${args.out ? path.resolve(process.cwd(), args.out) : "(no --out given)"}`
    );
    console.log("[dry-run] No network call was made. No API key was read... actually verifying it resolves:");
    try {
      await loadApiKey();
      console.log("[dry-run] OPENAI_API_KEY was found in supabase/.env.local (value not shown).");
    } catch (err) {
      console.log(`[dry-run] Warning: ${err.message}`);
    }
    return;
  }

  const apiKey = await loadApiKey();

  console.log(`Requesting ${args.size} image from ${MODEL}...`);
  const response = await fetch(OPENAI_IMAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`OpenAI API request failed: ${response.status} ${response.statusText}\n${errText}`);
  }

  const json = await response.json();
  const b64 = json?.data?.[0]?.b64_json;
  const url = json?.data?.[0]?.url;

  const outPath = path.resolve(process.cwd(), args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  if (b64) {
    await fs.writeFile(outPath, Buffer.from(b64, "base64"));
  } else if (url) {
    const imgResponse = await fetch(url);
    const arrayBuffer = await imgResponse.arrayBuffer();
    await fs.writeFile(outPath, Buffer.from(arrayBuffer));
  } else {
    throw new Error("OpenAI response did not include b64_json or url image data.");
  }

  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
