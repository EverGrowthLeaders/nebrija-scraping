import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import { config } from "./config.mjs";

export const QUEUE_NAMES = {
  googleDiscovery: "google-discovery",
  webDiscovery: "web-discovery",
  businessCrawl: "business-crawl",
  scoring: "scoring",
  adsEnrichment: "ads-enrichment",
  decisionMakerEnrichment: "decision-maker-enrichment",
  voiceCall: "voice-call"
};

let connection;

export function getRedisConnection() {
  if (!connection) {
    connection = new IORedis(config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    });
  }
  return connection;
}

export function createQueue(name) {
  return new Queue(name, {
    connection: getRedisConnection(),
    prefix: config.queues.prefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5000
      },
      removeOnComplete: 1000,
      removeOnFail: 5000
    }
  });
}

export function createWorker(name, processor, options = {}) {
  return new Worker(name, processor, {
    connection: getRedisConnection(),
    prefix: config.queues.prefix,
    concurrency: options.concurrency || config.queues.concurrency
  });
}

export async function closeQueues(queuesOrWorkers) {
  await Promise.all(queuesOrWorkers.map((item) => item.close()));
  if (connection) await connection.quit();
}
