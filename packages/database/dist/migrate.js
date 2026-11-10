"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrate = migrate;
const migrator_1 = require("drizzle-orm/postgres-js/migrator");
const postgres_1 = __importDefault(require("postgres"));
const postgres_js_1 = require("drizzle-orm/postgres-js");
const dotenv = __importStar(require("dotenv"));
const env_1 = require("./env");
dotenv.config({ quiet: true });
const getConnectionString = () => {
    const url = (0, env_1.resolveDatabaseUrl)();
    if (!url) {
        throw new Error(env_1.MISSING_DATABASE_URL_MESSAGE);
    }
    return url;
};
async function migrate() {
    const connectionString = getConnectionString();
    const migrationClient = (0, postgres_1.default)(connectionString, { max: 1 });
    const db = (0, postgres_js_1.drizzle)(migrationClient);
    console.log("Running migrations...");
    await (0, migrator_1.migrate)(db, { migrationsFolder: "./drizzle" });
    console.log("Migrations completed!");
    await migrationClient.end();
}
async function runMigration() {
    await migrate();
}
// Only run if this file is executed directly
if (require.main === module) {
    runMigration().catch((err) => {
        console.error("Migration failed:", err);
        process.exit(1);
    });
}
//# sourceMappingURL=migrate.js.map