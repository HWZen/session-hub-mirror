import { bootstrap } from "../bootstrap.js";

const { repo, indexer, registry } = bootstrap();
const activeModel = registry.activeModel();
const sessions = repo.listUnindexed(10000, activeModel);
console.log(`[reindex] activeModel=${activeModel ?? "(none)"}, ${sessions.length} session(s) to index`);
let ok = 0;
for (const session of sessions) {
  if (await indexer.indexSession(session.id)) ok++;
}
console.log(`[reindex] done: ${ok}/${sessions.length} indexed`);
process.exitCode = ok === sessions.length ? 0 : 1;
