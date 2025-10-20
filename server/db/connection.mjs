import { MongoClient } from "mongodb";
import logger from "../logger.js";

const dbEnabled = process.env.MONGODB_ENABLED === "true";
let db;

if (dbEnabled) {
    const dbUrl = process.env.MONGODB_URL;
    const dbName = process.env.MONGODB_DB_NAME;
    const dbUser = process.env.MONGODB_USER;
    const dbPass = process.env.MONGODB_PASS;

    const dbUserInfo = (dbUser && dbPass)
        ? `${dbUser}:${dbPass}@`
        : "";

    const connectionString = `mongodb://${dbUserInfo}${dbUrl}/${dbName}`;

    logger.info("Connecting to MongoDB", {
        host: dbUrl,
        database: dbName,
        user: dbUser ?? "anonymous"
    });

    const client = new MongoClient(connectionString);
    let conn;

    try {
        conn = await client.connect();
    } catch (e) {
        logger.error("Failed to connect to MongoDB", e);
        throw e;
    }

    logger.info("MongoDB connection established", {
        database: dbName
    });

    db = conn.db(dbName);
} else {
    logger.warn("MongoDB has not been configured. Database features are disabled.");
}

export default db;
