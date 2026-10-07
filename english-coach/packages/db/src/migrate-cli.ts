import { openDb } from "./client.js";
import { migrate } from "./migrate.js";
import { ensureSeed } from "./seed.js";

const database = openDb(process.env.DB_PATH ?? "./english-coach.db");
migrate(database);
ensureSeed(database);
console.log("db ready");
