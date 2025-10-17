import {MongoClient} from "mongodb";

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

    console.log(`connecting to mongodb on host: '${dbUrl}'`);

    const client = new MongoClient(connectionString);
    let conn;

    try {
        conn = await client.connect();
    } catch (e) {
        console.error(e);
    }

    db = conn.db(dbName);
} else {
    console.log("mongodb has not been configured.");
}

export default db;
