import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkText } from "../../../apps/server/src/indexing/chunk.ts";
import { extractReasoning } from "../../../apps/server/src/indexing/raw-extract.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "data");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");
const QUERIES_PATH = path.join(HERE, "queries.json");
const RESULT_MD_PATH = path.join(HERE, "result.md");
const RESULT_JSON_PATH = path.join(HERE, "result.json");

const BASE_URL = process.env.SH_REMOTE_BASE_URL ?? "";
const TOKEN = process.env.SH_REMOTE_TOKEN ?? "";
const EMBED_URL = process.env.SH_PROBE_EMBED_URL ?? "http://127.0.0.1:434/v1/embeddings";
const EMBED_MODEL = process.env.SH_PROBE_EMBED_MODEL ?? "qwen3-embedding:8b";
const EMBED_KEY = process.env.SH_PROBE_EMBED_KEY ?? "";
const EMBED_BATCH = 16;

const CORPUS_SOURCE_IDS = (process.env.SH_PROBE_SOURCE_IDS ?? "").split(",").map(value => value.trim()).filter(Boolean);

const VARIANT_NAMES = ["V0", "V1", "V2"];
const VARIANT_LABELS = {
  V0: "纯正文",
  V1: "全字段 header",
  V2: "仅标题 header",
};
const CATEGORY_LABELS = {
  title: "标题原文",
  title_paraphrase: "标题改写",
  content: "正文改写",
  path: "路径+语义",
  identifier: "唯一标识符",
  cross_session: "跨会话同主题",
};

function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (TOKEN !== "") headers["Authorization"] = `Bearer ${TOKEN}`;
  return headers;
}

async function apiGet(url) {
  const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchCorpus() {
  if (BASE_URL === "" || TOKEN === "") {
    throw new Error("SH_REMOTE_BASE_URL / SH_REMOTE_TOKEN 必须设置");
  }
  const bySourceId = new Map();
  let offset = 0;
  for (;;) {
    const page = await apiGet(`${BASE_URL}/v1/sessions?limit=200&offset=${offset}`);
    for (const item of page.items) bySourceId.set(item.source_id, item.id);
    offset += page.items.length;
    if (offset >= page.total || page.items.length === 0) break;
  }
  const missing = CORPUS_SOURCE_IDS.filter((id) => !bySourceId.has(id));
  if (missing.length > 0) throw new Error(`语料列表中以下 source_id 不存在于远程：${missing.join(", ")}`);

  const sessions = [];
  let cursor = 0;
  const workers = Array.from({ length: 4 }, async () => {
    while (cursor < CORPUS_SOURCE_IDS.length) {
      const index = cursor++;
      const sourceId = CORPUS_SOURCE_IDS[index];
      const detail = await apiGet(`${BASE_URL}/v1/sessions/${bySourceId.get(sourceId)}/full`);
      sessions[index] = detail;
      console.log(`[fetch] ${index + 1}/${CORPUS_SOURCE_IDS.length} ${sourceId}`);
    }
  });
  await Promise.all(workers);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    SESSIONS_PATH,
    JSON.stringify({ fetched_at: new Date().toISOString(), base_url: BASE_URL, sessions }, null, 1),
  );
  console.log(`[fetch] 已写入 ${SESSIONS_PATH}（${sessions.length} 个会话）`);
}

function trimmed(value) {
  const result = typeof value === "string" ? value.trim() : "";
  return result === "" ? null : result;
}

function headerFullFields(session) {
  const title = trimmed(session.title);
  const parts = [];
  if (title !== null) parts.push(`标题=${title}`);
  parts.push(`Agent=${session.agent}`, `机器=${session.machine}`, `源会话ID=${session.source_id}`);
  const cwd = trimmed(session.cwd);
  if (cwd !== null) parts.push(`工作目录=${cwd}`);
  return `会话元数据：${parts.join("；")}`;
}

function buildChunks(session) {
  const chunks = [];
  const seen = new Set();
  const push = (text) => {
    for (const chunk of chunkText(text)) {
      if (seen.has(chunk.text)) continue;
      seen.add(chunk.text);
      chunks.push(chunk.text);
    }
  };
  for (const message of session.messages) {
    if (typeof message.text === "string" && message.text.trim() !== "") push(message.text);
    for (const reasoning of extractReasoning(session.agent, message.raw)) push(reasoning);
  }
  return chunks;
}

function firstInputFor(variant, session, firstChunk) {
  if (variant === "V0") return firstChunk;
  if (variant === "V1") return `${headerFullFields(session)}\n${firstChunk}`;
  const title = trimmed(session.title);
  return title === null ? firstChunk : `${title}\n${firstChunk}`;
}

async function embed(texts) {
  const vectors = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    const headers = { "Content-Type": "application/json" };
    if (EMBED_KEY !== "") headers["Authorization"] = `Bearer ${EMBED_KEY}`;
    const res = await fetch(EMBED_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: EMBED_MODEL, input: batch }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`embeddings -> ${res.status} ${await res.text()}`);
    const json = await res.json();
    const data = [...json.data].sort((a, b) => a.index - b.index);
    for (const item of data) vectors.push(Float32Array.from(item.embedding));
    console.log(`[embed] ${Math.min(start + batch.length, texts.length)}/${texts.length}`);
  }
  return vectors;
}

function normalize(vector) {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function formatRank(value) {
  return value === Infinity ? "MISS" : String(value);
}

function computeMetrics(rows) {
  const n = rows.length;
  const hit1 = rows.filter((r) => r.rank <= 1).length;
  const hit5 = rows.filter((r) => r.rank <= 5).length;
  const mrr = rows.reduce((sum, r) => sum + (r.rank <= 10 ? 1 / r.rank : 0), 0) / n;
  const finite = rows.filter((r) => Number.isFinite(r.distance));
  const avgDistance = finite.reduce((sum, r) => sum + r.distance, 0) / (finite.length || 1);
  const miss = rows.filter((r) => !(r.rank <= 10)).length;
  return { n, recall1: hit1 / n, recall5: hit5 / n, mrr, avgDistance, miss };
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

async function runProbe() {
  const data = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf8"));
  const queries = JSON.parse(fs.readFileSync(QUERIES_PATH, "utf8"));
  const sessions = data.sessions;

  const sessionSourceIds = new Set(sessions.map((s) => s.source_id));
  for (const query of queries) {
    if (!sessionSourceIds.has(query.target)) {
      throw new Error(`query 目标不在语料中：${query.target} (${query.query})`);
    }
  }

  const chunksBySession = sessions.map(buildChunks);
  const uniqueTexts = [];
  const textIndex = new Map();
  const intern = (text) => {
    if (!textIndex.has(text)) {
      textIndex.set(text, uniqueTexts.length);
      uniqueTexts.push(text);
    }
    return textIndex.get(text);
  };

  const variantChunkIndexes = { V0: [], V1: [], V2: [] };
  sessions.forEach((session, si) => {
    const chunks = chunksBySession[si];
    for (const variant of VARIANT_NAMES) {
      const indexes = chunks.map((text, ci) =>
        intern(ci === 0 ? firstInputFor(variant, session, text) : text),
      );
      variantChunkIndexes[variant].push(indexes);
    }
  });

  const totalChunks = chunksBySession.reduce((sum, chunks) => sum + chunks.length, 0);
  console.log(
    `[probe] 会话=${sessions.length} 切片=${totalChunks} 去重 embedding 文本=${uniqueTexts.length}`,
  );

  const rawVectors = await embed(uniqueTexts);
  const vectors = rawVectors.map(normalize);
  const queryVectors = (await embed(queries.map((q) => q.query))).map(normalize);

  const perQuery = [];
  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi];
    const result = { query: query.query, category: query.category, target: query.target, variants: {} };
    for (const variant of VARIANT_NAMES) {
      const ranking = sessions
        .map((session, si) => {
          let best = Infinity;
          for (const ti of variantChunkIndexes[variant][si]) {
            const distance = 1 - dot(queryVectors[qi], vectors[ti]);
            if (distance < best) best = distance;
          }
          return { source_id: session.source_id, distance: best };
        })
        .sort((a, b) => a.distance - b.distance);
      const index = ranking.findIndex((r) => r.source_id === query.target);
      const rank = index === -1 ? Infinity : index + 1;
      const distance = index === -1 ? Infinity : ranking[index].distance;
      result.variants[variant] = {
        rank,
        distance: Number.isFinite(distance) ? Number(distance.toFixed(4)) : null,
        top1: ranking[0].source_id,
        top5: ranking.slice(0, 5).map((r) => r.source_id),
      };
    }
    perQuery.push(result);
  }

  const categories = [...new Set(queries.map((q) => q.category))];
  const summary = {};
  for (const variant of VARIANT_NAMES) {
    const all = perQuery.map((q) => q.variants[variant]);
    summary[variant] = {
      overall: computeMetrics(all),
      byCategory: Object.fromEntries(
        categories.map((category) => {
          const rows = perQuery.filter((q) => q.category === category).map((q) => q.variants[variant]);
          return [category, computeMetrics(rows)];
        }),
      ),
    };
  }

  const meta = {
    generated_at: new Date().toISOString(),
    embed_url: EMBED_URL,
    embed_model: EMBED_MODEL,
    source: data.base_url,
    sessions: sessions.length,
    chunks: totalChunks,
    unique_texts: uniqueTexts.length,
    queries: queries.length,
    distance: "1 - cosine相似度",
  };

  const lines = [];
  lines.push("# 0.17.0 首切片拼法探针结果");
  lines.push("");
  lines.push(`- 生成时间：${meta.generated_at}`);
  lines.push(`- 语料：${meta.sessions} 个会话（远程 API 只读拉取），切片 ${meta.chunks} 条，去重后 embedding 文本 ${meta.unique_texts} 条`);
  lines.push(`- 向量：\`${meta.embed_model}\` @ \`${meta.embed_url}\``);
  lines.push("- 排名：会话级排名（会话内最小距离升序）；距离 = 1 - 余弦相似度，越小越近；排名 >10 记为 MISS");
  lines.push("- 变体：V0 纯正文（对照）；V1 全字段 header + 正文（0.16 形态）；V2 仅标题 header + 正文（本版候选）");
  lines.push("");
  lines.push("## 汇总");
  lines.push("");
  lines.push("| 变体 | R@1 | R@5 | MRR@10 | 目标平均距离 | MISS |");
  lines.push("|---|---|---|---|---|---|");
  for (const variant of VARIANT_NAMES) {
    const m = summary[variant].overall;
    lines.push(
      `| ${variant} ${VARIANT_LABELS[variant]} | ${percent(m.recall1)} | ${percent(m.recall5)} | ${m.mrr.toFixed(3)} | ${m.avgDistance.toFixed(3)} | ${m.miss}/${m.n} |`,
    );
  }
  lines.push("");
  lines.push("## 分类汇总");
  lines.push("");
  lines.push("| 类别 | n | 变体 | R@1 | R@5 | MRR@10 | 目标平均距离 | MISS |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const category of categories) {
    for (const variant of VARIANT_NAMES) {
      const m = summary[variant].byCategory[category];
      lines.push(
        `| ${CATEGORY_LABELS[category] ?? category} | ${m.n} | ${variant} | ${percent(m.recall1)} | ${percent(m.recall5)} | ${m.mrr.toFixed(3)} | ${m.avgDistance.toFixed(3)} | ${m.miss}/${m.n} |`,
      );
    }
  }
  lines.push("");
  lines.push("## 逐条对比");
  lines.push("");
  lines.push("| 类别 | Query | 目标 | V0 排名/距离 | V1 排名/距离 | V2 排名/距离 |");
  lines.push("|---|---|---|---|---|---|");
  for (const q of perQuery) {
    const cells = VARIANT_NAMES.map((variant) => {
      const r = q.variants[variant];
      return `${formatRank(r.rank)}${Number.isFinite(r.distance) ? ` / ${r.distance.toFixed(3)}` : ""}`;
    });
    lines.push(`| ${CATEGORY_LABELS[q.category] ?? q.category} | ${q.query} | ${q.target} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  fs.writeFileSync(RESULT_MD_PATH, lines.join("\n"));
  fs.writeFileSync(
    RESULT_JSON_PATH,
    JSON.stringify({ meta, summary, queries: perQuery }, null, 2),
  );
  console.log(`[probe] 已写入 ${RESULT_MD_PATH} 与 ${RESULT_JSON_PATH}`);
}

const command = process.argv[2] ?? "all";
if (command === "fetch") {
  await fetchCorpus();
} else if (command === "run") {
  await runProbe();
} else if (command === "all") {
  if (!fs.existsSync(SESSIONS_PATH) || process.argv.includes("--force")) await fetchCorpus();
  await runProbe();
} else {
  console.error("用法：tsx probe.mjs [fetch|run|all] [--force]");
  process.exit(1);
}
