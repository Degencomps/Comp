import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { searcher } from 'jito-ts';
import { BotWorkerParamMessage } from './bot-worker.js';
import { searcherClientManager } from './clients/jito.js';
import { config } from "./config.js";
import { logger } from './logger.js';
import { JupiterDexProgramLabelMap } from './markets/jupiter/index.js';
import { SPL_TOKEN_SWAP_DEXES } from './markets/spl-token-swap/index.js';
import { fuseGenerators } from './utils.js';
import { WorkerPool } from "./worker-pool.js";

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

const getProgramUpdates = (searcherClient: searcher.SearcherClient) =>
  searcherClient.programUpdates(PROGRAMS_OF_INTEREST, [], (error) => {
    logger.error({ error }, 'programUpdates error');
    throw error;
  })

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
      }
    },
  };

  await botWorkerPool.runTask<
    BotWorkerParamMessage, null
  >(message, MAX_BOT_WORKING_TIME_MS);
}

async function main() {
  const generators: AsyncGenerator<VersionedTransaction[]>[] = [];

  try {
    // subscribe to the default client
    generators.push(getProgramUpdates(searcherClientManager.getDefaultClient()));

    // subscribing to multiple mempools is in particular useful in europe (frankfurt and amsterdam)
    const updates = fuseGenerators(generators);

    for await (const update of updates) {
      await dispatchMempoolUpdate(update);
    }
  } catch (e) {
    logger.error({ e }, 'mempool error');
  }
}

await main();
