const LEVELS = ["error", "warn", "info", "debug"];
const LEVEL_PRIORITY = LEVELS.reduce((acc, level, index) => {
  acc[level] = index;
  return acc;
}, {});

const rawLevel = process.env.LOG_LEVEL
  ? String(process.env.LOG_LEVEL).toLowerCase()
  : "info";
const activeLevel = LEVEL_PRIORITY[rawLevel] !== undefined ? rawLevel : "info";

function normalizeMeta(meta) {
  if (!meta) {
    return undefined;
  }

  if (meta instanceof Error) {
    return {
      message: meta.message,
      stack: meta.stack,
      name: meta.name
    };
  }

  if (typeof meta === "object") {
    return meta;
  }

  return { details: meta };
}

function log(level, message, meta) {
  if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[activeLevel]) {
    return;
  }

  const timestamp = new Date().toISOString();
  const output = [`[${timestamp}]`, level.toUpperCase(), "-", message];
  const metaPayload = normalizeMeta(meta);

  if (metaPayload) {
    output.push(JSON.stringify(metaPayload));
  }

  const target =
    level === "error"
      ? console.error
      : level === "warn"
      ? console.warn
      : console.log;

  target(output.join(" "));
}

const logger = {
  error(message, meta) {
    log("error", message, meta);
  },
  warn(message, meta) {
    log("warn", message, meta);
  },
  info(message, meta) {
    log("info", message, meta);
  },
  debug(message, meta) {
    log("debug", message, meta);
  }
};

module.exports = logger;
