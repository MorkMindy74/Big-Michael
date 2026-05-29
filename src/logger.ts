import { createLogger, format, transports } from "winston";
import { Config } from "./config.js";

export const logger = createLogger({
  level: Config.logging.level,
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.colorize(),
    format.printf(({ timestamp, level, message, ...meta }) => {
      const extras = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
      return `${timestamp} [${level}] ${message}${extras}`;
    }),
  ),
  transports: [new transports.Console()],
});
