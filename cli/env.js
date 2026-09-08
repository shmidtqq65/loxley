'use strict';
/* env: .env in the working directory or next to the package, then process.env, then the defaults.
   the wallet secrets (PRIVATE_KEY, MNEMONIC, LOXLEY_PASSPHRASE) are read here and handed to cli/wallet.js;
   nothing else in the tree looks at them. */
const fs = require('fs');
const path = require('path');

function readDotEnv(file) {
  const out = {};
  try {
    const txt = fs.readFileSync(file, 'utf8');
    txt.split(/\r?\n/).forEach(line => {
      const s = line.trim();
      if (!s || s[0] === '#') return;
      const i = s.indexOf('=');
      if (i < 0) return;
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      const h = v.indexOf(' #');
      if (h > 0) v = v.slice(0, h).trim();
      if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) v = v.slice(1, -1);
      out[k] = v;
    });
  } catch (e) { /* no file, fine */ }
  return out;
}

const DEFAULTS = {
  /* the chain */
  RPC_URL: 'https://rpc.mainnet.chain.robinhood.com',
  EXPLORER_URL: 'https://robinhoodchain.blockscout.com',
  /* the web explorer above is what a person clicks. the rest api the terminal reads is a different host now:
     blockscout put this chain's api behind a free pro key on api.blockscout.com. Point EXPLORER_URL at your own
     blockscout (or at test/mock-chain.js) and the api follows it. */
  EXPLORER_API: 'https://api.blockscout.com/4663',
  EXPLORER_SPACING_MS: '220',
  DEX_URL: 'https://api.dexscreener.com',
  CHAIN_ID: '4663',
  CHAIN_SLUG: 'robinhood',
  /* pons v2 */
  FACTORY: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  LAUNCH_ROUTER: '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948',
  LAUNCH_DEPLOYER: '0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42',
  PONS_HOOK: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
  PONS_ESCROW: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
  /* uniswap v4 on Robinhood Chain */
  UNIVERSAL_ROUTER: '0x8876789976decbfcbbbe364623c63652db8c0904',
  V4_QUOTER: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  V4_STATE_VIEW: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  V4_POOL_MANAGER: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  /* reading */
  PHANTOM_ETH: '1.68',
  WINDOW_BLOCKS: '12000',
  POLL_MS: '500',
  RPC_SPACING_MS: '60',
  RPC_LOGS_SPACING_MS: '400',
  LOGS_CHUNK: '1000',
  BUYERS_WINDOW_BLOCKS: '2000',
  HTTP_TIMEOUT_MS: '9000',
  HTTP_USER_AGENT: '',
  /* the sniper's rules, paper and live alike */
  PAPER_ETH: '0.01',
  MIN_SCORE: '70',
  MAX_OPEN: '3',
  TAX_CEILING_BPS: '300',
  MAX_DEV_SHARE: '8',
  MAX_CREATOR_TAX: '3',
  ETH_PAIRS_ONLY: '1',
  MAX_TWINS: '1',
  MAX_EXEMPT: '0',
  MAX_BUNDLE_PCT: '8',
  REQUIRE_SOCIALS: '0',
  REFUSE_FARMS: '1',
  TAKE_PROFIT_PCT: '80',
  STOP_LOSS_PCT: '35',
  TRAILING_PCT: '25',
  MAX_HOLD_MIN: '45',
  DRAW_MAX_S: '20',
  MARK_EVERY_S: '5',
  /* live trading */
  LIVE_ETH: '0.005',
  LIVE_BUDGET_ETH: '0.02',
  LIVE_MAX_OPEN: '2',
  SLIPPAGE_BPS: '300',
  GAS_MULTIPLIER: '1.2',
  TX_TIMEOUT_MS: '90000',
  MNEMONIC_INDEX: '0',
  /* the links under the header and at the end of every card; empty handles drop the sign-up links */
  REF_AXIOM: 'shmidtqq',
  REF_FOMO: 'shmidtqq',
  /* alerts: a telegram bot and chat, a discord webhook; empty means off */
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: '',
  TELEGRAM_API: 'https://api.telegram.org',
  DISCORD_WEBHOOK: '',
  NO_COLOR: ''
};
/* secrets: never defaulted, never printed, read from .env or the environment only */
const SECRETS = ['PRIVATE_KEY', 'MNEMONIC', 'LOXLEY_PASSPHRASE', 'LOXLEY_HOME', 'EXPLORER_API_KEY'];

function load() {
  const fromCwd = readDotEnv(path.join(process.cwd(), '.env'));
  const fromPkg = readDotEnv(path.join(__dirname, '..', '.env'));
  const env = Object.assign({}, DEFAULTS, fromPkg, fromCwd);
  Object.keys(DEFAULTS).concat(SECRETS).forEach(k => { if (process.env[k] !== undefined && process.env[k] !== '') env[k] = process.env[k]; });
  env.num = k => { const v = parseFloat(env[k]); return isFinite(v) ? v : parseFloat(DEFAULTS[k]); };
  env.bool = k => /^(1|true|yes|on)$/i.test(String(env[k] || ''));
  env.hasSecret = () => !!(env.PRIVATE_KEY || env.MNEMONIC);
  return env;
}

module.exports = { load, DEFAULTS, SECRETS };
