const { createLogger, format, transports } = require("winston");

const { combine, timestamp, errors, json, colorize, printf } = format;

const isDev = process.env.NODE_ENV !== "production";

// Human-readable format for local development
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: "HH:mm:ss" }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    let out = `${ts} [${level}] ${message}`;
    if (stack) out += `\n${stack}`;
    const extras = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return out + extras;
  })
);

// Structured JSON for production — Docker captures stdout, so no file transports needed.
// Use `docker logs backend` or a log aggregator to read these.
const prodFormat = combine(timestamp(), errors({ stack: true }), json());

const logger = createLogger({
  level: isDev ? "debug" : "info",
  format: isDev ? devFormat : prodFormat,
  transports: [new transports.Console()],
});

module.exports = logger;
