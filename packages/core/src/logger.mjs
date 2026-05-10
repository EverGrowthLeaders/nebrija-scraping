import pino from "pino";
import { config } from "./config.mjs";

export const logger = pino({
  level: process.env.LOG_LEVEL || (config.env === "production" ? "info" : "debug"),
  base: {
    service: process.env.SERVICE_NAME || "lexington"
  }
});
