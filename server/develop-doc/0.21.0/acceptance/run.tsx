import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb } from "../../../apps/server/src/db/connection.js";
import { migrate } from "../../../apps/server/src/db/migrate.js";
import { searchSessions } from "../../../apps/server/src/db/search.js";
import { buildLexicalMatch } from "../../../apps/server/src/db/lexical.js";
import { hashVector } from "../../../apps/server/test/helpers.js";
import { toVectorBlob as vectorBlob } from "../../../apps/server/src/db/embeddings.js";

const db = createDb(path.join(mkdtempSync(path.join(tmpdir(), "sh-accept-")), "accept.db"));
migrate(db);

const SESSIONS: Array<{ id: string; title: string; text: string }> = [
  {
    id: "S1-identifier-only",
    title: "修 no-negative-echo 残留",
    text: "讨论了 no-negative-echo 技能的规则，防止被否决的备选方案回显进产出物。",
  },
  {
    id: "S2-nl-only",
    title: "否定约束回显治理",
    text: "为了让 AI 不把被用户否决的约束写进最终输出，我们设计了显式的规则标记与产出前扫描流程。",
  },
  {
    id: "S3-mixed",
    title: "no-negative-echo 回显方案落地",
    text: "按 no-negative-echo 约束重构了模板：被拒绝的选项不再出现在 summary 里，扫描器在提交前拦截。",
  },
  { id: "S4-unrelated", title: "周末菜谱", text: "研究红烧肉的做法，焯水后炒糖色，小火炖四十分钟。" },
];

const insSession = db.prepare(
  "INSERT INTO sessions (id, agent, machine, source_id, title, created_at, updated_at, indexed_at, indexed_model) VALUES (?, 'opencode', 'M1', ?, ?, 1, 2, 3, 'bge-m3')",
);
const insMsg = db.prepare("INSERT INTO messages (session_id, idx, role, text) VALUES (?, 0, 'user', ?)");
const insChunk = db.prepare("INSERT INTO message_chunks (message_id, chunk_no, source, text, char_start) VALUES (?, 0, 'text', ?, 0)");
db.exec("CREATE VIRTUAL TABLE chunk_embeddings_bge_m3 USING vec0 (chunk_id INTEGER PRIMARY KEY, embedding float[1024])");
const insVec = db.prepare("INSERT INTO chunk_embeddings_bge_m3 (chunk_id, embedding) VALUES (?, ?)");
for (const s of SESSIONS) {
  insSession.run(s.id, `${s.id}-src`, s.title);
  const chunkText = `${s.title}\n${s.text}`;
  const info = insMsg.run(s.id, s.text);
  const chunkId = Number(insChunk.run(Number(info.lastInsertRowid), chunkText).lastInsertRowid);
  insVec.run(BigInt(chunkId), vectorBlob(hashVector(chunkText, 1024)));
}

const QUERIES = [
  "no-negative-echo",
  "之前讨论怎么避免 AI 把否定约束写进输出",
  "no-negative-echo 这个约束回显方案",
];

for (const q of QUERIES) {
  console.log(`\n=== query: ${q}`);
  console.log(`    lexical terms: ${buildLexicalMatch(q)!.split(" OR ").length}`);
  const hits = searchSessions(db, "bge-m3", q, hashVector(q, 1024), 5, {});
  hits.forEach((h, i) => {
    const s = SESSIONS.find((x) => x.id === h.session.id)!;
    console.log(
      `  #${i + 1} ${h.session.id.padEnd(18)} fused=${h.score.toFixed(5)} distance=${h.distance === null ? "null" : h.distance.toFixed(4)} matched_by=[${h.matched_by.join(",")}] snippets=${h.snippets.map((sn) => `[${sn.matched_by.join("+")}]${sn.text.slice(0, 18)}…`).join(" ")}`,
    );
    void s;
  });
}
db.close();
