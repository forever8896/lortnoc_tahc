# Fine-tune the cover model on 0G Compute (testnet)

Fine-tune `Qwen2.5-0.5B-Instruct` on casual chat via **0G Compute**, download + decrypt the
result (it's stored on **0G Storage**), and run it **locally** as the codec's model. This is
genuine multi-sponsor 0G usage — but the codec still runs the model *itself* (deterministic
reversibility), so we never claim "stego runs on 0G." 0G trains it; we run it.

**Gated on funds:** ledger setup needs **3 OG** (broker v0.6.x); faucet is 0.1/day → get a
testnet top-up at the **0G booth**. Fine-tuning also *takes time* — kick it off early.

## 0. Prereqs
```bash
npm i -g @0glabs/0g-compute-cli        # or npx
python3 make_dataset.py                 # -> casual.jsonl (expand SEEDS first for quality)
export ZG_PRIVATE_KEY=0x<funded-testnet-wallet-key>
0g-compute-cli setup-network            # points at testnet (evmrpc-testnet.0g.ai, 16602)
```

## 1. Fund the ledger + pick a provider
```bash
0g-compute-cli add-ledger --amount 3            # 3 OG minimum
0g-compute-cli fine-tuning list-models          # confirm "Qwen2.5-0.5B-Instruct" is offered
# note a PROVIDER address that offers it
```

## 2. Create the fine-tuning task
```bash
0g-compute-cli fine-tuning create-task \
  --provider <PROVIDER_ADDRESS> \
  --model "Qwen2.5-0.5B-Instruct" \
  --dataset ./casual.jsonl \
  --config-key num_train_epochs --config-value 3
# prints a TASK_ID
```

## 3. Wait, then download + decrypt (48h window after `Delivered`!)
```bash
0g-compute-cli fine-tuning get-task --task <TASK_ID>   # watch: SettingUp→Trained→Delivering→Delivered
0g-compute-cli fine-tuning acknowledge-model \
  --task <TASK_ID> --data-path ./encrypted_model.bin   # downloads from 0G Storage + integrity-checks
# wait for status Finished (provider uploads your decryption key), then:
0g-compute-cli fine-tuning decrypt-model \
  --encrypted-model ./encrypted_model.bin --output ./lora-adapter
```

## 4. Merge the LoRA + deploy to the codec
```bash
# merge adapter into the base, save a plain HF model dir:
python3 merge_lora.py --base Qwen/Qwen2.5-0.5B-Instruct --adapter ./lora-adapter --out ./cover-model
# point the codec at it (same block coder, same HTTP contract):
CODEC_MODEL=./cover-model python3 ../server.py
```

The codec's `model_gpt2.py` loads any HF causal-LM via `CODEC_MODEL`; the block coder is
model-agnostic and already proven reversible, so the fine-tuned model just drops in. Re-run the
startup self-test — if it round-trips, bake `./cover-model` into the fly image and deploy.

## Notes / risks
- Qwen's tokenizer differs from GPT-2 (`model_gpt2.py`'s safe-word/KV-cache path was written
  for GPT-2 BPE). Validate the safe-token build + determinism on Qwen before trusting it — test
  locally on a torch machine, not blind-deploy (a blind model swap bit us once).
- 0.5B is small; the gain over stock Qwen2.5-0.5B-Instruct may be modest. The *base* Qwen
  instruct model alone is already friendlier than gpt2 — consider trying it un-fine-tuned first
  and only fine-tuning if it needs more casual-register nudging.
