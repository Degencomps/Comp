import { AccountInfo, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import { connection } from '../../clients/rpc.js';
import { logger } from '../../logger.js';
import { DEX, Market } from '../types.js';
import { toPairString } from '../utils.js';

// something is wrong with the accounts of these markets
const MARKETS_TO_IGNORE = ['EXHyQxMSttcvLPwjENnXCPZ8GmLjJYHtNBnAkcFeFKMn'];

type PoolItem = {
  id: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
  ammConfig: {
    tradeFeeRate: number;
  };
};

const POOLS_JSON = JSON.parse(
  fs.readFileSync('./src/markets/raydium-clmm/mainnet.json', 'utf-8'),
) as {
  data: PoolItem[];
};

logger.debug(`Raydium CLMM: Found ${POOLS_JSON.data.length} pools`);

const poolsJson = POOLS_JSON.data;

const initialAccountBuffers: Map<string, AccountInfo<Buffer>> = new Map();
const addressesToFetch: PublicKey[] = [];

for (const pool of poolsJson) {
  addressesToFetch.push(new PublicKey(pool.id));
}

for (let i = 0; i < addressesToFetch.length; i += 100) {
  const batch = addressesToFetch.slice(i, i + 100);
  const accounts = await connection.getMultipleAccountsInfo(batch);
  for (let j = 0; j < accounts.length; j++) {
    if (accounts[j]) {
      initialAccountBuffers.set(batch[j].toBase58(), accounts[j]!);
    }
  }
}

class RaydiumClmmDEX extends DEX {
  raydiumPools: PoolItem[];

  constructor() {
    super();
    this.raydiumPools = poolsJson.filter((pool) => !MARKETS_TO_IGNORE.includes(pool.id));
    for (const pool of this.raydiumPools) {
      const initialAccountInfo = initialAccountBuffers.get(pool.id);
      if (!initialAccountInfo) {
        logger.warn(
          `Raydium CLMM: No initial account info for pool ${pool.id}`,
        );
        continue;
      }

      this.pools.push({
        poolLabel: 'Raydium CLMM',
        id: new PublicKey(pool.id),
        feeRateBps: Math.floor(pool.ammConfig.tradeFeeRate / 100),
        accountInfo: initialAccountInfo
      });

      const market: Market = {
        tokenMintA: pool.mintA,
        tokenVaultA: pool.vaultA,
        tokenMintB: pool.mintB,
        tokenVaultB: pool.vaultB,
        dexLabel: 'Raydium CLMM',
        id: pool.id,
      };

      const pairString = toPairString(pool.mintA, pool.mintB);
      if (this.pairToMarkets.has(pairString)) {
        this.pairToMarkets.get(pairString)!.push(market);
      } else {
        this.pairToMarkets.set(pairString, [market]);
      }
    }
  }
}

export { RaydiumClmmDEX };
