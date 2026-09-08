'use strict';
/* trade: the signing side of loxley, on viem. everything that can move money lives in this file.
   reads go through the same rpc gate as the rest of the desk (spacing, back-off, circuit breaker), so a
   sniper session never floods the node. the maths mirrors pons v2's curve to the wei, the pool leg speaks
   Uniswap v4 through the universal router behind the pons hook, and every send is simulated first. */
const fs = require('fs');
const path = require('path');
const { createPublicClient, createWalletClient, custom, defineChain, parseAbi, encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, formatEther, parseEther, decodeFunctionResult, decodeEventLog, maxUint160, maxUint48, maxUint256, getAddress, isAddressEqual } = require('./deps');
const { home } = require('./wallet');

const BPS = 10000n;
const ZERO = '0x0000000000000000000000000000000000000000';
const PHASE = ['on the curve', 'swept, pool not created yet', 'pool created', 'rescued'];

const ABI = {
  factory: parseAbi([
    'function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists) record)',
    'function pairTokenEconomics(address pairToken) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)',
    'function snipeTaxStartBps() view returns (uint256)',
    'function snipeTaxSeconds() view returns (uint256)'
  ]),
  curve: parseAbi([
    'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
    'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
    'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
    'function realQuoteReserve() view returns (uint256)',
    'function sellableTokens() view returns (uint256)',
    'function reservedTokens() view returns (uint256)',
    'function graduationThreshold() view returns (uint256)',
    'function readyToGraduate() view returns (bool)',
    'function graduated() view returns (bool)',
    'function feeBps() view returns (uint256)',
    'function creatorTaxBps() view returns (uint256)',
    'function isNativeQuote() view returns (bool)',
    'function pairToken() view returns (address)',
    'function launchedAt() view returns (uint256)',
    'function currentSnipeTaxBps(address buyer) view returns (uint256)',
    'function snipeTaxExempt(address who) view returns (bool)',
    'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
    'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)'
  ]),
  erc20: parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)'
  ]),
  permit2: parseAbi([
    'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
    'function approve(address token, address spender, uint160 amount, uint48 expiration)'
  ]),
  quoter: parseAbi([
    'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)'
  ]),
  stateView: parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)']),
  router: parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])
};
const POOL_KEY_TYPE = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };
const V4 = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f, COMMAND_V4_SWAP: 0x10 };

/* ---------- curve maths, integer, to the wei (pons v2) ---------- */
const amountOut = (inp, reserveIn, reserveOut) => (inp * reserveOut) / (reserveIn + inp);
const amountIn = (out, reserveIn, reserveOut) => (out * reserveIn) / (reserveOut - out) + 1n;
const ceilDiv = (a, b) => (a + b - 1n) / b;
function quoteBuy(s, spent, openingTaxBps) {
  const fee = spent * s.feeBps / BPS, tax = spent * s.creatorTaxBps / BPS, opening = spent * BigInt(openingTaxBps || 0) / BPS;
  const net = spent - fee - tax - opening;
  if (net <= 0n) return { tokensOut: 0n, fee, tax, opening, net, spent, refund: 0n, capped: false };
  let tokensOut = amountOut(net, s.quoteReserve, s.tokenReserve), refund = 0n, capped = false, gross = spent;
  if (s.sellableTokens != null && tokensOut > s.sellableTokens) {
    tokensOut = s.sellableTokens; capped = true;
    const needNet = amountIn(tokensOut, s.quoteReserve, s.tokenReserve);
    gross = ceilDiv(needNet * BPS, BPS - s.feeBps - s.creatorTaxBps - BigInt(openingTaxBps || 0));
    refund = spent > gross ? spent - gross : 0n;
  }
  const priceWeiPerToken = tokensOut > 0n ? Number(gross) / Number(tokensOut) : null;
  return { tokensOut, fee, tax, opening, net, spent: gross, refund, capped, price: priceWeiPerToken };
}
function quoteSell(s, tokensIn) {
  if (tokensIn <= 0n || tokensIn >= s.tokenReserve + tokensIn) return { quoteOut: 0n, gross: 0n, fee: 0n, tax: 0n };
  const gross = amountOut(tokensIn, s.tokenReserve, s.quoteReserve);
  const fee = gross * s.feeBps / BPS, tax = gross * s.creatorTaxBps / BPS;
  const quoteOut = gross - fee - tax;
  return { quoteOut: quoteOut > 0n ? quoteOut : 0n, gross, fee, tax };
}
const minOutFromRate = (amount, slippageBps) => amount * (BPS - BigInt(slippageBps)) / BPS;
const pctOf = (a, b) => (b > 0n ? Number(a * 10000n / b) / 100 : null);

/* ---------- v4 encoding, the universal router behind the pons hook ---------- */
function sortCurrencies(a, b) { return BigInt(a) < BigInt(b) ? [a, b] : [b, a]; }
function poolKeyFor(token, pairToken, tickSpacing, hooks, fee) {
  const [c0, c1] = sortCurrencies(getAddress(token), getAddress(pairToken || ZERO));
  return { currency0: c0, currency1: c1, fee: fee == null ? 0 : Number(fee), tickSpacing: tickSpacing == null ? 200 : Number(tickSpacing), hooks: getAddress(hooks) };
}
const poolIdOf = k => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
function encodeV4Swap(key, zeroForOne, amountIn_, amountOutMin, layout) {
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [V4.SWAP_EXACT_IN_SINGLE, V4.SETTLE_ALL, V4.TAKE_ALL]);
  const cIn = zeroForOne ? key.currency0 : key.currency1, cOut = zeroForOne ? key.currency1 : key.currency0;
  const swap = layout === 'legacy'
    ? encodeAbiParameters([{ type: 'tuple', components: [{ name: 'poolKey', ...POOL_KEY_TYPE }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }], [{ poolKey: key, zeroForOne, amountIn: amountIn_, amountOutMinimum: amountOutMin, hookData: '0x' }])
    : encodeAbiParameters([{ type: 'tuple', components: [{ name: 'poolKey', ...POOL_KEY_TYPE }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }], [{ poolKey: key, zeroForOne, amountIn: amountIn_, amountOutMinimum: amountOutMin, minHopPriceX36: 0n, hookData: '0x' }]);
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cIn, amountIn_]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cOut, amountOutMin]);
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swap, settle, take]]);
  return { commands: encodePacked(['uint8'], [V4.COMMAND_V4_SWAP]), inputs: [input], value: cIn === ZERO ? amountIn_ : 0n, cIn, cOut };
}

/* ---------- the positions book, ~/.loxley/positions.json ---------- */
function makeBook(env) {
  const file = path.join(home(env), 'positions.json');
  const read = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.positions) return j; } catch (e) { /* none */ } return { loxley: 1, kind: 'positions', positions: [] }; };
  const write = j => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(j, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1)); };
  return {
    file, read, write,
    open(p) { const j = read(); p.id = 'p' + (j.positions.length + 1); p.status = 'open'; p.openedAt = new Date().toISOString(); j.positions.push(p); write(j); return p; },
    update(id, patch) { const j = read(); const p = j.positions.find(x => x.id === id); if (!p) return null; Object.assign(p, patch); write(j); return p; },
    open_() { return read().positions.filter(p => p.status === 'open'); },
    all() { return read().positions; },
    byToken(token) { return read().positions.filter(p => p.token.toLowerCase() === token.toLowerCase() && p.status === 'open'); }
  };
}

/* ---------- the trader ---------- */
function makeTrader(ctx, wallet) {
  const { env, chain, log } = ctx;
  const A = {
    factory: getAddress(env.FACTORY), router: getAddress(env.UNIVERSAL_ROUTER), quoter: getAddress(env.V4_QUOTER), stateView: getAddress(env.V4_STATE_VIEW),
    permit2: getAddress(env.PERMIT2), hook: getAddress(env.PONS_HOOK), multicall3: getAddress(env.MULTICALL3)
  };
  const rh = defineChain({ id: parseInt(env.CHAIN_ID, 10), name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [env.RPC_URL] } }, blockExplorers: { default: { name: 'Blockscout', url: env.EXPLORER_URL } }, contracts: { multicall3: { address: A.multicall3 } } });
  const transport = custom({ request: ({ method, params }) => chain.call(method, params, 1) });
  const pub = createPublicClient({ chain: rh, transport });
  const account = wallet && wallet.account;
  const wc = account ? createWalletClient({ account, chain: rh, transport }) : null;
  const book = makeBook(env);
  const slippage = () => BigInt(Math.round(env.num('SLIPPAGE_BPS')));
  const stateFile = path.join(home(env), 'state.json');
  const st = (() => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return {}; } })();
  const saveState = () => { try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(st, null, 1)); } catch (e) { /* fine */ } };
  const read = (address, abi, functionName, args) => pub.readContract({ address, abi, functionName, args: args || [] });

  async function record(token) {
    const r = await read(A.factory, ABI.factory, 'getLaunchedToken', [getAddress(token)]);
    if (!r || !r.exists) return null;
    return Object.assign({}, r, { token: getAddress(token), phaseText: PHASE[Number(r.phase)] || ('phase ' + r.phase), pairIsEth: r.pairToken === ZERO || isAddressEqual(r.pairToken, ZERO) });
  }
  /* the curve in one breath: reserves, fees, flags, and the opening tax for the wallet that would buy.
     one multicall3 request instead of 13 rpc round-trips. falls back to one call each when the
     multicall contract is not on the chain. */
  async function curveState(curve, who) {
    const c = getAddress(curve);
    const whoAddr = who ? getAddress(who) : '0x0000000000000000000000000000000000000001';
    const pad32 = a => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const calls = [
      { to: c, data: encodeFunctionData({ abi: ABI.curve, functionName: 'getReserves', args: [] }) },
      { to: c, data: encodeFunctionData({ abi: ABI.curve, functionName: 'realQuoteReserve', args: [] }) },
      { to: c, data: encodeFunctionData({ abi: ABI.curve, functionName: 'sellableTokens', args: [] }) },
      { to: c, data: encodeFunctionData({ abi: ABI.curve, functionName: 'reservedTokens', args: [] }) },
      { to: c, data: encodeFunctionData({ abi: ABI.curve, functionName: 'graduationThreshold', args: [] }) },
      { to: c, data: encodeFunctionData({ abi: ABI.curve, functionName: 'readyToGraduate', args: [] }) },
      { to: c, data: encodeFunctionData({ abi: ABI.curve, functionName: 'graduated', args: [] }) },
      { to: c, data: encodeFunctionData({ abi: ABI.curve, functionName: 'feeBps', args: [] }) },
      { to: c, data: encodeFunctionData({ abi: ABI.curve, functionName: 'creatorTaxBps', args: [] }) },
      { to: c, data: encodeFunctionData({ abi: ABI.curve, functionName: 'isNativeQuote', args: [] }) },
      { to: c, data: encodeFunctionData({ abi: ABI.curve, functionName: 'pairToken', args: [] }) },
      { to: c, data: encodeFunctionData({ abi: ABI.curve, functionName: 'launchedAt', args: [] }) },
      { to: c, data: encodeFunctionData({ abi: ABI.curve, functionName: 'currentSnipeTaxBps', args: [whoAddr] }) },
    ];
    const r = await chain.multicall(calls);
    const d = (fn, i) => { try { return decodeFunctionResult({ abi: ABI.curve, functionName: fn, data: r[i] }); } catch (e) { return null; } };
    const res = d('getReserves', 0), real = d('realQuoteReserve', 1), sellable = d('sellableTokens', 2), reserved = d('reservedTokens', 3);
    const thr = d('graduationThreshold', 4), ready = d('readyToGraduate', 5), grad = d('graduated', 6), fee = d('feeBps', 7), ctax = d('creatorTaxBps', 8);
    const native = d('isNativeQuote', 9), pair = d('pairToken', 10), launchedAt = d('launchedAt', 11), snipe = d('currentSnipeTaxBps', 12);
    return { curve: c, quoteReserve: res ? res[0] : null, tokenReserve: res ? res[1] : null, real: real || 0n, phantom: res && real ? res[0] - real : null, sellableTokens: sellable, reservedTokens: reserved || 0n, threshold: thr, ready: !!ready, graduated: !!grad, feeBps: fee, creatorTaxBps: ctax, isNativeQuote: native == null ? true : !!native, pairToken: pair || ZERO, launchedAt: launchedAt ? Number(launchedAt) * 1000 : 0, openingTaxBps: snipe == null ? null : Number(snipe), fill: thr && thr > 0n ? Number((real || 0n) * 10000n / thr) / 10000 : null, price: res && res[1] > 0n ? Number(res[0]) / Number(res[1]) : null };
  }
  const balance = who => pub.getBalance({ address: getAddress(who || account.address) });
  const tokenBalance = (token, who) => read(getAddress(token), ABI.erc20, 'balanceOf', [getAddress(who || account.address)]);
  const tokenMeta = async token => { const [sym, dec] = await Promise.all([read(getAddress(token), ABI.erc20, 'symbol').catch(() => null), read(getAddress(token), ABI.erc20, 'decimals').catch(() => 18)]); return { symbol: sym, decimals: Number(dec) }; };

  /* ---------- sending: simulate, sign, send, wait ---------- */
  function needWallet() { if (!wc) { const e = new Error('no wallet: loxley wallet import, or PRIVATE_KEY / MNEMONIC in .env'); e.code = 'NOWALLET'; throw e; } }
  async function send(req, label) {
    needWallet();
    const t0 = Date.now();
    const sim = await pub.simulateContract(Object.assign({ account }, req));
    const gas = sim.request.gas ? BigInt(Math.ceil(Number(sim.request.gas) * env.num('GAS_MULTIPLIER'))) : undefined;
    const hash = await wc.writeContract(Object.assign({}, sim.request, gas ? { gas } : {}));
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: env.num('TX_TIMEOUT_MS'), pollingInterval: Math.max(250, env.num('POLL_MS')) });
    if (rc.status !== 'success') { const e = new Error((label || 'transaction') + ' reverted on chain: ' + hash); e.hash = hash; e.receipt = rc; throw e; }
    const gasWei = rc.gasUsed * (rc.effectiveGasPrice || 0n);
    return { hash, receipt: rc, result: sim.result, gasWei, ms: Date.now() - t0 };
  }
  async function ensureAllowance(token, spender, amount) {
    const have = await read(getAddress(token), ABI.erc20, 'allowance', [account.address, getAddress(spender)]);
    if (have >= amount) return null;
    const r = await send({ address: getAddress(token), abi: ABI.erc20, functionName: 'approve', args: [getAddress(spender), maxUint256] }, 'approve');
    return r.hash;
  }
  async function ensurePermit2(token) {
    const approvals = [];
    const a1 = await ensureAllowance(token, A.permit2, maxUint256 / 2n); if (a1) approvals.push(a1);
    const [amt, exp] = await read(A.permit2, ABI.permit2, 'allowance', [account.address, getAddress(token), A.router]);
    const soon = BigInt(Math.floor(Date.now() / 1000) + 600);
    if (amt < maxUint160 / 2n || BigInt(exp) < soon) { const r = await send({ address: A.permit2, abi: ABI.permit2, functionName: 'approve', args: [getAddress(token), A.router, maxUint160, Number(maxUint48)] }, 'permit2 approve'); approvals.push(r.hash); }
    return approvals;
  }
  const logsOf = (rc, abi, eventName, address) => rc.logs.filter(l => !address || isAddressEqual(l.address, address)).map(l => { try { const d = decodeEventLog({ abi, data: l.data, topics: l.topics }); return d.eventName === eventName ? d.args : null; } catch (e) { return null; } }).filter(Boolean);

  /* ---------- the curve leg ---------- */
  async function buyCurve(o) {
    needWallet();
    const rec = o.record || await record(o.token); if (!rec) throw new Error('not a pons v2 launch: the factory has no record of ' + o.token);
    if (Number(rec.phase) !== 0) throw new Error('the curve is closed (' + rec.phaseText + '); the pool leg is where this trades now');
    const s = o.state || await curveState(rec.curve, account.address);
    if (s.graduated || s.ready) throw new Error('the curve is ' + (s.graduated ? 'graduated' : 'ready to graduate') + ': no curve buys, wait for the pool');
    if (!s.isNativeQuote) throw new Error('this launch is paired with ' + s.pairToken + ', not ETH. loxley buys ETH-paired curves only');
    const tax = s.openingTaxBps == null ? 0 : s.openingTaxBps;
    if (o.maxTaxBps != null && tax > o.maxTaxBps) { const e = new Error('opening tax is ' + (tax / 100).toFixed(2) + '%, above the ceiling of ' + (o.maxTaxBps / 100).toFixed(2) + '%'); e.code = 'TAX'; throw e; }
    const q = quoteBuy(s, o.ethWei, tax);
    if (q.tokensOut <= 0n) throw new Error('that amount buys nothing after fees and tax');
    const minOut = minOutFromRate(q.tokensOut, o.slippageBps == null ? slippage() : BigInt(o.slippageBps));
    const spend = q.spent;
    if (o.dry) return { dry: true, quote: q, minOut, spend, state: s, record: rec };
    const r = await send({ address: rec.curve, abi: ABI.curve, functionName: 'buy', args: [spend, minOut, account.address], value: spend }, 'curve buy');
    const ev = logsOf(r.receipt, ABI.curve, 'CurveBuy', rec.curve).find(a => isAddressEqual(a.buyer, account.address)) || null;
    const tokensOut = ev ? ev.tokensOut : (r.result || q.tokensOut);
    return { hash: r.hash, tokensOut, quoteIn: ev ? ev.quoteIn : spend, fee: ev ? ev.fee : q.fee, tax: ev ? ev.tax : q.tax, gasWei: r.gasWei, ms: r.ms, quote: q, minOut, state: s, record: rec, venue: 'curve', block: Number(r.receipt.blockNumber) };
  }
  async function sellCurve(o) {
    needWallet();
    const rec = o.record || await record(o.token); if (!rec) throw new Error('not a pons v2 launch');
    const s = o.state || await curveState(rec.curve, account.address);
    if (Number(rec.phase) !== 0 || s.graduated || s.ready) { const e = new Error(s.ready && !s.graduated ? 'the curve is ready to graduate: sells are closed until the pool exists' : 'the curve is closed (' + rec.phaseText + ')'); e.code = 'HALTED'; throw e; }
    const q = quoteSell(s, o.tokensWei);
    if (q.quoteOut <= 0n) throw new Error('those tokens fetch nothing on the curve right now');
    const minOut = minOutFromRate(q.quoteOut, o.slippageBps == null ? slippage() : BigInt(o.slippageBps));
    if (o.dry) return { dry: true, quote: q, minOut, state: s, record: rec, venue: 'curve' };
    const approvals = []; const a = await ensureAllowance(rec.token, rec.curve, o.tokensWei); if (a) approvals.push(a);
    const r = await send({ address: rec.curve, abi: ABI.curve, functionName: 'sell', args: [o.tokensWei, minOut, account.address] }, 'curve sell');
    const ev = logsOf(r.receipt, ABI.curve, 'CurveSell', rec.curve).find(x => isAddressEqual(x.seller, account.address)) || null;
    return { hash: r.hash, quoteOut: ev ? ev.quoteOut : (r.result || q.quoteOut), tokensIn: o.tokensWei, fee: ev ? ev.fee : q.fee, tax: ev ? ev.tax : q.tax, gasWei: r.gasWei, ms: r.ms, approvals, quote: q, minOut, venue: 'curve', block: Number(r.receipt.blockNumber) };
  }

  /* ---------- the pool leg ---------- */
  async function poolKey(rec) {
    const cached = st.poolKeys && st.poolKeys[rec.token.toLowerCase()];
    if (cached) return cached;
    const fees = [0, Number(rec.poolFee), 0x800000].filter((f, i, a) => a.indexOf(f) === i);
    for (const fee of fees) {
      const k = poolKeyFor(rec.token, rec.pairToken, rec.tickSpacing, A.hook, fee);
      try { const slot = await read(A.stateView, ABI.stateView, 'getSlot0', [poolIdOf(k)]); if (slot && slot[0] > 0n) { st.poolKeys = st.poolKeys || {}; st.poolKeys[rec.token.toLowerCase()] = k; saveState(); return k; } } catch (e) { /* next */ }
    }
    throw new Error('no initialised v4 pool found for ' + rec.token + ' behind the pons hook');
  }
  async function quotePool(rec, key, sellingToken, amount) {
    const tokenIs0 = isAddressEqual(key.currency0, rec.token);
    const zeroForOne = sellingToken ? tokenIs0 : !tokenIs0;
    const r = await pub.simulateContract({ address: A.quoter, abi: ABI.quoter, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne, exactAmount: amount, hookData: '0x' }], account: account ? account.address : undefined });
    return { amountOut: r.result[0], zeroForOne };
  }
  async function swapPool(o) {
    needWallet();
    const rec = o.record || await record(o.token); if (!rec) throw new Error('not a pons v2 launch');
    if (Number(rec.phase) === 1 || Number(rec.phase) === 3) { const e = new Error('trading is halted: ' + rec.phaseText); e.code = 'HALTED'; throw e; }
    if (Number(rec.phase) !== 2) throw new Error('no pool yet (' + rec.phaseText + ')');
    if (!rec.pairIsEth) throw new Error('this pool is paired with ' + rec.pairToken + ', not ETH. loxley trades ETH pools only');
    const key = await poolKey(rec);
    const q = await quotePool(rec, key, o.sell, o.amount);
    const minOut = minOutFromRate(q.amountOut, o.slippageBps == null ? slippage() : BigInt(o.slippageBps));
    if (o.dry) return { dry: true, amountOut: q.amountOut, minOut, key, record: rec, venue: 'pool' };
    const approvals = o.sell ? await ensurePermit2(rec.token) : [];
    const layouts = st.routerLayout ? [st.routerLayout, st.routerLayout === 'current' ? 'legacy' : 'current'] : ['current', 'legacy'];
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
    let lastErr = null;
    for (const layout of layouts) {
      const enc = encodeV4Swap(key, q.zeroForOne, o.amount, minOut, layout);
      const req = { address: A.router, abi: ABI.router, functionName: 'execute', args: [enc.commands, enc.inputs, deadline], value: enc.value };
      try { await pub.simulateContract(Object.assign({ account }, req)); } catch (e) { lastErr = e; continue; }
      st.routerLayout = layout; saveState();
      const before = o.sell ? await balance() : null;
      const r = await send(req, 'pool ' + (o.sell ? 'sell' : 'buy'));
      let out = null;
      if (o.sell) { const after = await balance(); out = after - before + r.gasWei; }
      else { const tr = r.receipt.logs.filter(l => isAddressEqual(l.address, rec.token) && l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && l.topics[2] && isAddressEqual('0x' + l.topics[2].slice(26), account.address)); out = tr.reduce((s, l) => s + BigInt(l.data), 0n); if (out === 0n) out = q.amountOut; }
      return { hash: r.hash, amountOut: out, quoted: q.amountOut, minOut, gasWei: r.gasWei, ms: r.ms, approvals, layout, venue: 'pool', block: Number(r.receipt.blockNumber) };
    }
    throw new Error('the router refused both parameter layouts: ' + short(lastErr));
  }

  /* ---------- either venue, by phase ---------- */
  async function exitQuote(token, tokensWei, who) {
    const rec = await record(token); if (!rec) return null;
    const ph = Number(rec.phase);
    if (ph === 0) { const s = await curveState(rec.curve, who || (account && account.address)); if (s.graduated || s.ready) return { venue: 'halted', ethOut: null, record: rec, state: s, note: 'ready to graduate, sells closed until the pool' }; const q = quoteSell(s, tokensWei); return { venue: 'curve', ethOut: q.quoteOut, record: rec, state: s, quote: q }; }
    if (ph === 2) { try { const key = await poolKey(rec); const q = await quotePool(rec, key, true, tokensWei); return { venue: 'pool', ethOut: q.amountOut, record: rec, key }; } catch (e) { return { venue: 'pool', ethOut: null, record: rec, note: short(e) }; } }
    return { venue: 'halted', ethOut: null, record: rec, note: rec.phaseText };
  }
  async function sellAnywhere(o) {
    const rec = o.record || await record(o.token); if (!rec) throw new Error('not a pons v2 launch');
    const ph = Number(rec.phase);
    if (ph === 0) { try { return await sellCurve(Object.assign({}, o, { record: rec })); } catch (e) { if (e.code === 'HALTED') throw e; throw e; } }
    if (ph === 2) return swapPool(Object.assign({}, o, { record: rec, sell: true, amount: o.tokensWei }));
    const e = new Error('trading is halted: ' + rec.phaseText + '. the curve is swept, the pool is not there yet'); e.code = 'HALTED'; throw e;
  }
  async function buyAnywhere(o) {
    const rec = o.record || await record(o.token); if (!rec) throw new Error('not a pons v2 launch');
    const ph = Number(rec.phase);
    if (ph === 0) return buyCurve(Object.assign({}, o, { record: rec }));
    if (ph === 2) return swapPool(Object.assign({}, o, { record: rec, sell: false, amount: o.ethWei }));
    const e = new Error('trading is halted: ' + rec.phaseText); e.code = 'HALTED'; throw e;
  }

  return { pub, wc, account, address: account ? account.address : null, book, A, ABI, record, curveState, balance, tokenBalance, tokenMeta, buyCurve, sellCurve, swapPool, buyAnywhere, sellAnywhere, exitQuote, poolKey, quotePool, ensureAllowance, ensurePermit2, quoteBuy, quoteSell, minOutFromRate, PHASE, state: st };
}

/* an error, in one line, without viem's essay */
function short(e) {
  if (!e) return 'unknown error';
  const m = (e.shortMessage || e.message || String(e)).split('\n')[0];
  const reason = (e.message || '').match(/reason:\s*(.+)/i) || (e.message || '').match(/reverted with the following reason:\s*(.+)/i);
  return reason ? m + ' (' + reason[1].trim().split('\n')[0] + ')' : m;
}
const fmtEth = (wei, d) => wei == null ? 'n/a' : Number(formatEther(BigInt(wei))).toFixed(d == null ? 5 : d) + ' ETH';
const fmtTok = (wei, dec) => { if (wei == null) return 'n/a'; const v = Number(wei) / Math.pow(10, dec == null ? 18 : dec); return v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : v.toFixed(v < 1 ? 4 : 2); };
const toWei = x => parseEther(String(x));

module.exports = { makeTrader, makeBook, quoteBuy, quoteSell, minOutFromRate, amountOut, amountIn, poolKeyFor, poolIdOf, encodeV4Swap, ABI, PHASE, BPS, ZERO, short, fmtEth, fmtTok, toWei, pctOf };
