import { Db } from "../src/db.js";
import { Release } from "../src/release.js";
const db = await Db.open(Release.fromEnv());
const j = (rows: unknown[]) => rows.forEach((r) => console.log(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? Number(v) : v))));
const t0 = Date.now();
j(await db.query(["dim_provider_history"], "SELECT status, entity_type IS NULL AS no_type, max(version) v, count(*) n FROM dim_provider_history WHERE npi BETWEEN '1003000000' AND '1013000000' GROUP BY ALL ORDER BY ALL"));
j(await db.query(["dim_provider_history"], "SELECT npi, max(version) v, list(status ORDER BY version) s, list(change_type ORDER BY version) c, list(CAST(valid_from AS VARCHAR) ORDER BY version) f FROM dim_provider_history WHERE npi BETWEEN '1003000000' AND '1013000000' GROUP BY npi HAVING max(version) >= 3 OR bool_or(status <> 'active') ORDER BY v DESC, npi LIMIT 8"));
console.log("ms", Date.now() - t0);
db.close();
