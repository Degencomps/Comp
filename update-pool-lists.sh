#!/usr/bin/env sh

wget https://api.mainnet.orca.so/v1/whirlpool/list -O ./src/markets/orca-whirlpool/mainnet.json
wget https://api.raydium.io/v2/ammV3/ammPools -O ./src/markets/raydium-clmm/mainnet.json
wget https://cache.jup.ag/markets?v=3 -O ./src/markets/jupiter/mainnet.json
wget https://quote-api.jup.ag/v6/program-id-to-label -O ./src/markets/jupiter/mainnet-programs.json

echo "export default " > ./src/markets/jupiter/mainnet-programs.ts
node -p "JSON.stringify(require('./src/markets/jupiter/mainnet-programs.json'), null, 2) + ' as const;'" >> ./src/markets/jupiter/mainnet-programs.ts