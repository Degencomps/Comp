import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { ArbIdea, ArbIdeaTrade, LAMPORTS_PER_USDC_UNIT } from './calculate-arb.js';
import { JSBI, JsbiType, Timings } from './types.js';
import * as fs from 'fs';
import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { config } from './config.js';
import { Instruction, QuoteResponse, RoutePlanStep, SwapInstructionsResponse, SwapMode } from "@jup-ag/api";
import { logger } from './logger.js';
import { jupiterClient } from './clients/jupiter.js';
import { connection } from "./clients/rpc.js";
import BN from "bn.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT
} from "@solana/spl-token-3";
import { IDL as JitoBomb } from "./clients/types/jito_bomb.js";
import { BASE_MINTS_OF_INTEREST_B58 } from "./constants.js";
import { Buffer } from "buffer";
import { SerializableLegFixed } from "./markets/types";

const TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
].map((pubkey) => new PublicKey(pubkey));

const getRandomTipAccount = () =>
  TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];

const MIN_TIP_LAMPORTS = config.get('min_tip_lamports');
const TIP_BPS = config.get('tip_bps');
const MAX_TIP_BPS = config.get('max_tip_bps');
const LEDGER_PROGRAM_ID = config.get('ledger_program')
const TXN_FEES_LAMPORTS = config.get('txn_fees_lamports'); // transaction fees in lamports TODO: need to consider new token account rents?

const MAX_USDC = 1200 * 10 ** 6
const MAX_SOL = 12 * 10 ** 9

// const MIN_BALANCE_RENT_EXEMPT_TOKEN_ACC =
//   await getMinimumBalanceForRentExemptAccount(connection);

// TODO: default minimum profit needs to cover transaction fee and the rent of tokens (regardless if there is a new one)
const MIN_PROFIT_IN_LAMPORTS = TXN_FEES_LAMPORTS // + MIN_BALANCE_RENT_EXEMPT_TOKEN_ACC; // in lamports

const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(fs.readFileSync(config.get('payer_keypair_path'), 'utf-8')),
  ),
);

const wallet = new anchor.Wallet(payer);
const provider = new anchor.AnchorProvider(connection, wallet, {
  commitment: "confirmed",
});
const ledgerProgram = new Program(JitoBomb, LEDGER_PROGRAM_ID, provider)

// todo: need to dynamically update this
const LAMPORTS_PER_USDC_UNITS = LAMPORTS_PER_USDC_UNIT


function deserializeSwapInstruction(instruction: Instruction) {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((key) => ({
      pubkey: new PublicKey(key.pubkey),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })), data: Buffer.from(instruction.data, "base64"),
  });
}

const addressLookupTableAccountCache = new Map<string, AddressLookupTableAccount>();

async function getAddressLookupTableAccounts(
  keys: string[]
): Promise<AddressLookupTableAccount[]> {
  const newKeys: string[] = [];
  const cachedResults: AddressLookupTableAccount[] = [];

  // Separate new keys and cached keys
  keys.forEach(key => {
    if (addressLookupTableAccountCache.has(key)) {
      cachedResults.push(addressLookupTableAccountCache.get(key));
    } else {
      newKeys.push(key);
    }
  });

  // Fetch new keys only
  const addressLookupTableAccountInfos = await connection.getMultipleAccountsInfo(
    newKeys.map(key => new PublicKey(key))
  );

  const newResults = addressLookupTableAccountInfos.reduce((acc, accountInfo, index) => {
    const addressLookupTableAddress = newKeys[index];
    if (accountInfo) {
      const addressLookupTableAccount = new AddressLookupTableAccount({
        key: new PublicKey(addressLookupTableAddress),
        state: AddressLookupTableAccount.deserialize(accountInfo.data),
      });
      acc.push(addressLookupTableAccount);
      addressLookupTableAccountCache.set(addressLookupTableAddress, addressLookupTableAccount);
    }

    return acc;
  }, [] as AddressLookupTableAccount[]);

  // Combine cached results and new results
  return [...cachedResults, ...newResults];
}

export type Arb = {
  bundle: VersionedTransaction[];
  trade: ArbIdeaTrade
  timings: Timings;
};

const ataCache = new Map<string, PublicKey>();
const getAta = (mint: PublicKey, owner: PublicKey) => {
  const key = `${mint.toBase58()}-${owner.toBase58()}`;
  if (ataCache.has(key)) {
    return ataCache.get(key);
  }
  const ata = getAssociatedTokenAddressSync(mint, owner);
  ataCache.set(key, ata);
  return ata;
};

async function* buildBundle(
  arbIdeaIterator: AsyncGenerator<ArbIdea>,
): AsyncGenerator<Arb> {
  for await (const arbIdea of arbIdeaIterator) {
    const { txn, timings, trade } = arbIdea;
    const { in: inAmount, out: outAmount, mirroringLegQuote, balancingLeg, balancingLegFirst } = trade;

    // const mirroringLegRoutePlan = mirroringLegQuote.routePlan
    const baseMint = balancingLegFirst ? balancingLeg.sourceMint : balancingLeg.destinationMint

    // todo: should put this logic in quote calculator
    let inAmountNumber = JSBI.toNumber(inAmount)
    inAmountNumber = baseMint === BASE_MINTS_OF_INTEREST_B58.SOL ? Math.min(inAmountNumber, MAX_SOL) : Math.min(inAmountNumber, MAX_USDC)
    // scale down
    const inAmountBN = JSBI.BigInt(inAmountNumber)
    const outAmountBN = JSBI.divide(JSBI.multiply(inAmountBN, outAmount), inAmount)
    // filter out trades that are too small
    if (baseMint === BASE_MINTS_OF_INTEREST_B58.SOL) {
      if (JSBI.lessThan(inAmount, JSBI.BigInt(100_000_000))) {
        continue
      }
    } else if (baseMint === BASE_MINTS_OF_INTEREST_B58.USDC) {
      if (JSBI.lessThan(inAmount, JSBI.BigInt(5_000_000))) {
        continue
      }
    }

    const allRoutesQuoteResponse = createAllRoutesQuoteResponse(
      {
        mirroringLegQuote,
        inAmount: inAmountBN,
        outAmount: outAmountBN,
        balancingLeg,
        balancingLegFirst
      }
    )

    logger.debug({ allRoutesQuoteResponse }, "all routes quote")

    const backrunningTx = await compileJupiterTransaction(
      {
        quoteResponse: allRoutesQuoteResponse,
        inAmount: inAmountBN,
        balancingLeg,
        balancingLegFirst,
        wallet,
        blockhash: txn.message.recentBlockhash,
      }
    )

    const res = await connection.simulateTransaction(backrunningTx, {
      replaceRecentBlockhash: false,
      commitment: "confirmed",
    })

    logger.info({ res }, "simulateTransaction")

    // construct bundle
    const bundle = [txn, backrunningTx];

    yield {
      bundle,
      trade,
      timings: {
        mempoolEnd: timings.mempoolEnd,
        preSimEnd: timings.preSimEnd,
        simEnd: timings.simEnd,
        postSimEnd: timings.postSimEnd,
        calcArbEnd: timings.calcArbEnd,
        buildBundleEnd: Date.now(),
        bundleSent: 0,
      },
    };
  }
}

function createAllRoutesQuoteResponse(
  {
    mirroringLegQuote,
    inAmount,
    outAmount,
    balancingLeg,
    balancingLegFirst
  }:
    {
      mirroringLegQuote: QuoteResponse,
      inAmount: JsbiType,
      outAmount: JsbiType,
      balancingLeg: SerializableLegFixed,
      balancingLegFirst: boolean
    }
): QuoteResponse {
  const mirroringLegRoutePlan = mirroringLegQuote.routePlan

  const allRoutesPlan: RoutePlanStep[] = [];
  const inputMint = balancingLegFirst ? balancingLeg.sourceMint : balancingLeg.destinationMint;
  const outputMint = balancingLegFirst ? balancingLeg.sourceMint : balancingLeg.destinationMint;

  const balancingLegRoutePlan: RoutePlanStep = {
    swapInfo: {
      ammKey: balancingLeg.marketId,
      label: balancingLeg.dex,
      inputMint: balancingLeg.sourceMint,
      outputMint: balancingLeg.destinationMint,
      inAmount: inAmount.toString(),
      outAmount: outAmount.toString(),
      feeAmount: "0",
      feeMint: inputMint,
    },
    percent: 100
  };

  if (balancingLegFirst) {
    allRoutesPlan.push(balancingLegRoutePlan, ...mirroringLegRoutePlan);
  } else {
    allRoutesPlan.push(...mirroringLegRoutePlan, balancingLegRoutePlan);
  }

  // construct quote response
  return {
    inputMint: inputMint,
    outputMint: outputMint,
    inAmount: inAmount.toString(),
    outAmount: inAmount.toString(),
    otherAmountThreshold: inAmount.toString(),
    swapMode: SwapMode.ExactIn,
    slippageBps: 2000, // we have ledger to check at the end so this is ok
    priceImpactPct: "1",
    routePlan: allRoutesPlan,
  };
}

async function compileJupiterTransaction(
  {
    quoteResponse,
    inAmount,
    balancingLeg,
    balancingLegFirst,
    wallet,
    blockhash
  }:
    {
      quoteResponse: QuoteResponse,
      inAmount: JsbiType,
      balancingLeg: SerializableLegFixed,
      balancingLegFirst: boolean,
      wallet: anchor.Wallet,
      blockhash: string,
    }
) {
  let allSwapInstructionsResponse: SwapInstructionsResponse
  try {
    allSwapInstructionsResponse = await jupiterClient.swapInstructionsPost({
      swapRequest: {
        userPublicKey: wallet.publicKey.toBase58(),
        quoteResponse: quoteResponse,
        useSharedAccounts: false,
        wrapAndUnwrapSol: false
      }
    })

  } catch (e) {
    logger.debug(e, "error jupiter swapInstructionsPost")
  }

  if (!allSwapInstructionsResponse) {
    throw new Error("no swap instructions response")
  }

  const inputMint = balancingLegFirst ? balancingLeg.sourceMint : balancingLeg.destinationMint;

  const randomSeed = new BN(Math.floor(Math.random() * 1000000));

  // todo: to optimize this
  const ledgerAccount = PublicKey.findProgramAddressSync(
    [Buffer.from("ledger"), wallet.publicKey.toBuffer(), randomSeed.toArrayLike(Buffer, "le", 8)],
    ledgerProgram.programId
  )[0];

  const baseTokenATA = getAta(
    new PublicKey(inputMint),
    wallet.publicKey
  );

  const minimumProfitInBaseToken = inputMint === BASE_MINTS_OF_INTEREST_B58.SOL ? MIN_PROFIT_IN_LAMPORTS : Math.ceil(MIN_PROFIT_IN_LAMPORTS / LAMPORTS_PER_USDC_UNITS)
  const lamportsPerBaseToken = inputMint === BASE_MINTS_OF_INTEREST_B58.SOL ? 1 : LAMPORTS_PER_USDC_UNITS

  const syncNativeIx = createSyncNativeInstruction(
    baseTokenATA
  )

  // manual construct instruction
  const instructions: TransactionInstruction[] = []

  // increse compute unit
  const modifyComputeUnitsIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1000000
  });

  instructions.push(modifyComputeUnitsIx)

  if (inputMint === BASE_MINTS_OF_INTEREST_B58.SOL) {
    const wrappedSolAccount = getAta(NATIVE_MINT, wallet.publicKey)

    // create wrapped sol account
    const createWrappedSolAccountIx =
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        wrappedSolAccount,
        wallet.publicKey,
        NATIVE_MINT
      )

    // transfer sol
    const transferIx = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wrappedSolAccount,
      lamports: JSBI.toNumber(inAmount)
    });

    instructions.push(createWrappedSolAccountIx)

    instructions.push(transferIx)
    instructions.push(syncNativeIx)
  }

  const startLedgerIx = await ledgerProgram.methods
    .startLedger(randomSeed)
    .accountsStrict({
      signer: wallet.publicKey,
      monitorAta: baseTokenATA,
      ledgerAccount,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  instructions.push(startLedgerIx)

  if (allSwapInstructionsResponse.tokenLedgerInstruction) {
    instructions.push(deserializeSwapInstruction(allSwapInstructionsResponse.tokenLedgerInstruction))
  }

  instructions.push(deserializeSwapInstruction(allSwapInstructionsResponse.swapInstruction))

  // if sol is base, sync native
  if (inputMint === BASE_MINTS_OF_INTEREST_B58.SOL) {
    instructions.push(syncNativeIx)
  }

  const endLedgerIx = await ledgerProgram.methods
    .endLedger(
      randomSeed,
      new BN(minimumProfitInBaseToken), // minimum profit in base token
      lamportsPerBaseToken,
      new BN(TIP_BPS), // tip bps of the (profit minus minimum profit in base token) TODO: dynamic tip in custom program
      new BN(MAX_TIP_BPS), // max tip bps of the sol balance
      new BN(MIN_TIP_LAMPORTS), // requires tip > min tip amount
    )
    .accountsStrict({
      signer: wallet.publicKey,
      monitorAta: baseTokenATA,
      ledgerAccount,
      tipAccount: getRandomTipAccount(),
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  instructions.push(endLedgerIx)

  if (inputMint === BASE_MINTS_OF_INTEREST_B58.SOL) {
    const wrappedSolAccount = getAta(NATIVE_MINT, wallet.publicKey)
    // close wrapped sol account
    const closeWrappedSolAccountIx = createCloseAccountInstruction(
      wrappedSolAccount,
      wallet.publicKey,
      wallet.publicKey
    );

    instructions.push(closeWrappedSolAccountIx)
  }

  const addressLookupTableAccounts: AddressLookupTableAccount[] = [];
  addressLookupTableAccounts.push(
    ...(await getAddressLookupTableAccounts(allSwapInstructionsResponse.addressLookupTableAddresses))
  );

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: instructions,
  }).compileToV0Message(addressLookupTableAccounts);

  const backrunningTx = new VersionedTransaction(messageV0);

  // sign and send
  backrunningTx.sign([wallet.payer]);

  return backrunningTx
}

export { buildBundle };
