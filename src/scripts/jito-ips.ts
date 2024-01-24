import { Connection } from "@solana/web3.js";
import { config } from "dotenv";
import fetch from "node-fetch";
import geo from 'geoip-lite';

config();

const conn = new Connection(process.env.RPC_URL, 'processed');
const nodes = await conn.getClusterNodes();
const voters = await conn.getVoteAccounts();
const votingNodes = voters.current.map(v => ({
  ...v,
  node: nodes.find(n => n.pubkey === v.nodePubkey)
}))
const jito = await fetch('https://kobe.mainnet.jito.network/api/v1/validators').then(x => x.json()) as { validators: { vote_account: string, running_jito: boolean, active_stake: number, mev_commission_bps: number }[] };

const validators = jito.validators.map(v => votingNodes.find(n => n.votePubkey === v.vote_account)).sort((a, b) => b.activatedStake - a.activatedStake).filter(Boolean);
const totalStake = validators.reduce((acc, v) => acc + v.activatedStake, 0);

const isEurope = (geo: { eu: string, country: string }) => geo?.eu === '1' || geo?.country === 'GB';

const mapped = validators.map(v => {
  const geoGossip = geo.lookup(v.node?.gossip?.split(":")[0]);
  const geoTpu = geo.lookup(v.node?.tpu?.split(":")[0]);
  return {
    ...v,
    geoGossip: geoGossip ? `${isEurope(geoGossip) ? 'EU' : geoGossip.country}-${geoGossip.region}` : '',
    geoTpu: geoTpu ? `${isEurope(geoGossip) ? 'EU' : geoTpu.country}-${geoTpu.region}` : '',
    stakeWeightPct: v.activatedStake / totalStake * 100
  }
})

const csv = mapped.map(v => `${v.votePubkey},${v.geoGossip},${v.geoTpu},${v.activatedStake},${v.stakeWeightPct}`).join('\n');

console.log(csv);

