const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { promises: fs } = require("fs");
const { v4: uuid } = require("uuid");
const { ObjectId } = require("mongodb");
const logger = require("./logger");
const db = import("./db/connection.mjs");

const app = express();
const PORT = process.env.PORT || 4000;

const DATA_DIR = path.join(__dirname, "data");
const SEATS_FILE = path.join(DATA_DIR, "seats.json");
const BOOKINGS_FILE = path.join(DATA_DIR, "bookings.json");
const CANCELLATIONS_FILE = path.join(DATA_DIR, "cancellations.json");
const CLIENT_BUILD_DIR = path.join(__dirname, "..", "client", "dist");
const DEFAULT_FLOORPLAN_IMAGE = path.join(__dirname, "..", "client", "public", "floorplan.png");
const FLOORPLAN_META_FILE = path.join(DATA_DIR, "floorplan.json");
const FLOORPLAN_IMAGE_PREFIX = "floorplan-image";
const ACCEPTED_FLOORPLAN_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"]
]);
const MAX_FLOORPLAN_FILE_SIZE = 5 * 1024 * 1024;
const MONGODB_ENABLED = process.env.MONGODB_ENABLED === "true";
const FLOORPLAN_COLLECTION = "floorplanAssets";
const FLOORPLAN_DOCUMENT_ID = "floorplan";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ? String(process.env.ADMIN_PASSWORD) : "";
const MAX_RECURRENCE_OCCURRENCES = 52;
const PREVIEW_LOOKAHEAD_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    logger.info("HTTP request completed", {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs
    });
  });
  next();
});

app.use((req, _res, next) => {
  const line = `[${new Date().toISOString()}] ${req.method} ${req.path}\n`;
  fs.appendFile(path.join(DATA_DIR, "debug.log"), line).catch(() => {
    // ignore logging errors
  });
  next();
});

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  logger.debug("Ensured data directory exists", { path: DATA_DIR });
  const defaultFiles = [
    { file: SEATS_FILE, fallback: "[]" },
    { file: BOOKINGS_FILE, fallback: "[]" },
    { file: CANCELLATIONS_FILE, fallback: "[]" }
  ];

  await Promise.all(
    defaultFiles.map(async ({ file, fallback }) => {
      try {
        await fs.access(file);
      } catch (error) {
        if (error.code === "ENOENT") {
          await fs.writeFile(file, fallback, "utf8");
          logger.info("Created default data file", { file });
        } else {
          throw error;
        }
      }
    })
  );

  const buildingConfig = await readBuildingConfig();
  await clampSeatFloors(buildingConfig.floorCount);
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    logger.debug("Read JSON file", { file });
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT" && typeof fallback !== "undefined") {
      await writeJson(file, fallback);
      logger.warn("JSON file missing, created fallback", { file });
      return fallback;
    }
    logger.error(`Failed to read ${file}`, error);
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
  logger.debug("Wrote JSON file", { file });
}

const BUILDING_CONFIG_FILE = path.join(DATA_DIR, "building.json");
const BUILDING_COLLECTION = "buildingConfig";
const MAX_FLOORS = 20;

function createDefaultBuildingConfig(floorCount = 1) {
  const normalized = Math.max(1, Math.min(MAX_FLOORS, Math.trunc(floorCount)));
  return {
    floorCount: normalized,
    floors: Array.from({ length: normalized }, (_value, index) => ({
      index: index + 1,
      name: `Floor ${index + 1}`
    }))
  };
}

function sanitizeFloorName(name, index) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length > 0) {
    return trimmed;
  }
  return `Floor ${index}`;
}

function sanitizeBuildingConfig(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return createDefaultBuildingConfig();
  }
  const requestedCount = Number(candidate.floorCount);
  const floorCount = Math.max(1, Math.min(MAX_FLOORS, Number.isFinite(requestedCount) ? Math.trunc(requestedCount) : 1));
  const providedFloors = Array.isArray(candidate.floors) ? candidate.floors : [];

  const floors = [];
  for (let index = 1; index <= floorCount; index += 1) {
    const existing = providedFloors.find((floor) => Number(floor?.index) === index);
    floors.push({
      index,
      name: sanitizeFloorName(existing?.name, index)
    });
  }
  return { floorCount, floors };
}

async function readBuildingConfig() {
  if (MONGODB_ENABLED) {
    const database = (await db).default;
    if (!database) {
      return createDefaultBuildingConfig();
    }
    const document = await database.collection(BUILDING_COLLECTION).findOne({ _id: "building" });
    if (!document) {
      const defaultConfig = createDefaultBuildingConfig();
      await database.collection(BUILDING_COLLECTION).insertOne({
        _id: "building",
        ...defaultConfig
      });
      return defaultConfig;
    }
    return sanitizeBuildingConfig(document);
  }

  try {
    const raw = await fs.readFile(BUILDING_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return sanitizeBuildingConfig(parsed);
  } catch (error) {
    if (error.code === "ENOENT") {
      const defaultConfig = createDefaultBuildingConfig();
      await writeBuildingConfig(defaultConfig);
      return defaultConfig;
    }
    logger.error("Failed to read building configuration", error);
    throw error;
  }
}

async function writeBuildingConfig(config) {
  const normalized = sanitizeBuildingConfig(config);
  if (MONGODB_ENABLED) {
    const database = (await db).default;
    if (!database) {
      throw new Error("MongoDB connection is not available.");
    }
    await database
      .collection(BUILDING_COLLECTION)
      .updateOne({ _id: "building" }, { $set: normalized }, { upsert: true });
  } else {
    await writeJson(BUILDING_CONFIG_FILE, normalized);
  }
  return normalized;
}

async function clampSeatFloors(maxFloor) {
  const seats = await readJson(SEATS_FILE, []);
  let changed = false;
  const clamped = seats.map((seat) => {
    const floorValue = Number(seat.floor);
    const normalized = Number.isFinite(floorValue) ? Math.trunc(floorValue) : 1;
    const finalFloor = Math.min(maxFloor, Math.max(1, normalized));
    if (seat.floor !== finalFloor) {
      changed = true;
    }
    return { ...seat, floor: finalFloor };
  });
  if (changed) {
    await writeJson(SEATS_FILE, clamped);
  }
}

function getFloorplanPath(filename) {
  return path.join(DATA_DIR, filename);
}

function getFloorplanDocumentId(floor) {
  if (floor === 1) {
    return FLOORPLAN_DOCUMENT_ID;
  }
  return `${FLOORPLAN_DOCUMENT_ID}:${floor}`;
}

function parseFloorFromDocumentId(id) {
  if (id === FLOORPLAN_DOCUMENT_ID) {
    return 1;
  }
  if (typeof id === "string" && id.startsWith(`${FLOORPLAN_DOCUMENT_ID}:`)) {
    const parsed = Number(id.split(":")[1]);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

async function readFloorplanMetaFile() {
  try {
    const raw = await fs.readFile(FLOORPLAN_META_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (parsed.floors && typeof parsed.floors === "object") {
        const floors = {};
        Object.entries(parsed.floors).forEach(([key, value]) => {
          const index = Number(key);
          if (!Number.isFinite(index) || index < 1) {
            return;
          }
          const entry = value || {};
          floors[index] = {
            filename: typeof entry.filename === "string" ? entry.filename : null,
            mimeType: entry.mimeType ?? null,
            updatedAt: entry.updatedAt ?? null,
            originalName: entry.originalName ?? null,
            size: entry.size ?? null
          };
        });
        return floors;
      }

      if (parsed.filename) {
        return {
          1: {
            filename: parsed.filename,
            mimeType: parsed.mimeType ?? null,
            updatedAt: parsed.updatedAt ?? null,
            originalName: parsed.originalName ?? null,
            size: parsed.size ?? null
          }
        };
      }
    }
    return {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    logger.error("Failed to read floorplan metadata file", error);
    throw error;
  }
}

async function writeFloorplanMetaFile(floorsMeta) {
  const payload = {
    storage: "file",
    floors: Object.fromEntries(
      Object.entries(floorsMeta).map(([key, meta]) => [
        key,
        {
          filename: meta.filename ?? null,
          mimeType: meta.mimeType ?? null,
          updatedAt: meta.updatedAt ?? null,
          originalName: meta.originalName ?? null,
          size: meta.size ?? null
        }
      ])
    )
  };
  await writeJson(FLOORPLAN_META_FILE, payload);
}

async function listFloorplanStates() {
  if (MONGODB_ENABLED) {
    const database = (await db).default;
    if (!database) {
      return {};
    }
    const documents = await database
      .collection(FLOORPLAN_COLLECTION)
      .find({}, { projection: { data: 0 } })
      .toArray();
    const states = {};
    documents.forEach((doc) => {
      const floor = parseFloorFromDocumentId(doc._id);
      if (!floor) {
        return;
      }
      states[floor] = {
        hasCustomImage: Boolean(doc.data ?? doc.mimeType),
        mimeType: doc.mimeType ?? null,
        updatedAt: doc.updatedAt ?? null,
        originalName: doc.originalName ?? null,
        size: doc.size ?? null
      };
    });
    return states;
  }

  const meta = await readFloorplanMetaFile();
  const states = {};
  Object.entries(meta).forEach(([key, value]) => {
    const floor = Number(key);
    if (!Number.isFinite(floor) || floor < 1) {
      return;
    }
    states[floor] = {
      hasCustomImage: Boolean(value?.filename),
      filename: value.filename ?? null,
      mimeType: value?.mimeType ?? null,
      updatedAt: value?.updatedAt ?? null,
      originalName: value?.originalName ?? null,
      size: value?.size ?? null
    };
  });
  return states;
}

async function getFloorplanState(floor) {
  const normalizedFloor = Math.max(1, Math.trunc(Number(floor) || 1));

  if (MONGODB_ENABLED) {
    const database = (await db).default;
    if (!database) {
      throw new Error("MongoDB connection is not available.");
    }
    const documentId = getFloorplanDocumentId(normalizedFloor);
    let document = await database
      .collection(FLOORPLAN_COLLECTION)
      .findOne({ _id: documentId }, { projection: { data: 0 } });
    if (!document && normalizedFloor === 1) {
      document = await database
        .collection(FLOORPLAN_COLLECTION)
        .findOne({ _id: FLOORPLAN_DOCUMENT_ID }, { projection: { data: 0 } });
    }
    if (!document) {
      return {
        storage: "mongo",
        hasCustomImage: false,
        filename: null,
        mimeType: null,
        updatedAt: null,
        originalName: null,
        size: null
      };
    }
    return {
      storage: "mongo",
      hasCustomImage: true,
      filename: null,
      mimeType: document.mimeType ?? null,
      updatedAt: document.updatedAt ?? null,
      originalName: document.originalName ?? null,
      size: document.size ?? null
    };
  }

  const meta = await readFloorplanMetaFile();
  const entry = meta[normalizedFloor];
  if (entry?.filename) {
    const candidatePath = getFloorplanPath(entry.filename);
    try {
      await fs.access(candidatePath);
      return {
        storage: "file",
        hasCustomImage: true,
        filename: entry.filename,
        mimeType: entry.mimeType ?? null,
        updatedAt: entry.updatedAt ?? null,
        originalName: entry.originalName ?? null,
        size: entry.size ?? null
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error("Failed to access stored floorplan image", error);
        throw error;
      }
      logger.warn("Floorplan metadata exists but file is missing", {
        floor: normalizedFloor,
        filename: entry.filename
      });
    }
  }

  return {
    storage: "file",
    hasCustomImage: false,
    filename: null,
    mimeType: null,
    updatedAt: null,
    originalName: null,
    size: null
  };
}

function parseFloorplanDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || dataUrl.trim().length === 0) {
    throw new Error("Image payload must be provided as a base64 data URL string.");
  }

  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Image payload must be a valid base64 data URL.");
  }

  const mimeType = match[1].toLowerCase();
  const extension = ACCEPTED_FLOORPLAN_TYPES.get(mimeType);
  if (!extension) {
    throw new Error("Only PNG, JPEG or WEBP images are supported.");
  }

  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) {
    throw new Error("Uploaded image payload is empty.");
  }
  if (buffer.length > MAX_FLOORPLAN_FILE_SIZE) {
    throw new Error("Uploaded image is too large. Maximum allowed size is 5 MB.");
  }

  return { mimeType, extension, buffer };
}

async function saveFloorplanImage({ floor, dataUrl, originalName }) {
  const floorIndex = Math.max(1, Math.trunc(Number(floor) || 1));
  const { mimeType, extension, buffer } = parseFloorplanDataUrl(dataUrl);
  const updatedAt = new Date().toISOString();
  const normalizedName = normalizeText(originalName) ?? null;

  if (MONGODB_ENABLED) {
    const database = (await db).default;
    if (!database) {
      throw new Error("MongoDB connection is not available.");
    }
    const documentId = getFloorplanDocumentId(floorIndex);
    await database.collection(FLOORPLAN_COLLECTION).updateOne(
      { _id: documentId },
      {
        $set: {
          mimeType,
          updatedAt,
          originalName: normalizedName,
          size: buffer.length,
          data: buffer.toString("base64")
        }
      },
      { upsert: true }
    );
    if (floorIndex === 1 && documentId !== FLOORPLAN_DOCUMENT_ID) {
      await database.collection(FLOORPLAN_COLLECTION).deleteOne({ _id: FLOORPLAN_DOCUMENT_ID });
    }
    logger.info("Stored floorplan image in MongoDB", {
      floor: floorIndex,
      mimeType,
      size: buffer.length
    });
    return {
      storage: "mongo",
      hasCustomImage: true,
      mimeType,
      updatedAt,
      originalName: normalizedName,
      size: buffer.length
    };
  }

  const filename = `${FLOORPLAN_IMAGE_PREFIX}-${floorIndex}.${extension}`;
  const destination = getFloorplanPath(filename);

  const meta = await readFloorplanMetaFile();
  const existing = meta[floorIndex];
  if (existing?.filename && existing.filename !== filename) {
    try {
      await fs.unlink(getFloorplanPath(existing.filename));
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error("Failed to remove previous floorplan image", error);
        throw error;
      }
    }
  }

  await fs.writeFile(destination, buffer);
  meta[floorIndex] = {
    filename,
    mimeType,
    updatedAt,
    originalName: normalizedName,
    size: buffer.length
  };
  await writeFloorplanMetaFile(meta);
  logger.info("Stored floorplan image on filesystem", {
    floor: floorIndex,
    filename,
    mimeType,
    size: buffer.length
  });
  return {
    storage: "file",
    hasCustomImage: true,
    filename,
    mimeType,
    updatedAt,
    originalName: normalizedName,
    size: buffer.length
  };
}

async function deleteFloorplanImage(floor) {
  const floorIndex = Math.max(1, Math.trunc(Number(floor) || 1));

  if (MONGODB_ENABLED) {
    const database = (await db).default;
    if (!database) {
      throw new Error("MongoDB connection is not available.");
    }
    const documentId = getFloorplanDocumentId(floorIndex);
    const result = await database.collection(FLOORPLAN_COLLECTION).deleteOne({ _id: documentId });
    if (floorIndex === 1) {
      await database.collection(FLOORPLAN_COLLECTION).deleteOne({ _id: FLOORPLAN_DOCUMENT_ID });
    }
    logger.info("Removed floorplan image from MongoDB", {
      floor: floorIndex,
      deletedCount: result.deletedCount
    });
    return;
  }

  const meta = await readFloorplanMetaFile();
  const entry = meta[floorIndex];
  if (entry?.filename) {
    try {
      await fs.unlink(getFloorplanPath(entry.filename));
      logger.info("Removed floorplan file", { floor: floorIndex, filename: entry.filename });
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error("Failed to delete floorplan image", error);
        throw error;
      }
    }
  }
  if (meta[floorIndex]) {
    delete meta[floorIndex];
    await writeFloorplanMetaFile(meta);
  }
}

async function pruneFloorplansAbove(maxFloor) {
  const floorStates = await listFloorplanStates();
  const targets = Object.keys(floorStates)
    .map((key) => Number(key))
    .filter((floor) => Number.isFinite(floor) && floor > maxFloor);
  for (const floor of targets) {
    try {
      await deleteFloorplanImage(floor);
    } catch (error) {
      logger.warn("Failed to prune floorplan while reducing floor count", {
        floor,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function buildFloorplanInfoPayload(floor, state) {
  const cacheKey = state.updatedAt ?? "default";
  return {
    floor,
    hasCustomImage: Boolean(state.hasCustomImage),
    updatedAt: state.updatedAt ?? null,
    mimeType: state.mimeType ?? null,
    originalName: state.originalName ?? null,
    size: state.size ?? null,
    imageUrl: `/api/floorplans/${floor}/image?cache=${encodeURIComponent(cacheKey)}`
  };
}

async function appendCancellation(entries) {
  const cancellations = await readJson(CANCELLATIONS_FILE, []);
  const payload = Array.isArray(entries) ? entries : [entries];
  cancellations.push(
    ...payload.map((entry) => ({
      ...entry,
      cancelledAt: entry.cancelledAt ?? new Date().toISOString()
    }))
  );
  await writeJson(CANCELLATIONS_FILE, cancellations);
  logger.info("Recorded booking cancellations", { count: payload.length });
}

function normalizeDate(input) {
  if (!input) {
    return null;
  }

  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseCoordinate(value) {
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const rounded = Math.round(clamp(numeric, 0, 100) * 1000) / 1000;
  return rounded;
}

function parseDimensionPercent(value) {
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const clamped = clamp(numeric, 0.5, 100);
  return Math.round(clamped * 100) / 100;
}

function parseRotation(value) {
  if (typeof value === "string" && value.trim() === "") {
    return 0;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const normalized = Math.trunc(numeric % 360);
  return normalized < 0 ? normalized + 360 : normalized;
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

app.get("/api/db/seats", async (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 1;
  const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
  logger.info("Fetching seats from MongoDB", { limit, offset });

  const collection = (await db).default.collection("seats");
  const seats = await collection
    .find()
    .limit(limit)
    .skip(offset)
    .toArray();

  const count = await collection.countDocuments({});
  logger.debug("MongoDB seats fetch completed", { fetched: seats.length, total: count });
  const responsePayload = {
    content: seats,
    info: {
      count
    }
  };

  res.status(200).send(responsePayload);
});

app.post("/api/db/seats", async (req, res) => {
  const seat = req.body;
  logger.info("Creating seat in MongoDB", { seat });

  const collection = (await db).default.collection("seats");
  await collection.insertOne(seat);

  logger.info("Seat stored in MongoDB", { id: seat?._id ?? null });
  res.status(201).send(seat);
});

app.put("/api/db/seats/:id", async (req, res) => {
  const { id } = req.params;
  const seat = req.body;
  logger.info("Updating seat in MongoDB", { id, seat });

  const collection = (await db).default.collection("seats");
  await collection.updateOne({ _id: new ObjectId(id) }, seat);

  logger.info("Seat update completed", { id });
  res.status(204).send();
});

app.delete("/api/db/seats/:id", async (req, res) => {
  const { id } = req.params;
  logger.info("Deleting seat from MongoDB", { id });

  const collection = (await db).default.collection("seats");
  const result = await collection.deleteOne({ _id: new ObjectId(id) });
  logger.info("Seat deletion result", { id, deletedCount: result.deletedCount });

  res.status(204).send();
});

app.get("/api/seats", async (_req, res, next) => {
  try {
    const seats = await readJson(SEATS_FILE, []);
    logger.debug("Returning seats from filesystem store", { count: seats.length });
    const building = await readBuildingConfig();
    const normalizedSeats = seats.map((seat) => {
      const parsedFloor = Number(seat.floor);
      const floor = Number.isFinite(parsedFloor) ? Math.trunc(parsedFloor) : 1;
      const clampedFloor = Math.min(building.floorCount, Math.max(1, floor));
      const width = parseDimensionPercent(seat.width) ?? 6;
      const height = parseDimensionPercent(seat.height) ?? 6;
      const rotation = parseRotation(seat.rotation ?? 0);
      return {
        ...seat,
        floor: clampedFloor,
        width,
        height,
        rotation
      };
    });
    res.json(normalizedSeats);
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/verify", (req, res) => {
  const headerSecret = extractAdminHeader(req);
  const bodyPassword = typeof req.body?.password === "string" ? req.body.password : "";
  const candidate = headerSecret || bodyPassword;
  logger.info("Admin verification attempt", {
    usingHeader: Boolean(headerSecret),
    usingBody: Boolean(bodyPassword)
  });

  if (!isAdminPasswordConfigured()) {
    logger.warn("Admin password not configured; granting access");
    res.json({ authorized: true, passwordRequired: false });
    return;
  }

  if (candidate && safeCompareString(candidate, ADMIN_PASSWORD)) {
    logger.info("Admin verification succeeded");
    res.json({ authorized: true, passwordRequired: true });
  } else {
    logger.warn("Admin verification failed");
    res.status(401).json({ message: "Password is not valid." });
  }
});

app.get("/api/building", async (_req, res, next) => {
  try {
    const config = await readBuildingConfig();
    const floorStates = await listFloorplanStates();
    const floors = config.floors.map((floor) => {
      const state = floorStates[floor.index] ?? {};
      return {
        index: floor.index,
        name: floor.name,
        hasFloorplan: Boolean(state.hasCustomImage),
        updatedAt: state.updatedAt ?? null,
        imageUrl: `/api/floorplans/${floor.index}/image?cache=${encodeURIComponent(
          state.updatedAt ?? "default"
        )}`
      };
    });
    res.json({
      floorCount: config.floorCount,
      floors
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/building", requireAdmin, async (req, res, next) => {
  try {
    const { floorCount, floors } = req.body || {};
    const updatedConfig = await writeBuildingConfig({
      floorCount,
      floors: Array.isArray(floors) ? floors : undefined
    });
    await clampSeatFloors(updatedConfig.floorCount);
    await pruneFloorplansAbove(updatedConfig.floorCount);
    const floorStates = await listFloorplanStates();
    const payloadFloors = updatedConfig.floors.map((floor) => {
      const state = floorStates[floor.index] ?? {};
      return {
        index: floor.index,
        name: floor.name,
        hasFloorplan: Boolean(state.hasCustomImage),
        updatedAt: state.updatedAt ?? null,
        imageUrl: `/api/floorplans/${floor.index}/image?cache=${encodeURIComponent(
          state.updatedAt ?? "default"
        )}`
      };
    });
    res.json({
      floorCount: updatedConfig.floorCount,
      floors: payloadFloors
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/floorplans/:floor", async (req, res, next) => {
  try {
    const floor = Math.max(1, Math.trunc(Number(req.params.floor) || 1));
    const state = await getFloorplanState(floor);
    res.json(buildFloorplanInfoPayload(floor, state));
  } catch (error) {
    next(error);
  }
});

app.get("/api/floorplans/:floor/image", async (req, res, next) => {
  try {
    const floor = Math.max(1, Math.trunc(Number(req.params.floor) || 1));
    res.setHeader("Cache-Control", "no-store, must-revalidate");

    if (MONGODB_ENABLED) {
      const database = (await db).default;
      if (!database) {
        throw new Error("MongoDB connection is not available.");
      }
      const documentId = getFloorplanDocumentId(floor);
      let document = await database.collection(FLOORPLAN_COLLECTION).findOne({ _id: documentId });
      if (!document && floor === 1) {
        document = await database.collection(FLOORPLAN_COLLECTION).findOne({ _id: FLOORPLAN_DOCUMENT_ID });
      }
      if (document?.data) {
        const buffer = Buffer.from(document.data, "base64");
        if (buffer.length > 0) {
          res.setHeader("Content-Type", document.mimeType ?? "application/octet-stream");
          res.setHeader("Content-Length", buffer.length);
          res.send(buffer);
          return;
        }
      }
      res.sendFile(DEFAULT_FLOORPLAN_IMAGE);
      return;
    }

    const state = await getFloorplanState(floor);
    if (state.hasCustomImage && state.filename) {
      res.sendFile(getFloorplanPath(state.filename));
      return;
    }
    res.sendFile(DEFAULT_FLOORPLAN_IMAGE);
  } catch (error) {
    next(error);
  }
});

app.put("/api/floorplans/:floor", requireAdmin, async (req, res, next) => {
  if (!req.body || typeof req.body !== "object") {
    res.status(400).json({ message: "Request body is required." });
    return;
  }

  const dataUrl = req.body.dataUrl;
  const originalName = req.body.name;
  if (typeof dataUrl !== "string") {
    res.status(400).json({ message: "Property 'dataUrl' is required." });
    return;
  }

  const floor = Math.max(1, Math.trunc(Number(req.params.floor) || 1));

  try {
    const metadata = await saveFloorplanImage({ floor, dataUrl, originalName });
    res.json(buildFloorplanInfoPayload(floor, metadata));
  } catch (error) {
    if (error instanceof Error && !error.code) {
      res.status(400).json({ message: error.message });
      return;
    }
    next(error);
  }
});

app.delete("/api/floorplans/:floor", requireAdmin, async (req, res, next) => {
  try {
    const floor = Math.max(1, Math.trunc(Number(req.params.floor) || 1));
    await deleteFloorplanImage(floor);
    const state = await getFloorplanState(floor);
    res.json(buildFloorplanInfoPayload(floor, state));
  } catch (error) {
    next(error);
  }
});

app.get("/api/floorplan", async (_req, res, next) => {
  try {
    const state = await getFloorplanState(1);
    res.json(buildFloorplanInfoPayload(1, state));
  } catch (error) {
    next(error);
  }
});

app.get("/api/floorplan/image", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    if (MONGODB_ENABLED) {
      const database = (await db).default;
      if (!database) {
        throw new Error("MongoDB connection is not available.");
      }
      let document = await database
        .collection(FLOORPLAN_COLLECTION)
        .findOne({ _id: getFloorplanDocumentId(1) });
      if (!document) {
        document = await database.collection(FLOORPLAN_COLLECTION).findOne({ _id: FLOORPLAN_DOCUMENT_ID });
      }
      if (document?.data) {
        const buffer = Buffer.from(document.data, "base64");
        if (buffer.length > 0) {
          res.setHeader("Content-Type", document.mimeType ?? "application/octet-stream");
          res.setHeader("Content-Length", buffer.length);
          res.send(buffer);
          return;
        }
      }
      res.sendFile(DEFAULT_FLOORPLAN_IMAGE);
      return;
    }

    const state = await getFloorplanState(1);
    if (state.hasCustomImage && state.filename) {
      res.sendFile(getFloorplanPath(state.filename));
      return;
    }
    res.sendFile(DEFAULT_FLOORPLAN_IMAGE);
  } catch (error) {
    next(error);
  }
});

app.put("/api/floorplan", requireAdmin, async (req, res, next) => {
  if (!req.body || typeof req.body !== "object") {
    res.status(400).json({ message: "Request body is required." });
    return;
  }

  const dataUrl = req.body.dataUrl;
  const originalName = req.body.name;
  if (typeof dataUrl !== "string") {
    res.status(400).json({ message: "Property 'dataUrl' is required." });
    return;
  }

  try {
    const metadata = await saveFloorplanImage({ floor: 1, dataUrl, originalName });
    res.json(buildFloorplanInfoPayload(1, metadata));
  } catch (error) {
    if (error instanceof Error && !error.code) {
      res.status(400).json({ message: error.message });
      return;
    }
    next(error);
  }
});

app.delete("/api/floorplan", requireAdmin, async (_req, res, next) => {
  try {
    await deleteFloorplanImage(1);
    const state = await getFloorplanState(1);
    res.json(buildFloorplanInfoPayload(1, state));
  } catch (error) {
    next(error);
  }
});

app.post("/api/seats", requireAdmin, async (req, res, next) => {
  try {
    const { id, label, x, y, width, height, rotation, floor: floorInput, zone, notes } =
      req.body || {};
    const normalizedId = normalizeText(id);
    const xCoordinate = parseCoordinate(x);
    const yCoordinate = parseCoordinate(y);
    const widthPercent = parseDimensionPercent(width ?? 6);
    const heightPercent = parseDimensionPercent(height ?? 6);
    const rotationDeg = parseRotation(rotation ?? 0);

    if (!normalizedId || xCoordinate === null || yCoordinate === null) {
      return res.status(400).json({
        message: "Seat id, x and y are required and must be valid numbers (0-100)."
      });
    }

    if (widthPercent === null || heightPercent === null) {
      return res.status(400).json({
        message: "Width and height must be valid percentages between 0.5 and 100."
      });
    }

    const seats = await readJson(SEATS_FILE, []);
    const building = await readBuildingConfig();

    const parsedFloor = Number(floorInput);
    const floor = Number.isFinite(parsedFloor) ? Math.trunc(parsedFloor) : 1;
    if (floor < 1 || floor > building.floorCount) {
      return res.status(400).json({
        message: `Floor must be between 1 and ${building.floorCount}.`
      });
    }

    if (seats.some((seat) => seat.id === normalizedId)) {
      return res
        .status(409)
        .json({ message: `Seat with ID "${normalizedId}" already exists.` });
    }

    logger.info("Creating seat in filesystem store", { seatId: normalizedId });
    const newSeat = {
      id: normalizedId,
      label: normalizeText(label) || normalizedId,
      x: xCoordinate,
      y: yCoordinate,
      width: widthPercent,
      height: heightPercent,
      rotation: rotationDeg,
      floor,
      zone: normalizeText(zone),
      notes: normalizeText(notes)
    };

    const cleanedSeat = Object.fromEntries(
      Object.entries(newSeat).filter(([, value]) => value !== undefined)
    );

    seats.push(cleanedSeat);
    await writeJson(SEATS_FILE, seats);

    logger.info("Seat created in filesystem store", { seatId: normalizedId });
    res.status(201).json(cleanedSeat);
  } catch (error) {
    next(error);
  }
});

app.put("/api/seats/:seatId", requireAdmin, async (req, res, next) => {
  try {
    const { seatId } = req.params;
    const { label, x, y, width, height, rotation, zone, notes, floor: floorInput } =
      req.body || {};

    const seats = await readJson(SEATS_FILE, []);
    const building = await readBuildingConfig();
    logger.debug("Seat update requested", {
      seatId,
      payload: { label, x, y, width, height, rotation, zone, notes, floor: floorInput }
    });
    logger.debug("Available seat IDs", {
      seatIds: seats.map((seat) => seat.id)
    });
    const seatIndex = seats.findIndex((seat) => seat.id === seatId);

    if (seatIndex === -1) {
      logger.warn("Seat not found for update", { seatId });
      return res.status(404).json({ message: `Seat ${seatId} does not exist.` });
    }

    const seatToUpdate = { ...seats[seatIndex] };

    if (typeof label !== "undefined") {
      const normalizedLabel = normalizeText(label);
      if (!normalizedLabel) {
        return res.status(400).json({ message: "Label must not be empty." });
      }
      seatToUpdate.label = normalizedLabel;
    }

    if (typeof zone !== "undefined") {
      const normalizedZone = normalizeText(zone);
      if (normalizedZone) {
        seatToUpdate.zone = normalizedZone;
      } else {
        delete seatToUpdate.zone;
      }
    }

    if (typeof notes !== "undefined") {
      const normalizedNotes = normalizeText(notes);
      if (normalizedNotes) {
        seatToUpdate.notes = normalizedNotes;
      } else {
        delete seatToUpdate.notes;
      }
    }

    if (typeof x !== "undefined") {
      const parsedX = parseCoordinate(x);
      if (parsedX === null) {
        return res
          .status(400)
          .json({ message: "x must be a number between 0 and 100." });
      }
      seatToUpdate.x = parsedX;
    }

    if (typeof y !== "undefined") {
      const parsedY = parseCoordinate(y);
      if (parsedY === null) {
        return res
          .status(400)
          .json({ message: "y must be a number between 0 and 100." });
      }
      seatToUpdate.y = parsedY;
    }

    if (typeof width !== "undefined") {
      const parsedWidth = parseDimensionPercent(width);
      if (parsedWidth === null) {
        return res
          .status(400)
          .json({ message: "Width must be a percentage between 0.5 and 100." });
      }
      seatToUpdate.width = parsedWidth;
    }

    if (typeof height !== "undefined") {
      const parsedHeight = parseDimensionPercent(height);
      if (parsedHeight === null) {
        return res
          .status(400)
          .json({ message: "Height must be a percentage between 0.5 and 100." });
      }
      seatToUpdate.height = parsedHeight;
    }

    if (typeof rotation !== "undefined") {
      seatToUpdate.rotation = parseRotation(rotation);
    }

    if (typeof floorInput !== "undefined") {
      const parsedFloor = Number(floorInput);
      if (!Number.isFinite(parsedFloor)) {
        return res.status(400).json({ message: "Floor must be a valid number." });
      }
      const normalizedFloor = Math.trunc(parsedFloor);
      if (normalizedFloor < 1 || normalizedFloor > building.floorCount) {
        return res.status(400).json({
          message: `Floor must be between 1 and ${building.floorCount}.`
        });
      }
      seatToUpdate.floor = normalizedFloor;
    } else {
      const currentFloor = Number(seatToUpdate.floor);
      const normalizedFloor = Number.isFinite(currentFloor) ? Math.trunc(currentFloor) : 1;
      seatToUpdate.floor = Math.min(building.floorCount, Math.max(1, normalizedFloor));
    }

    seats[seatIndex] = seatToUpdate;
    await writeJson(SEATS_FILE, seats);

    logger.info("Seat updated in filesystem store", { seatId });
    res.json(seatToUpdate);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/seats/:seatId", requireAdmin, async (req, res, next) => {
  try {
    const { seatId } = req.params;
    const seats = await readJson(SEATS_FILE, []);
    const seatIndex = seats.findIndex((seat) => seat.id === seatId);

    if (seatIndex === -1) {
      return res.status(404).json({ message: `Seat ${seatId} does not exist.` });
    }

    const bookings = await readJson(BOOKINGS_FILE, []);
    const hasBookings = bookings.some((booking) => booking.seatId === seatId);

    if (hasBookings) {
      return res.status(409).json({
        message: `Seat ${seatId} has existing bookings. Please cancel them first.`
      });
    }

    const [removedSeat] = seats.splice(seatIndex, 1);
    await writeJson(SEATS_FILE, seats);

    logger.info("Seat removed from filesystem store", { seatId });
    res.json({ removed: removedSeat });
  } catch (error) {
    next(error);
  }
});

app.get("/api/bookings", async (req, res, next) => {
  try {
    const requestedDate = normalizeDate(req.query.date);
    const bookings = await readJson(BOOKINGS_FILE, []);

    logger.debug("Fetching bookings", {
      filterDate: requestedDate ?? "all"
    });

    if (!requestedDate) {
      res.json(bookings);
      return;
    }

    const filtered = bookings.filter((booking) => booking.date === requestedDate);
    res.json(filtered);
  } catch (error) {
    next(error);
  }
});

app.post("/api/bookings", async (req, res, next) => {
  try {
    const { seatId, date, userName, recurrence, skipConflicts } = req.body || {};
    const trimmedName = typeof userName === "string" ? userName.trim() : "";
    const normalizedDate = normalizeDate(date);

    if (!seatId || !trimmedName || !normalizedDate) {
      return res.status(400).json({
        message: "seatId, date and userName are required and must be valid."
      });
    }

    let recurrenceConfig = null;
    try {
      recurrenceConfig = normalizeRecurrence(recurrence);
    } catch (error) {
      return res.status(400).json({
        message:
          error instanceof Error ? error.message : "Recurrence definition is not valid."
      });
    }

    const [seats, bookings] = await Promise.all([
      readJson(SEATS_FILE, []),
      readJson(BOOKINGS_FILE, [])
    ]);

    logger.info("Booking creation requested", {
      seatId,
      date: normalizedDate,
      skipConflicts: Boolean(skipConflicts),
      recurrence: recurrenceConfig ?? "single"
    });

    const seatExists = seats.some((seat) => seat.id === seatId);
    if (!seatExists) {
      return res.status(404).json({ message: `Seat ${seatId} does not exist.` });
    }

    const plan = computeBookingPlan({
      seatId,
      startDate: normalizedDate,
      recurrence: recurrenceConfig,
      bookings
    });

    if (plan.targetDates.length === 0) {
      return res.status(400).json({ message: "Requested booking dates could not be resolved." });
    }

    if (plan.conflicts.length > 0 && !skipConflicts) {
      return res.status(409).json({
        message: `Seat ${seatId} is already booked for ${plan.conflicts
          .map((conflict) => conflict.date)
          .join(", ")}.`,
        conflicts: plan.conflicts.map(toPublicConflict),
        preview: buildPreviewResponse(plan, recurrenceConfig)
      });
    }

    const allowedDates =
      plan.conflicts.length > 0 && skipConflicts
        ? plan.targetDates.filter(
            (date) => !plan.conflicts.some((conflict) => conflict.date === date)
          )
        : plan.targetDates;

    if (allowedDates.length === 0) {
      return res.status(409).json({
        message: `Seat ${seatId} is not available on any of the requested dates.`,
        conflicts: plan.conflicts.map(toPublicConflict),
        preview: buildPreviewResponse(plan, recurrenceConfig)
      });
    }

    const timestamp = new Date().toISOString();
    const seriesId = uuid();
    const newBookings = allowedDates.map((bookingDate) => ({
      id: uuid(),
      seriesId,
      seatId,
      date: bookingDate,
      userName: trimmedName,
      createdAt: timestamp
    }));

    bookings.push(...newBookings);
    logger.info("Persisting bookings", {
      seatId,
      createdCount: newBookings.length,
      skippedConflicts: plan.conflicts.length,
      skipConflicts: Boolean(skipConflicts)
    });
    await writeJson(BOOKINGS_FILE, bookings);

    if (skipConflicts) {
      res.status(201).json({
        message:
          plan.conflicts.length > 0
            ? `Created ${newBookings.length} bookings and skipped ${plan.conflicts.length}.`
            : `Created ${newBookings.length} bookings.`,
        seriesId,
        created: newBookings,
        skipped: plan.conflicts.map((conflict) => ({
          date: conflict.date,
          reason: "conflict",
          booking: toPublicConflict(conflict)
        })),
        conflicts: plan.conflicts.map(toPublicConflict).filter(Boolean),
        requestedCount: plan.targetDates.length,
        preview: buildPreviewResponse(plan, recurrenceConfig)
      });
      logger.info("Booking creation completed with conflict skips", {
        seatId,
        seriesId,
        createdCount: newBookings.length,
        skippedCount: plan.conflicts.length
      });
      return;
    }

    if (newBookings.length === 1) {
      res.status(201).json(newBookings[0]);
    } else {
      res.status(201).json({
        seriesId,
        created: newBookings,
        recurrence: recurrenceConfig
          ? {
              frequency: recurrenceConfig.frequency,
              count: recurrenceConfig.count
            }
          : { frequency: "single", count: newBookings.length }
      });
    }

    logger.info("Booking creation completed", {
      seatId,
      seriesId,
      createdCount: newBookings.length
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/bookings/preview", async (req, res, next) => {
  try {
    const { seatId, date, recurrence } = req.body || {};
    const normalizedDate = normalizeDate(date);

    if (!seatId || !normalizedDate) {
      return res.status(400).json({
        message: "seatId and date are required and must be valid."
      });
    }

    let recurrenceConfig = null;
    try {
      recurrenceConfig = normalizeRecurrence(recurrence);
    } catch (error) {
      return res.status(400).json({
        message:
          error instanceof Error ? error.message : "Recurrence definition is not valid."
      });
    }

    const [seats, bookings] = await Promise.all([
      readJson(SEATS_FILE, []),
      readJson(BOOKINGS_FILE, [])
    ]);

    logger.debug("Booking preview requested", {
      seatId,
      date: normalizedDate,
      recurrence: recurrenceConfig ?? "single"
    });

    const seatExists = seats.some((seat) => seat.id === seatId);
    if (!seatExists) {
      return res.status(404).json({ message: `Seat ${seatId} does not exist.` });
    }

    const plan = computeBookingPlan({
      seatId,
      startDate: normalizedDate,
      recurrence: recurrenceConfig,
      bookings
    });

    res.json(buildPreviewResponse(plan, recurrenceConfig));
    logger.debug("Booking preview response computed", {
      seatId,
      occurrences: plan.targetDates.length
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/bookings/:bookingId", async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    if (!bookingId) {
      return res.status(400).json({ message: "bookingId parameter is required." });
    }

    logger.info("Booking deletion requested", { bookingId });

    const bookings = await readJson(BOOKINGS_FILE, []);
    const bookingIndex = bookings.findIndex((booking) => booking.id === bookingId);

    if (bookingIndex === -1) {
      return res.status(404).json({ message: `Booking ${bookingId} not found.` });
    }

    const [removedBooking] = bookings.splice(bookingIndex, 1);
    await writeJson(BOOKINGS_FILE, bookings);

    await appendCancellation({
      bookingId: removedBooking.id,
      seatId: removedBooking.seatId,
      date: removedBooking.date,
      userName: removedBooking.userName,
      source: "single"
    });

    logger.info("Booking deleted", {
      bookingId,
      seatId: removedBooking.seatId,
      date: removedBooking.date
    });
    res.json({ removed: removedBooking });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/bookings/series/:seriesId", async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    if (!seriesId) {
      return res.status(400).json({ message: "seriesId parameter is required." });
    }

    logger.info("Series cancellation requested", { seriesId });

    const bookings = await readJson(BOOKINGS_FILE, []);
    const today = new Date().toISOString().slice(0, 10);

    const [remaining, removed] = partitionBookingsBySeries(bookings, seriesId, today);

    if (removed.length === 0) {
      return res
        .status(404)
        .json({ message: `No upcoming bookings found for series ${seriesId}.` });
    }

    await writeJson(BOOKINGS_FILE, remaining);
    if (removed.length > 0) {
      await appendCancellation(
        removed.map((booking) => ({
          bookingId: booking.id,
          seatId: booking.seatId,
          date: booking.date,
          userName: booking.userName,
          source: "series"
        }))
      );
    }
    logger.info("Series cancellation completed", {
      seriesId,
      removedCount: removed.length
    });
    res.json({
      seriesId,
      removed: removed.map((booking) => ({
        id: booking.id,
        seatId: booking.seatId,
        date: booking.date,
        userName: booking.userName
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/analytics/summary", async (req, res, next) => {
  try {
    const fromParam = typeof req.query.from === "string" ? req.query.from : null;
    const toParam = typeof req.query.to === "string" ? req.query.to : null;

    const fromDate = fromParam ? normalizeDate(fromParam) : null;
    const toDate = toParam ? normalizeDate(toParam) : null;

    if (fromParam && !fromDate) {
      return res.status(400).json({ message: "Parameter 'from' must be a valid date." });
    }

    if (toParam && !toDate) {
      return res.status(400).json({ message: "Parameter 'to' must be a valid date." });
    }

    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).json({ message: "'from' must not be after 'to'." });
    }

    logger.info("Analytics summary requested", {
      from: fromDate ?? "auto",
      to: toDate ?? "auto"
    });

    const [bookings, seats, cancellations] = await Promise.all([
      readJson(BOOKINGS_FILE, []),
      readJson(SEATS_FILE, []),
      readJson(CANCELLATIONS_FILE, [])
    ]);

    const seatMap = new Map(seats.map((seat) => [seat.id, seat]));

    const candidateDates = [];
    bookings.forEach((booking) => {
      if (typeof booking.date === "string") {
        candidateDates.push(booking.date);
      }
      if (typeof booking.createdAt === "string") {
        const createdDate = normalizeDate(booking.createdAt);
        if (createdDate) {
          candidateDates.push(createdDate);
        }
      }
    });
    cancellations.forEach((entry) => {
      if (typeof entry.date === "string") {
        candidateDates.push(entry.date);
      }
      if (typeof entry.cancelledAt === "string") {
        const cancelledDate = normalizeDate(entry.cancelledAt);
        if (cancelledDate) {
          candidateDates.push(cancelledDate);
        }
      }
    });

    const sortedCandidates = candidateDates.filter(Boolean).sort();
    const fallbackStart = sortedCandidates[0] ?? getTodayDateString();
    const fallbackEnd =
      sortedCandidates.length > 0
        ? sortedCandidates[sortedCandidates.length - 1]
        : getTodayDateString();

    const rangeStart = fromDate ?? fallbackStart;
    const rangeEnd = toDate ?? fallbackEnd;

    const daysInRange = Math.max(
      1,
      Math.floor(
        (new Date(rangeEnd).setUTCHours(0, 0, 0, 0) -
          new Date(rangeStart).setUTCHours(0, 0, 0, 0)) /
          MS_PER_DAY
      ) + 1
    );

    const activeBookings = bookings.filter((booking) => {
      const bookingDate = typeof booking.date === "string" ? booking.date : null;
      if (!bookingDate) {
        return false;
      }
      if (bookingDate < rangeStart) {
        return false;
      }
      if (bookingDate > rangeEnd) {
        return false;
      }
      return true;
    });

    const createdInRange = bookings.filter((booking) => {
      const creationDate =
        typeof booking.createdAt === "string" ? normalizeDate(booking.createdAt) : null;
      if (!creationDate) {
        return false;
      }
      if (creationDate < rangeStart) {
        return false;
      }
      if (creationDate > rangeEnd) {
        return false;
      }
      return true;
    });

    const cancellationsInRange = cancellations.filter((entry) => {
      const cancelledDate =
        typeof entry.cancelledAt === "string" ? normalizeDate(entry.cancelledAt) : null;
      if (!cancelledDate) {
        return false;
      }
      if (cancelledDate < rangeStart) {
        return false;
      }
      if (cancelledDate > rangeEnd) {
        return false;
      }
      return true;
    });

    const uniqueUsers = new Set(
      activeBookings
        .map((booking) => booking.userName)
        .filter((name) => typeof name === "string" && name.trim().length > 0)
    );

    const accumulateCounts = (items, keySelector) => {
      const counts = new Map();
      items.forEach((item) => {
        const key = keySelector(item);
        if (!key) {
          return;
        }
        counts.set(key, (counts.get(key) ?? 0) + 1);
      });
      return counts;
    };

    const seatCounts = accumulateCounts(activeBookings, (booking) => booking.seatId);
    const topSeats = Array.from(seatCounts.entries())
      .map(([seatId, count]) => ({
        seatId,
        label: seatMap.get(seatId)?.label ?? seatId,
        count
      }))
      .sort((a, b) => b.count - a.count || a.seatId.localeCompare(b.seatId))
      .slice(0, 5);

    const userCounts = accumulateCounts(activeBookings, (booking) => booking.userName);
    const topUsers = Array.from(userCounts.entries())
      .map(([userName, count]) => ({ userName, count }))
      .sort((a, b) => b.count - a.count || a.userName.localeCompare(b.userName))
      .slice(0, 5);

    const cancellationCounts = accumulateCounts(
      cancellationsInRange,
      (entry) => entry.userName
    );
    const topCancellations = Array.from(cancellationCounts.entries())
      .map(([userName, count]) => ({ userName, count }))
      .sort((a, b) => b.count - a.count || a.userName.localeCompare(b.userName))
      .slice(0, 5);

    const dayCounts = accumulateCounts(activeBookings, (booking) => booking.date);
    const busiestDays = Array.from(dayCounts.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => b.count - a.count || a.date.localeCompare(b.date))
      .slice(0, 7);

    const summary = {
      range: {
        from: rangeStart,
        to: rangeEnd,
        days: daysInRange
      },
      totals: {
        created: createdInRange.length,
        canceled: cancellationsInRange.length,
        active: activeBookings.length,
        uniqueUsers: uniqueUsers.size
      },
      topSeats,
      topUsers,
      topCancellations,
      busiestDays,
      averageDailyBookings: activeBookings.length / daysInRange
    };

    res.json(summary);
    logger.info("Analytics summary completed", {
      from: rangeStart,
      to: rangeEnd,
      activeBookings: activeBookings.length,
      uniqueUsers: uniqueUsers.size
    });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(CLIENT_BUILD_DIR));
app.use(async (req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) {
    next();
    return;
  }

  try {
    await fs.access(path.join(CLIENT_BUILD_DIR, "index.html"));
    res.sendFile(path.join(CLIENT_BUILD_DIR, "index.html"));
  } catch (error) {
    next();
  }
});

app.use((err, req, res, _next) => {
  logger.error("Unhandled error while processing request", {
    path: req?.originalUrl,
    method: req?.method,
    error: err instanceof Error ? err : new Error(String(err))
  });
  res.status(500).json({ message: "Unexpected server error." });
});

ensureDataFiles()
  .then(() => {
    app.listen(PORT, () => {
      logger.info("Server is listening", { port: PORT });
    });
  })
  .catch((error) => {
    logger.error("Failed to start server", error);
    process.exit(1);
  });
function computeBookingPlan({ seatId, startDate, recurrence, bookings }) {
  const seatBookings = bookings.filter((booking) => booking.seatId === seatId);
  const bookingMap = new Map(
    seatBookings.map((booking) => [booking.date, booking])
  );
  const targetDates = recurrence
    ? generateRecurrenceDates(startDate, recurrence)
    : [startDate];

  const conflicts = targetDates
    .map((date) => {
      const existing = bookingMap.get(date);
      if (!existing) {
        return null;
      }
      return { date, booking: existing };
    })
    .filter(Boolean);

  const availableDates = targetDates.filter((date) => !bookingMap.has(date));

  return {
    seatId,
    startDate,
    recurrence,
    targetDates,
    conflicts,
    availableDates,
    bookingMap
  };
}

function toPublicConflict(conflict) {
  if (!conflict) {
    return null;
  }

  const booking = conflict.booking ?? conflict;
  return {
    date: conflict.date ?? booking.date,
    seatId: booking.seatId,
    bookingId: booking.id,
    userName: booking.userName,
    seriesId: booking.seriesId ?? null
  };
}

function buildPreviewResponse(plan, recurrence) {
  const suggestions = computeSuggestions(plan, recurrence);
  return {
    seatId: plan.seatId,
    startDate: plan.startDate,
    requestedCount: plan.targetDates.length,
    requestedDates: plan.targetDates,
    recurrence: recurrence
      ? { frequency: recurrence.frequency, count: recurrence.count }
      : { frequency: "single", count: plan.targetDates.length },
    available: plan.availableDates,
    conflicts: plan.conflicts.map(toPublicConflict).filter(Boolean),
    suggestions
  };
}

function computeSuggestions(plan, recurrence) {
  const suggestions = {};
  const availableSet = new Set(plan.availableDates);
  const stepper = getRecurrenceStepper(recurrence);

  if (plan.targetDates.length > 0) {
    const shortenDates = collectRun(plan.targetDates, 0, availableSet, stepper);
    suggestions.shorten = {
      count: shortenDates.length,
      dates: shortenDates
    };

    const contiguous = findLongestRun(plan.targetDates, availableSet, stepper);
    if (contiguous) {
      suggestions.contiguousBlock = contiguous;
    }
  }

  const alternative =
    findNextAvailableSeries(plan, recurrence, plan.bookingMap) ?? null;
  if (alternative && (plan.conflicts.length > 0 || alternative.startDate !== plan.startDate)) {
    suggestions.adjustStart = alternative;
  }

  return suggestions;
}

function collectRun(targetDates, startIndex, availableSet, stepper) {
  if (startIndex >= targetDates.length) {
    return [];
  }

  const dates = [];
  let previous = null;

  for (let index = startIndex; index < targetDates.length; index += 1) {
    const currentDate = targetDates[index];
    if (!availableSet.has(currentDate)) {
      break;
    }

    if (dates.length > 0 && typeof stepper === "function") {
      const expected = stepper(previous);
      if (expected !== currentDate) {
        break;
      }
    }

    dates.push(currentDate);
    previous = currentDate;
  }

  return dates;
}

function findLongestRun(targetDates, availableSet, stepper) {
  let best = { count: 0, dates: [] };

  for (let index = 0; index < targetDates.length; index += 1) {
    const currentDate = targetDates[index];
    if (!availableSet.has(currentDate)) {
      continue;
    }

    const run = collectRun(targetDates, index, availableSet, stepper);
    if (run.length > best.count) {
      best = {
        count: run.length,
        dates: run
      };
    }
  }

  if (best.count === 0) {
    return null;
  }

  return {
    startDate: best.dates[0],
    count: best.count,
    dates: best.dates
  };
}

function findNextAvailableSeries(plan, recurrence, bookingMap) {
  const totalOccurrences = plan.targetDates.length;
  if (totalOccurrences === 0) {
    return null;
  }

  const startDate = plan.startDate;
  const endLimit = offsetDate(startDate, PREVIEW_LOOKAHEAD_DAYS);

  for (let offset = 0; offset <= PREVIEW_LOOKAHEAD_DAYS; offset += 1) {
    const candidateStart = offsetDate(startDate, offset);
    if (candidateStart > endLimit) {
      break;
    }

    const candidateDates = recurrence
      ? generateRecurrenceDates(candidateStart, recurrence)
      : [candidateStart];

    const hasConflict = candidateDates.some((date) => bookingMap.has(date));
    if (!hasConflict) {
      return {
        startDate: candidateStart,
        dates: candidateDates
      };
    }
  }

  return null;
}

function partitionBookingsBySeries(bookings, seriesId, fromDate) {
  const keep = [];
  const removed = [];

  bookings.forEach((booking) => {
    if (
      booking.seriesId === seriesId &&
      typeof booking.date === "string" &&
      booking.date >= fromDate
    ) {
      removed.push(booking);
    } else {
      keep.push(booking);
    }
  });

  return [keep, removed];
}
function isAdminPasswordConfigured() {
  return ADMIN_PASSWORD.length > 0;
}

function safeCompareString(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function extractAdminHeader(req) {
  const header = req.headers["x-admin-secret"];
  return typeof header === "string" ? header : "";
}

function requireAdmin(req, res, next) {
  if (!isAdminPasswordConfigured()) {
    next();
    return;
  }

  const provided = extractAdminHeader(req);
  if (!provided || !safeCompareString(provided, ADMIN_PASSWORD)) {
    res.status(401).json({ message: "Invalid password for edit mode." });
    return;
  }

  next();
}

function normalizeRecurrence(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const { frequency, count } = candidate;
  const allowedFrequencies = new Set(["daily", "weekday", "weekly"]);
  if (!allowedFrequencies.has(frequency)) {
    throw new Error('Recurrence frequency must be "daily", "weekday" or "weekly".');
  }

  const parsedCount = Number(count);
  if (!Number.isFinite(parsedCount)) {
    throw new Error("Recurrence count must be a number.");
  }

  const normalizedCount = Math.trunc(parsedCount);
  if (normalizedCount < 1) {
    throw new Error("Recurrence count must be at least 1.");
  }
  if (normalizedCount > MAX_RECURRENCE_OCCURRENCES) {
    throw new Error(
      `Recurrence count must not exceed ${MAX_RECURRENCE_OCCURRENCES}.`
    );
  }

  if (normalizedCount === 1) {
    return null;
  }

  return {
    frequency,
    count: normalizedCount
  };
}

function generateRecurrenceDates(startDate, recurrence) {
  if (!recurrence) {
    return [startDate];
  }

  if (recurrence.frequency === "weekday") {
    return generateWeekdayDates(startDate, recurrence.count);
  }

  const intervalDays = recurrence.frequency === "daily" ? 1 : 7;
  const dates = [];

  for (let index = 0; index < recurrence.count; index += 1) {
    const offsetDays = index * intervalDays;
    dates.push(offsetDate(startDate, offsetDays));
  }

  return dates;
}

function offsetDate(startDate, offsetDays) {
  const reference = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(reference.getTime())) {
    throw new Error(`Cannot offset invalid date: ${startDate}`);
  }
  reference.setUTCDate(reference.getUTCDate() + offsetDays);
  return reference.toISOString().slice(0, 10);
}

function generateWeekdayDates(startDate, count) {
  const dates = [];
  let current = startDate;
  let safetyCounter = 0;
  const MAX_ITERATIONS = count * 7 + 14;

  while (dates.length < count) {
    if (isWeekend(current)) {
      current = advanceToNextWeekday(current);
    } else {
      dates.push(current);
      current = advanceToNextWeekday(current);
    }
    safetyCounter += 1;
    if (safetyCounter > MAX_ITERATIONS) {
      throw new Error("Failed to compute weekday recurrence dates.");
    }
  }

  return dates;
}

function isWeekend(dateString) {
  const reference = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(reference.getTime())) {
    throw new Error(`Invalid date encountered while checking weekend: ${dateString}`);
  }
  const day = reference.getUTCDay();
  return day === 0 || day === 6;
}

function advanceToNextWeekday(dateString) {
  let candidate = offsetDate(dateString, 1);
  for (let guard = 0; guard < 8; guard += 1) {
    if (!isWeekend(candidate)) {
      return candidate;
    }
    candidate = offsetDate(candidate, 1);
  }
  throw new Error("Failed to advance to the next weekday.");
}

function getRecurrenceStepper(recurrence) {
  if (!recurrence) {
    return null;
  }

  if (recurrence.frequency === "weekly") {
    return (date) => offsetDate(date, 7);
  }

  if (recurrence.frequency === "daily") {
    return (date) => offsetDate(date, 1);
  }

  if (recurrence.frequency === "weekday") {
    return (date) => advanceToNextWeekday(date);
  }

  return null;
}
