import { RaydiumAmm } from '@jup-ag/core';
import { logger } from '../../logger.js';
import {
  JUPITER_MARKETS_CACHE,
  JupiterDexProgramMap,
  JupiterMarketCache,
  tryMakeAmm,
} from '../jupiter/index.js';
import { DEX, Market } from '../types.js';
import { toPairString, toSerializableAccountInfo } from '../utils.js';

// something is wrong with the accounts of these markets
const MARKETS_TO_IGNORE = [
  '9DTY3rv8xRa3CnoPoWJCMcQUSY7kUHZAoFKNsBhx8DDz',
  '2EXiumdi14E9b8Fy62QcA5Uh6WdHS2b38wtSxp72Mibj',
  '9f4FtV6ikxUZr8fAjKSGNPPnUHJEwi4jNk8d79twbyFf',
  '5NBtQe4GPZTRiwrmkwPxNdAuiVFGjQWnihVSqML6ADKT', // pool not tradeable
];

class RaydiumDEX extends DEX {
  pools: JupiterMarketCache[];

  constructor() {
    super();

    this.pools = JUPITER_MARKETS_CACHE.filter(
      (pool) =>
        JupiterDexProgramMap[pool.owner] === 'Raydium' &&
        !MARKETS_TO_IGNORE.includes(pool.pubkey),
    );

    for (const pool of this.pools) {
      const { amm, accountInfo } = tryMakeAmm<RaydiumAmm>(pool) ?? {};

      if (!amm || !accountInfo) {
        logger.warn('Failed to make AMM for Raydium pool', { id: pool.pubkey });
        continue;
      }

      this.ammCalcAddPoolMessages.push({
        type: 'addPool',
        payload: {
          poolLabel: 'Raydium',
          id: pool.pubkey,
          feeRateBps: Math.floor(amm['feePct'] * 10000), // always 0.0025 -> 25 bps
          serializableAccountInfo: toSerializableAccountInfo(accountInfo),
          params: pool.params,
        },
      });

      const [tokenMintA, tokenMintB] = amm.reserveTokenMints.map((x) =>
        x.toBase58(),
      );

      const [tokenVaultA, tokenVaultB] = [
        amm.poolCoinTokenAccount,
        amm.poolPcTokenAccount,
      ].map((x) => x.toBase58());

      const market: Market = {
        tokenMintA,
        tokenVaultA,
        tokenMintB,
        tokenVaultB,
        dexLabel: 'Raydium',
        id: amm.id,
      };

      const pairString = toPairString(tokenMintA, tokenMintB);
      if (this.pairToMarkets.has(pairString)) {
        this.pairToMarkets.get(pairString)!.push(market);
      } else {
        this.pairToMarkets.set(pairString, [market]);
      }
    }
  }
}

export { RaydiumDEX };
