import { Amm, ammFactory } from '@jup-ag/core';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import programs from './mainnet-programs.js';
import { logger } from "../../logger.js";

// make a type that's the values of the mainnet-programs.json
export const JupiterDexProgramMap = programs;
type JupiterDexProgramMap = typeof JupiterDexProgramMap;
export type JupiterDexProgramLabel =
  JupiterDexProgramMap[keyof JupiterDexProgramMap];

function invertMap(
  obj: JupiterDexProgramMap,
): Record<JupiterDexProgramLabel, string> {
  const result: any = {};
  for (const key in obj) {
    result[obj[key]] = key;
  }
  return result;
}

export const JupiterDexProgramLabelMap = invertMap(JupiterDexProgramMap);

export type JupiterMarketCache = {
  pubkey: string;
  lamports: number;
  data: [string, 'base64'];
  owner: string;
  executable: boolean;
  rentEpoch: number;
  space: number;
  params: any;
};

export const JUPITER_MARKETS_CACHE = JSON.parse(
  fs.readFileSync('./src/markets/jupiter/mainnet.json', 'utf-8'),
) as JupiterMarketCache[];

export function tryMakeAmm<T extends Amm>(
  market: JupiterMarketCache,
): { amm: T; accountInfo: AccountInfo<Buffer> } | null {
  const buffer = Buffer.from(market.data[0], market.data[1]);
  const accountInfo: AccountInfo<Buffer> = {
    executable: market.executable,
    owner: new PublicKey(market.owner),
    lamports: market.lamports,
    data: buffer,
    rentEpoch: market.rentEpoch,
  };

  try {
    const amm = ammFactory(
      new PublicKey(market.pubkey),
      accountInfo,
      market.params,
    ) as T;

    return { amm, accountInfo };
  } catch (e) {
    logger.warn(e, 'Failed to make AMM')
  }

  return null;
}
