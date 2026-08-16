# Adha

Launch a coin on [pump.fun](https://pump.fun) and decide where its creator fees go: paid out, bought back, burned, or split however you write it.

**[adha.fun](https://adha.fun)**

Adha charges nothing. It holds no keys, takes no cut, and never custodies your funds. Every transaction is built in your browser and signed in your wallet.

---

## How it works

A launch is up to three transactions, each shown in your wallet before it goes out:

1. **Mint** — creates the coin on pump.fun.
2. **Dev buy** — optional, sent separately so a failure cannot cost you the coin.
3. **Fee split** — writes the sharing policy on chain.

Mint addresses ending in `adha` are brute-forced in your browser by a background worker. Those keypairs are generated locally and never sent anywhere. You can skip the search at any point.

## The honest part

pump.fun's fee sharing can only pay **wallet addresses**. It cannot call a program to burn tokens or run a jackpot. So:

| Leg | Enforced by |
|---|---|
| `creator`, `wallet` | on chain, by pump |
| `burn`, `buyback`, `holders`, `top-holders`, `jackpot`, `reserve` | the keeper service |

Action legs route their share to one executor wallet, and a keeper performs the action from there every 15 minutes. That wallet is [`6xjNfNVyaigQYjLC7vNpUP4cbwHQNNdZhZpreemfvjjT`](https://solscan.io/account/6xjNfNVyaigQYjLC7vNpUP4cbwHQNNdZhZpreemfvjjT) and every action it takes is a public transaction.

If you only trust what a smart contract enforces, use the direct legs.

Other limits, stated plainly:

- **The split cannot be edited after it is written.** pump marks the config non-editable. Nobody can change it afterwards, including us.
- **One executor serves every coin.** Fees arrive unlabelled, so the keeper divides the balance across coins with action legs. That is an approximation, not per-coin accounting.
- **The chain is the source of truth.** This site's database is a convenience and can disagree with it.

Full detail: [adha.fun/docs](https://adha.fun/docs)

## Costs

One launch is roughly **0.034 SOL** with a 0.01 dev buy, or **0.024 SOL** without.

| Item | Cost | Goes to |
|---|---|---|
| Mint | ~0.0155 SOL | pump.fun and Solana |
| Fee-split account rent | ~0.0082 SOL | locked in the account itself |
| Dev buy | your choice | your own coin |
| Network fees | negligible | validators |

The rent is a Solana deposit held inside your coin's own account, not a payment to anyone.

## Running it

```bash
npm install
node server.mjs
```

Serves on `:8080`. Environment:

| Variable | Purpose |
|---|---|
| `PORT` | listen port |
| `DB_PATH` | SQLite location (default `data/hooklaunch.db`) |
| `KEEPER_SECRET` | executor keypair as a JSON byte array; without it the keeper runs dry-run only |
| `ADMIN_TOKEN` | gates live keeper execution; unset means dry-run |

Secrets are never committed. `.env`, `data/keeper.json` and the database are gitignored.

## Layout

```
server.mjs          HTTP server, launch registry, keeper scheduler
keeper.mjs          divides executor balance across coins, per leg
executor.mjs        signs and sends the keeper's transactions
public/
  launch-flow.js    mint, dev buy, fee-split; all wallet interaction
  mint-grinder.js   vanity address worker
  hooks-custom.js   compiles a sentence into split legs
  hooks.json        the preset adhas
```

## Verify it

- **Keeper wallet** — [solscan](https://solscan.io/account/6xjNfNVyaigQYjLC7vNpUP4cbwHQNNdZhZpreemfvjjT)
- **pump's fee program** — `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`
- **The no-keys claim** — read `public/launch-flow.js`; the server has no endpoint that signs for you.

## Licence

MIT. See [LICENSE](LICENSE).
