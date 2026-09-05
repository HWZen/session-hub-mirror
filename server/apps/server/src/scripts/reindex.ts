import { bootstrap } from "../bootstrap.js";

const { repo, indexer } = bootstrap();
const sessions = repo.listUnindexed(10000);
console.log(`[reindex] ${sessions.length} session(s) to index`);
let ok = 0;
for (const session of sessions) {
  if (await indexer.indexSession(session.id)) ok++;
}
console.log(`[reindex] done: ${ok}/${sessions.length} indexed`);
process.exitCode = ok === sessions.length ? 0 : 1;
