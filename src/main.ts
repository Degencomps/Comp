import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { searcher } from 'jito-ts';
import { BotWorkerParamMessage } from './bot-worker.js';
import { searcherClientManager } from './clients/jito.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { JupiterDexProgramLabelMap } from './markets/jupiter/index.js';
import { SPL_TOKEN_SWAP_DEXES } from './markets/spl-token-swap/index.js';
import { fuseGenerators, getFormattedTimestamp } from './utils.js';
import { WorkerPool } from './worker-pool.js';
import fs from "fs";
import { stringify } from "csv-stringify";

const NUM_WORKER_THREADS = config.get('num_worker_threads');
const MAX_BOT_WORKING_TIME_MS = config.get('max_bot_working_time_ms');

const botWorkerPool = new WorkerPool(
  NUM_WORKER_THREADS,
  './build/src/bot-worker.js',
);
await botWorkerPool.initialize();
logger.info('Started bot worker pool');
await Promise.all(botWorkerPool.runTaskOnAllWorkers({ type: 'initialize' }));
logger.info('Initialized bot worker pool');

const PROGRAMS_OF_INTEREST = [
  JupiterDexProgramLabelMap.Raydium,
  JupiterDexProgramLabelMap['Raydium CLMM'],
  JupiterDexProgramLabelMap.Whirlpool,
  ...SPL_TOKEN_SWAP_DEXES.map((x) => JupiterDexProgramLabelMap[x]),
].map((m) => new PublicKey(m));

logger.debug({ PROGRAMS_OF_INTEREST }, 'programs of interest');

type BundleCSV = {
  client: string,
  timestamp: number;
  bundleId: string
  accepted: string;
  rejected: string;
  finalized: string;
  dropped: string;
}

const bundlesCsv = fs.createWriteStream(`bundles_${getFormattedTimestamp()}.csv`, { flags: 'a' });
const stringifier = stringify({
  header: true,
});
stringifier.pipe(bundlesCsv);

const searcherSendClients = searcherClientManager.getAllSendClients();
const searcherMempoolClients = searcherClientManager.getAllMempoolClients();

let lastBundleUpdateReceivedAt = Date.now()
for (const [i, client] of searcherSendClients.entries()) {
  client.onBundleResult(
    (bundleResult) => {
      lastBundleUpdateReceivedAt = Date.now();

      const bundle: BundleCSV = {
        client: i.toString(),
        timestamp: Date.now(),
        bundleId: bundleResult.bundleId,
        accepted: JSON.stringify(bundleResult.accepted),
        rejected: JSON.stringify(bundleResult.rejected),
        finalized: JSON.stringify(bundleResult.finalized),
        dropped: JSON.stringify(bundleResult.dropped),
      }
      stringifier.write(bundle);
    },
    (error) => {
      logger.error({ error }, `onBundleResult error`);
    },
  );
}

// Set up an interval to check periodically
setInterval(() => {
  const timeDiff = Date.now() - lastBundleUpdateReceivedAt;

  if (timeDiff > 3 * 60 * 1000) {
    logger.error(`No update received in the last 5 minutes`);
    throw new Error("No update received in the last 5 minutes...exiting...");
  }

  logger.info(`Health Checking last bundle updated is ${timeDiff / 1000} seconds ago`);
}, 60 * 1000); // Check every minute

const getProgramUpdates = (searcherClient: searcher.SearcherClient) =>
  searcherClient.programUpdates(PROGRAMS_OF_INTEREST, [], (error) => {
    logger.error({ error }, 'programUpdates error');
    throw error;
  });

async function dispatchMempoolUpdate(txns: VersionedTransaction[]) {
  const message: BotWorkerParamMessage = {
    type: 'mempool',
    payload: {
      txnsSerialised: txns.map(t => t.serialize()),
      timings: {
        mempoolEnd: Date.now(),
        preSimEnd: 0,
        simEnd: 0,
        postSimEnd: 0,
        calcArbEnd: 0,
        buildBundleEnd: 0,
        bundleSent: 0,
      },
    },
  };

  await botWorkerPool.runTask<
    BotWorkerParamMessage, null
  >(message, MAX_BOT_WORKING_TIME_MS);
}

async function dispatchMempoolUpdatesIndividually(txns: VersionedTransaction[]) {
  await Promise.all(txns.map(t => dispatchMempoolUpdate([t])));
}

const generators: AsyncGenerator<VersionedTransaction[]>[] = [];
// subscribe to the default client
for (const client of searcherMempoolClients) {
  generators.push(getProgramUpdates(client));
}

// subscribing to multiple mempools is in particular useful in europe (frankfurt and amsterdam)
const updates = fuseGenerators(generators);

for await (const update of updates) {
  await dispatchMempoolUpdatesIndividually(update);
}
