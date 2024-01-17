import { SplTokenSwapAmm } from '@jup-ag/core';
import { logger } from '../../logger.js';
import {
  JUPITER_MARKETS_CACHE,
  JupiterDexProgramLabel,
  JupiterDexProgramMap,
  JupiterMarketCache,
  tryMakeAmm,
} from '../jupiter/index.js';
import { DEX, Market } from '../types.js';
import { toPairString, toSerializableAccountInfo } from '../utils.js';

// something is wrong with the accounts of these markets
const MARKETS_TO_IGNORE = [];

export const SPL_TOKEN_SWAP_DEXES: JupiterDexProgramLabel[] = [
  'Orca V1',
  'Orca V2',
  'Token Swap',
  'StepN',
];

class SplTokenSwapDEX extends DEX {
  pools: JupiterMarketCache[];

  constructor() {
    super();

    this.pools = JUPITER_MARKETS_CACHE.filter(
      (pool) =>
        SPL_TOKEN_SWAP_DEXES.includes(JupiterDexProgramMap[pool.owner]) &&
        !MARKETS_TO_IGNORE.includes(pool.pubkey),
    );

    for (const pool of this.pools) {
      const dexLabel = JupiterDexProgramMap[pool.owner];
      const { amm, accountInfo } = tryMakeAmm<SplTokenSwapAmm>(pool) ?? {};

      if (!amm || !accountInfo) {
        logger.warn('Failed to make AMM for SPL Token Swap pool', {
          id: pool.pubkey,
          owner: pool.owner,
          dexLabel,
        });
        continue;
      }

      this.ammCalcAddPoolMessages.push({
        type: 'addPool',
        payload: {
          poolLabel: dexLabel,
          id: pool.pubkey,
          feeRateBps: Math.floor(amm['feePct'] * 10000), // eg 0.003 -> 25 bps
          serializableAccountInfo: toSerializableAccountInfo(accountInfo),
          params: pool.params,
        },
      });

      const [tokenMintA, tokenMintB] = amm.reserveTokenMints.map((x) =>
        x.toBase58(),
      );

      const [tokenVaultA, tokenVaultB] = amm
        .getAccountsForUpdate()
        .map((x) => x.toBase58());

      const market: Market = {
        tokenMintA,
        tokenVaultA,
        tokenMintB,
        tokenVaultB,
        dexLabel,
        id: amm.id,
      };

      const pairString = toPairString(tokenMintA, tokenMintB);

      if (this.pairToMarkets.has(pairString)) {
        this.pairToMarkets.get(pairString).push(market);
      } else {
        this.pairToMarkets.set(pairString, [market]);
      }
    }
  }

  // static calculateQuote(
  //   market: Market,
  //   amount: number,
  //   direction: 'AtoB' | 'BtoA',
  // ): number {
  //   return 0;
  // }
}

export { SplTokenSwapDEX };
