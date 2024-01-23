import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { logger } from './logger.js';
import { Timings } from './types.js';
//import { SearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';
import { searcher } from 'jito-ts';
import { searcherClientManager } from './clients/jito.js';
import { JupiterDexProgramLabelMap } from './markets/jupiter/index.js';
import { SPL_TOKEN_SWAP_DEXES } from './markets/spl-token-swap/index.js';
import { fuseGenerators } from './utils.js';

const PROGRAMS_OF_INTEREST = [
  JupiterDexProgramLabelMap.Raydium,
  JupiterDexProgramLabelMap['Raydium CLMM'],
  JupiterDexProgramLabelMap.Whirlpool,
  ...SPL_TOKEN_SWAP_DEXES.map((x) => JupiterDexProgramLabelMap[x]),
].map((m) => new PublicKey(m));

logger.debug({ PROGRAMS_OF_INTEREST }, 'programs of interest');

type MempoolUpdate = {
  txns: VersionedTransaction[];
  timings: Timings;
};

const getProgramUpdates = (searcherClient: searcher.SearcherClient) =>
  searcherClient.programUpdates(PROGRAMS_OF_INTEREST, [], (error) => {
    logger.error({ error }, 'programUpdates error');
    // throw error;
  })

async function* mempool(): AsyncGenerator<MempoolUpdate> {
  const generators: AsyncGenerator<VersionedTransaction[]>[] = [];

  try {
    // subscribe to the default client
    generators.push(getProgramUpdates(searcherClientManager.getDefaultClient()));

    // subscribing to multiple mempools is in particular useful in europe (frankfurt and amsterdam)
    const updates = fuseGenerators(generators);

    for await (const update of updates) {
      yield {
        txns: update,
        timings: {
          mempoolEnd: Date.now(),
          preSimEnd: 0,
          simEnd: 0,
          postSimEnd: 0,
          calcArbEnd: 0,
          buildBundleEnd: 0,
          bundleSent: 0,
        },
      };
    }
  } catch (e) {
    logger.error({ e }, 'mempool error');
  }

}

export { MempoolUpdate, mempool };
