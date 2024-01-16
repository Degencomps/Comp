import { RaydiumAmm, SplTokenSwapAmm, ammFactory } from '@jup-ag/core';
import { AccountInfo, PublicKey } from '@solana/web3.js';

import { jupiterClient } from '../clients/jupiter.js';
import { JUPITER_MARKETS_CACHE } from '../markets/jupiter/index.js';

console.log('loading program labels');
const programLabels = await jupiterClient.programIdToLabelGet();
console.log('loaded program labels');

console.log(programLabels);

for (const market of JUPITER_MARKETS_CACHE) {
  const dex = programLabels[market.owner];
  // console.log(`found ${programLabels[market.owner]}: ${market.pubkey}`);

  // base64 to buffer
  const buffer = Buffer.from(market.data[0], market.data[1]);
  const accountInfo: AccountInfo<Buffer> = {
    executable: market.executable,
    owner: new PublicKey(market.owner),
    lamports: market.lamports,
    data: buffer,
    rentEpoch: market.rentEpoch,
  };

  if (dex === 'Raydium') {
    const amm = ammFactory(
      new PublicKey(market.pubkey),
      accountInfo,
      market.params,
    ) as RaydiumAmm;
    if (amm['feePct'].toString() !== '0.0025') console.log(amm['feePct']);
  }

  if (dex === 'Orca V1' || dex === 'Orca V2') {
    const amm = ammFactory(
      new PublicKey(market.pubkey),
      accountInfo,
      market.params,
    ) as SplTokenSwapAmm;
    console.log(amm['feePct']);
  }

  // if (dex === 'Raydium CLMM') {
  //   try {
  //     const amm = ammFactory(
  //       new PublicKey(market.pubkey),
  //       accountInfo,
  //       market.params,
  //     ) as RaydiumClmm;
  //     console.log(amm['']);
  //   } catch (e) {
  //     console.log('failed to load raydium clmm: ' + market.pubkey);
  //   }
  // }
}
