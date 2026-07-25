# 0G testnet inference sidecar

Bridges the Python codec to **0G Compute testnet** inference (faucet-funded) for best-of-N
cover selection. The codec sends N candidate covers; a 0G-hosted model picks the most natural.
0G only *judges* the (public) cover text — never plaintext, never ciphertext.

Why a sidecar: 0G's broker is a **TypeScript** SDK (`@0glabs/0g-serving-broker`) and testnet
inference is paid per-request by signing on-chain with your wallet — so this small Node service
holds the wallet + broker, and the Python codec just calls its `/select` over HTTP.

## Testnet, faucet-funded (chain 16602)

- RPC `https://evmrpc-testnet.0g.ai`, faucet https://faucet.0g.ai
- Judge model default: `qwen/qwen-2.5-7b-instruct` (provider `0xa48f…7836`). Alt: DeepSeek-V3.1
  (`0xd996…471C`). Prices are ~0.00000005 OG/token — trivial.
- **Ledger setup needs 3 OG minimum** (broker v0.6.x). Public faucet is 0.1 OG/day → get a
  proper testnet top-up at the **0G booth** (hand them the wallet address).

## Run

```bash
cd codec/zerog-sidecar
npm install
ZG_PRIVATE_KEY=0x<funded-testnet-wallet-key> node server.mjs   # :8090
curl localhost:8090/health         # { ready, provider, model, balance }
```

Then tell the codec to use it (no app-sk key needed):

```bash
# local:
ZEROG_SIDECAR=http://localhost:8090 CODEC_VARIANTS=3 python3 ../server.py
# on fly: run this as a second process/app and set the codec's ZEROG_SIDECAR + CODEC_VARIANTS
```

`/health` on the codec then shows `select: 0g-best-of-3`, and each send generates 3 covers →
the sidecar's `/select` returns the most natural → that one is sent.

## Wallet

Use a **throwaway testnet wallet** (not an identity/mainnet wallet). It only holds testnet 0G
and signs inference micro-payments. The private key stays in the sidecar's env — never in the
repo, never in the extension.
