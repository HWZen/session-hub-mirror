import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDir = join(here, "..", "data", "probe");
const outDir = process.env["WB_PROBE_DIR"] || defaultDir;
const headLines = Number(process.env["WB_PROBE_HEAD"] || 50);
const tailLines = Number(process.env["WB_PROBE_TAIL"] || 50);

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

function safeName(value) {
  return String(value ?? "unknown").replace(/[^\w.-]+/g, "_").slice(0, 80) || "unknown";
}

async function main() {
  const stdin = await readStdin();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  let event = {};
  try {
    event = JSON.parse(stdin || "{}");
  } catch {
    // 原样落盘后继续
  }
  const eventName = safeName(event.hook_event_name);
  mkdirSync(join(outDir, "stdin"), { recursive: true });
  mkdirSync(join(outDir, "transcripts"), { recursive: true });
  writeFileSync(join(outDir, "stdin", `${ts}-${eventName}.json`), stdin || "{}", "utf8");
  const transcriptPath = typeof event.transcript_path === "string" ? event.transcript_path : null;
  if (transcriptPath) {
    try {
      const { readFileSync } = await import("node:fs");
      const lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
      const sessionTag = safeName(event.session_id);
      writeFileSync(
        join(outDir, "transcripts", `${ts}-${sessionTag}.head.jsonl`),
        lines.slice(0, headLines).join("\n"),
        "utf8",
      );
      writeFileSync(
        join(outDir, "transcripts", `${ts}-${sessionTag}.tail.jsonl`),
        lines.slice(-tailLines).join("\n"),
        "utf8",
      );
      process.stderr.write(
        `session-hub probe: lines=${lines.length} head=${Math.min(headLines, lines.length)} tail=${Math.min(tailLines, lines.length)} out=${outDir}\n`,
      );
    } catch (err) {
      process.stderr.write(`session-hub probe: transcript read failed: ${err?.message ?? err}\n`);
    }
  } else {
    process.stderr.write("session-hub probe: no transcript_path in stdin JSON\n");
  }
}

main()
  .catch((err) => {
    process.stderr.write(`session-hub probe: ${err?.message ?? err}\n`);
  })
  .finally(() => {
    process.exitCode = 0;
  });
