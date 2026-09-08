'use strict';
/* chain: json-rpc through one gate, abi helpers, the pons v2 factory and its curves.
   every call in this file is a read. the signing side lives in trade.js and shares this gate. */

const T = {
  LAUNCH: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607', /* TokenLaunched(address,address,address,address,uint256,uint256) */
  GRAD: '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259',   /* PoolGraduated(address,uint256,uint256,uint256): token, positionId, tokenAmount, pairTokenAmount */
  GRAD_ALT: '0xd85d014567e903c654d1018dbc03f19e3aa57fcb38adb266462ed085b2f37d12', /* PoolGraduated(address,bytes32), the docs' older shape, still listened for */
  SWEPT: '0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4',  /* LaunchSwept(address,uint256,uint256): the curve is closed, the pool is not there yet */
  BUY: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',    /* CurveBuy(address,address,uint256,uint256,uint256,uint256) */
  SELL: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',   /* CurveSell(address,address,uint256,uint256,uint256,uint256) */
  TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
};
const GRADS = [T.GRAD, T.GRAD_ALT];
const SEL = {
  realQuoteReserve: '0x4f1f58fd', tokenReserve: '0xcbcb3171', getReserves: '0x0902f1ac', graduated: '0xe7c2b772', readyToGraduate: '0xc68360a5',
  graduationThreshold: '0x8b0bc501', currentSnipeTaxBps: '0xd7e1ef39', feeBps: '0x24a9d853', creatorTaxBps: '0xc1bb8901',
  phase: '0xb1c9fe6e', pairToken: '0x3de35b79', isNativeQuote: '0xdc08e094', sellableTokens: '0x808bcddc', launchedAt: '0xbf56b371',
  getLaunchedToken: '0x3cf28b5a', pairTokenEconomics: '0x31082134',
  name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567', totalSupply: '0x18160ddd', balanceOf: '0x70a08231'
};
const ZERO = '0x0000000000000000000000000000000000000000';

/* ---------- abi ---------- */
const hex = n => '0x' + Number(n).toString(16);
const pad32 = a => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const word = (data, i) => String(data || '').replace(/^0x/, '').slice(i * 64, (i + 1) * 64);
const isHex = s => typeof s === 'string' && /^0x[0-9a-fA-F]*$/.test(s) && s.length > 2;
function decUint(h) { if (!isHex(h)) return null; try { return Number(BigInt(h)); } catch (e) { return null; } }
function decBig(h) { if (!isHex(h)) return null; try { return BigInt(h); } catch (e) { return null; } }
function decBool(h) { const v = decUint(h); return v == null ? null : v !== 0; }
function decAddr(h) { return isHex(h) && h.length >= 42 ? ('0x' + h.slice(-40)).toLowerCase() : null; }
function decString(h) {
  if (!isHex(h)) return null;
  try {
    const s = h.slice(2);
    if (s.length === 64) { /* bytes32 style */
      const raw = Buffer.from(s, 'hex').toString('utf8').replace(/\0+$/, '');
      return raw || null;
    }
    const off = parseInt(s.slice(0, 64), 16) * 2;
    const len = parseInt(s.slice(off, off + 64), 16) * 2;
    const out = Buffer.from(s.slice(off + 64, off + 64 + len), 'hex').toString('utf8').replace(/\0/g, '');
    return out || null;
  } catch (e) { return null; }
}
const fromWei = (big, dec) => big == null ? null : Number(big) / Math.pow(10, dec == null ? 18 : dec);

/* ---------- the gate: one request at a time, spaced, 429 backs off ---------- */
function makeRpc(env, stats) {
  const url = env.RPC_URL, spacing = env.num('RPC_SPACING_MS'), logsSpacing = env.num('RPC_LOGS_SPACING_MS'), timeout = env.num('HTTP_TIMEOUT_MS');
  let chain = Promise.resolve(), lastAt = 0, lastLogsAt = 0, id = 0, downUntil = 0, timeouts = 0;
  stats = stats || { calls: 0, rejected: 0, ms: 0, timeouts: 0 };
  async function once(method, params) {
    if (Date.now() < downUntil) { const e = new Error('rpc unreachable, retrying in ' + Math.ceil((downUntil - Date.now()) / 1000) + ' s'); e.code = 'DOWN'; throw e; }
    const isLogs = method === 'eth_getLogs';
    const gap = Math.max(spacing - (Date.now() - lastAt), isLogs ? logsSpacing - (Date.now() - lastLogsAt) : 0);
    if (gap > 0) await sleep(gap);
    const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), timeout);
    const t0 = Date.now();
    try {
      stats.calls++;
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params || [] }), signal: ctrl.signal });
      lastAt = Date.now(); if (isLogs) lastLogsAt = lastAt; stats.ms += Date.now() - t0;
      if (r.status === 429) { stats.rejected++; const e = new Error('rpc 429'); e.code = 429; throw e; }
      if (!r.ok) throw new Error('rpc http ' + r.status);
      const j = await r.json();
      if (j.error) { const e = new Error(j.error.message || 'rpc error'); e.code = j.error.code; e.data = j.error.data; e.rpc = true; throw e; }
      timeouts = 0;
      return j.result;
    } catch (e) {
      /* two timeouts in a row and the gate opens for twenty seconds: nothing waits nine seconds per call on a dead node */
      if (e.name === 'AbortError' || /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(String(e.message))) { stats.timeouts++; if (++timeouts >= 2) downUntil = Date.now() + 20000; const err = new Error('rpc did not answer (' + (e.name === 'AbortError' ? 'timeout' : e.message) + ')'); err.code = 'TIMEOUT'; throw err; }
      throw e;
    } finally { clearTimeout(tm); }
  }
  function call(method, params, tries) {
    tries = tries == null ? 2 : tries;
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await once(method, params); }
        catch (e) {
          if (e.code === 'DOWN' || attempt >= tries) throw e;
          if (e.code === 429) await sleep(2000); else if (e.code === 'TIMEOUT') await sleep(300); else throw e;
        }
      }
    };
    const p = chain.then(run);
    chain = p.catch(() => { });
    return p;
  }
  return { call, stats, url };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- reads ---------- */
function makeChain(env, log) {
  const rpc = makeRpc(env);
  const factory = env.FACTORY.toLowerCase();
  const call = rpc.call;
  const ethCall = (to, data) => call('eth_call', [{ to, data }, 'latest']).then(r => (r && r !== '0x' ? r : null)).catch(() => null);
  const blockNumber = () => call('eth_blockNumber').then(decUint);
  const chainId = () => call('eth_chainId').then(decUint);
  const getBlock = n => call('eth_getBlockByNumber', [typeof n === 'number' ? hex(n) : n, false]).then(b => b ? { number: decUint(b.number), timestamp: decUint(b.timestamp) * 1000, txs: (b.transactions || []).length } : null);
  const getCode = a => call('eth_getCode', [a, 'latest']).catch(() => null);
  const receipt = h => call('eth_getTransactionReceipt', [h]).catch(() => null);
  const tx = h => call('eth_getTransactionByHash', [h]).catch(() => null);

  /* opts.wide: a topic-filtered query that expects few answers (one deployer's launches, one wallet's buys, one
     recipient's credits) goes to the node in one piece first; only a node that refuses the range gets it in halves,
     down to LOGS_CHUNK. the feed's own reads stay chunked: they expect every log in the range. */
  async function getLogs(address, topics, from, to, opts) {
    const wide = !!(opts && opts.wide);
    const chunk = wide ? Math.max(to - from + 1, 1) : Math.max(200, env.num('LOGS_CHUNK'));
    const out = [];
    let a = from;
    while (a <= to) {
      const b = Math.min(to, a + chunk - 1);
      let res;
      try { res = await call('eth_getLogs', [{ address, topics, fromBlock: hex(a), toBlock: hex(b) }]); }
      catch (e) {
        if (/range|limit|too many|too large|too big|more than|exceed/i.test(String(e.message)) && b - a > 200) { /* the node wants smaller ranges */
          const mid = Math.floor((a + b) / 2);
          const l = await getLogs(address, topics, a, mid, opts); const r = await getLogs(address, topics, mid + 1, b, opts);
          out.push(...l, ...r); a = b + 1; continue;
        }
        throw e;
      }
      if (Array.isArray(res)) out.push(...res);
      a = b + 1;
    }
    return out;
  }

  function parseFactoryLog(lg) {
    const t0 = String((lg.topics || [])[0] || '').toLowerCase();
    const bn = decUint(lg.blockNumber);
    const idx = decUint(lg.logIndex) || 0;
    const base = { bn, idx, tx: lg.transactionHash, removed: !!lg.removed };
    if (t0 === T.LAUNCH) {
      const d = lg.data || '0x';
      return Object.assign(base, { kind: 'launch', token: decAddr(lg.topics[1]), curve: decAddr(lg.topics[2]), deployer: decAddr(lg.topics[3]), pair: ('0x' + word(d, 0).slice(24)).toLowerCase(), cfg: parseInt(word(d, 1), 16) || 0, thr: fromWei(decBig('0x' + word(d, 2))) || 0 });
    }
    if (t0 === T.GRAD) { const d = lg.data || '0x'; return Object.assign(base, { kind: 'grad', token: decAddr(lg.topics[1]), positionId: decUint('0x' + word(d, 0)), tokenAmount: fromWei(decBig('0x' + word(d, 1))), pairAmount: fromWei(decBig('0x' + word(d, 2))) }); }
    if (t0 === T.GRAD_ALT) return Object.assign(base, { kind: 'grad', token: decAddr(lg.topics[1]), poolId: lg.data });
    if (t0 === T.SWEPT) { const d = lg.data || '0x'; return Object.assign(base, { kind: 'swept', token: decAddr(lg.topics[1]), quoteOut: fromWei(decBig('0x' + word(d, 0))), tokenOut: fromWei(decBig('0x' + word(d, 1))) }); }
    if (t0 === T.BUY || t0 === T.SELL) {
      const d = lg.data || '0x', buy = t0 === T.BUY;
      /* CurveBuy(buyer, recipient, quoteIn, tokensOut, fee, tax) · CurveSell(seller, recipient, tokensIn, quoteOut, fee, tax) */
      return Object.assign(base, { kind: buy ? 'buy' : 'sell', who: decAddr(lg.topics[1]), recipient: decAddr(lg.topics[2]),
        quote: fromWei(decBig('0x' + word(d, buy ? 0 : 1))), tokens: fromWei(decBig('0x' + word(d, buy ? 1 : 0))),
        fee: fromWei(decBig('0x' + word(d, 2))), tax: fromWei(decBig('0x' + word(d, 3))), curve: (lg.address || '').toLowerCase() });
    }
    return null;
  }

  /* multicall3 aggregate3: many views in one request. falls back to one call each when the contract is not there */
  const MC = { addr: (env.MULTICALL3 || '').toLowerCase(), ok: null };
  const deps = require('./deps');
  const MC_ABI = deps.parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
  async function multicall(calls) {
    if (MC.ok === null) { const code = MC.addr ? await getCode(MC.addr) : null; MC.ok = !!(code && code !== '0x'); }
    if (MC.ok) {
      try {
        const data = deps.encodeFunctionData({ abi: MC_ABI, functionName: 'aggregate3', args: [calls.map(c => ({ target: deps.getAddress(c.to), allowFailure: true, callData: c.data }))] });
        const r = await call('eth_call', [{ to: MC.addr, data }, 'latest']);
        const out = deps.decodeFunctionResult({ abi: MC_ABI, functionName: 'aggregate3', data: r });
        return out.map(x => (x.success && x.returnData && x.returnData !== '0x' ? x.returnData : null));
      } catch (e) { MC.ok = false; }
    }
    return Promise.all(calls.map(c => ethCall(c.to, c.data)));
  }
  /* one launch in one request: the curve, the token, its metadata, the factory record */
  async function readLaunch(e, who) {
    const c = e.curve, t = e.token, whoPad = pad32(who || ZERO.slice(0, -1) + '1');
    const calls = [
      [c, SEL.getReserves], [c, SEL.realQuoteReserve], [c, SEL.graduated], [c, SEL.readyToGraduate], [c, SEL.feeBps], [c, SEL.creatorTaxBps], [c, SEL.phase], [c, SEL.currentSnipeTaxBps + whoPad], [c, SEL.sellableTokens],
      [t, SEL.symbol], [t, SEL.name], [t, SEL.decimals], [t, SEL.totalSupply], [t, '0xabb1dc44'],
      [factory, SEL.getLaunchedToken + pad32(t)]
    ].map(x => ({ to: x[0], data: x[1] }));
    const r = await multicall(calls);
    const g = i => r[i];
    const out = { curve: { curve: c }, token: {}, info: null, record: null };
    const cv = out.curve, rs = g(0);
    cv.real = g(1) == null ? null : fromWei(decBig(g(1)));
    if (rs && rs.length >= 130) { cv.quoteReserve = fromWei(decBig('0x' + word(rs, 0))); cv.tokenReserve = fromWei(decBig('0x' + word(rs, 1))); cv.phantom = cv.real != null ? cv.quoteReserve - cv.real : null; }
    cv.graduated = g(2) == null ? null : decBool(g(2)); cv.ready = g(3) == null ? null : decBool(g(3)); cv.feeBps = g(4) == null ? null : decUint(g(4)); cv.creatorTaxBps = g(5) == null ? null : decUint(g(5)); cv.phase = g(6) == null ? null : decUint(g(6)); cv.taxBps = g(7) == null ? null : decUint(g(7)); cv.sellable = g(8) == null ? null : fromWei(decBig(g(8)));
    const dec = g(11) == null ? 18 : (decUint(g(11)) == null ? 18 : decUint(g(11)));
    out.token = { symbol: g(9) ? decString(g(9)) : null, name: g(10) ? decString(g(10)) : null, decimals: dec, supply: g(12) == null ? null : fromWei(decBig(g(12)), dec) };
    if (g(13)) { try { const d = deps.decodeFunctionResult({ abi: deps.parseAbi(['function getTokenInfo() view returns (address, string, string, (string,string,string,string,string))']), functionName: 'getTokenInfo', data: g(13) }); const sc = d[3] || []; const clean = v => { v = String(v || '').trim(); return v.length ? v : null; }; const socials = { twitter: clean(sc[0]), telegram: clean(sc[1]), discord: clean(sc[2]), website: clean(sc[3]), farcaster: clean(sc[4]) }; const count = Object.values(socials).filter(Boolean).length; out.info = { deployer: String(d[0]).toLowerCase(), logo: clean(d[1]), description: clean(d[2]), socials, count, has: count > 0 }; } catch (err) { out.info = null; } }
    const rec = g(14);
    if (rec && rec.length >= 2 + 64 * 15 && decBool('0x' + word(rec, 14))) out.record = { feeRecipient: decAddr('0x' + word(rec, 3)), pair: decAddr('0x' + word(rec, 4)), creatorTaxBps: decUint('0x' + word(rec, 8)), phase: decUint('0x' + word(rec, 10)), tickSpacing: decUint('0x' + word(rec, 7)), poolFee: decUint('0x' + word(rec, 6)) };
    return out;
  }

  /* the curve, one view at a time, each one optional */
  async function curveRead(curve, opts) {
    opts = opts || {};
    const out = { curve };
    const q = await ethCall(curve, SEL.realQuoteReserve); out.real = q == null ? null : fromWei(decBig(q));
    if (opts.full) {
      const [rs, tr, gr, rg, fee, ct, ph] = await Promise.all([
        ethCall(curve, SEL.getReserves), ethCall(curve, SEL.tokenReserve), ethCall(curve, SEL.graduated), ethCall(curve, SEL.readyToGraduate),
        ethCall(curve, SEL.feeBps), ethCall(curve, SEL.creatorTaxBps), ethCall(curve, SEL.phase)]);
      /* getReserves(): the full quote reserve, phantom included, so the price is exact and not an estimate */
      if (rs && rs.length >= 130) { out.quoteReserve = fromWei(decBig('0x' + word(rs, 0))); out.tokenReserve = fromWei(decBig('0x' + word(rs, 1))); out.phantom = out.real != null ? out.quoteReserve - out.real : null; }
      if (out.tokenReserve == null) out.tokenReserve = tr == null ? null : fromWei(decBig(tr));
      out.graduated = gr == null ? null : decBool(gr);
      out.ready = rg == null ? null : decBool(rg);
      out.feeBps = fee == null ? null : decUint(fee);
      out.creatorTaxBps = ct == null ? null : decUint(ct);
      out.phase = ph == null ? null : decUint(ph);
    }
    if (opts.tax) {
      const who = opts.tax === true ? ZERO.slice(0, -1) + '1' : opts.tax;
      const t = await ethCall(curve, SEL.currentSnipeTaxBps + pad32(who));
      out.taxBps = t == null ? null : decUint(t);
    }
    return out;
  }
  async function tokenRead(token) {
    const [s, n, d, ts] = await Promise.all([ethCall(token, SEL.symbol), ethCall(token, SEL.name), ethCall(token, SEL.decimals), ethCall(token, SEL.totalSupply)]);
    const dec = d == null ? 18 : (decUint(d) == null ? 18 : decUint(d));
    return { symbol: s ? decString(s) : null, name: n ? decString(n) : null, decimals: dec, supply: ts == null ? null : fromWei(decBig(ts), dec) };
  }
  /* the dev buy: CurveBuy logs inside the launch transaction, by the deployer */
  async function devBuy(launch, supply) {
    const rc = await receipt(launch.tx); if (!rc || !rc.logs) return null;
    let quote = 0, tokens = 0, n = 0, quoteWei = 0n;
    rc.logs.forEach(lg => { const e = parseFactoryLog(lg); if (e && e.kind === 'buy' && e.curve === launch.curve) { quote += e.quote || 0; tokens += e.tokens || 0; n++; quoteWei += decBig('0x' + word(lg.data, 0)) || 0n; } });
    if (!n) return { quote: 0, tokens: 0, share: 0, n: 0, quoteWei: '0' };
    return { quote, tokens, share: supply ? tokens / supply * 100 : null, n, quoteWei: quoteWei.toString() };
  }
  /* buyers on the curve since the launch block: distinct wallets, how many paid the opening tax, the block-0 bundle
     (tokens taken in the launch block and the next by wallets other than the deployer), the top-5 net holders.
     the scan is capped to the last BUYERS_WINDOW_BLOCKS blocks so a popular launch with thousands of trades
     doesn't fetch the entire history on every follow-up. */
  async function curveBuyers(launch, toBlock, supply) {
    const fromBlock = Math.max(launch.bn, toBlock - env.num('BUYERS_WINDOW_BLOCKS'));
    const logs = await getLogs(launch.curve, [[T.BUY, T.SELL]], fromBlock, toBlock).catch(() => []);
    const buyers = {}, sellers = {}, net = {}; let taxed = 0, buys = 0, sells = 0, quoteIn = 0, quoteOut = 0, bundleTokens = 0, bundleWallets = {}, devSells = 0, devTokensOut = 0;
    logs.forEach(lg => {
      const e = parseFactoryLog(lg); if (!e) return;
      const who = e.recipient || e.who;
      if (e.kind === 'buy') {
        buys++; quoteIn += e.quote || 0; if ((e.tax || 0) > 0) taxed++;
        if (e.who !== launch.deployer) { buyers[e.who] = 1; if (e.bn <= launch.bn + 1) { bundleTokens += e.tokens || 0; bundleWallets[e.who] = 1; } }
        net[who] = (net[who] || 0) + (e.tokens || 0);
      } else {
        sells++; quoteOut += e.quote || 0; sellers[e.who] = 1; net[e.who] = (net[e.who] || 0) - (e.tokens || 0);
        if (e.who === launch.deployer) { devSells++; devTokensOut += e.tokens || 0; }
      }
    });
    const held = Object.keys(net).filter(a => a !== launch.deployer && net[a] > 0).map(a => net[a]).sort((a, b) => b - a);
    const top5 = held.slice(0, 5).reduce((x, y) => x + y, 0);
    return { buys, sells, buyers: Object.keys(buyers).length, sellers: Object.keys(sellers).length, taxed, quoteIn, quoteOut,
      bundleWallets: Object.keys(bundleWallets).length, bundlePct: supply ? bundleTokens / supply * 100 : null, top5Pct: supply ? top5 / supply * 100 : null, holders: held.length, devSells, devTokensOut, devSoldPct: supply ? devTokensOut / supply * 100 : null };
  }
  /* the factory's own record of a launch, decoded word by word: fee recipient, pair, phase */
  async function factoryRecord(token) {
    const r = await ethCall(factory, SEL.getLaunchedToken + pad32(token)); if (!r || r.length < 2 + 64 * 15) return null;
    const w = i => word(r, i);
    const exists = decBool('0x' + w(14)); if (!exists) return null;
    return { token: decAddr('0x' + w(0)), curve: decAddr('0x' + w(1)), deployer: decAddr('0x' + w(2)), feeRecipient: decAddr('0x' + w(3)), pair: decAddr('0x' + w(4)), thr: fromWei(decBig('0x' + w(5))), poolFee: decUint('0x' + w(6)), tickSpacing: decUint('0x' + w(7)), creatorTaxBps: decUint('0x' + w(8)), buyback: decBool('0x' + w(9)), phase: decUint('0x' + w(10)), sweptQuote: fromWei(decBig('0x' + w(11))), sweptAt: decUint('0x' + w(13)) };
  }
  /* what the deployer did with its tokens in a block range: transfers out of its wallet, sells on the curve */
  async function devMoves(token, curve, deployer, from, to) {
    const [tr, sl] = await Promise.all([
      getLogs(token, [T.TRANSFER, '0x' + pad32(deployer)], from, to, { wide: true }).catch(() => []),
      curve ? getLogs(curve, [T.SELL, '0x' + pad32(deployer)], from, to, { wide: true }).catch(() => []) : Promise.resolve([])
    ]);
    const transfers = tr.map(lg => ({ bn: decUint(lg.blockNumber), to: decAddr(lg.topics[2]), tokens: fromWei(decBig(lg.data)), tx: lg.transactionHash })).filter(x => x.to !== (curve || '').toLowerCase());
    const sells = sl.map(lg => parseFactoryLog(lg)).filter(Boolean);
    return { transfers, sells, tokens: transfers.reduce((s, x) => s + (x.tokens || 0), 0) + sells.reduce((s, x) => s + (x.tokens || 0), 0), moved: transfers.length + sells.length > 0 };
  }

  /* the deployer index: every launch and graduation in the window */
  async function buildIndex(window, head) {
    head = head || await blockNumber();
    const from = Math.max(0, head - window);
    const logs = await getLogs(factory, [[T.LAUNCH, T.GRAD, T.GRAD_ALT, T.SWEPT]], from, head);
    const idx = { from, to: head, launches: [], byToken: {}, byDeployer: {}, grads: {}, swept: {} };
    logs.forEach(lg => {
      const e = parseFactoryLog(lg); if (!e || e.removed) return;
      if (e.kind === 'grad') { idx.grads[e.token] = e.bn; return; }
      if (e.kind === 'swept') { idx.swept[e.token] = e.bn; return; }
      if (e.kind !== 'launch') return;
      if (idx.byToken[e.token]) return;
      idx.byToken[e.token] = e; idx.launches.push(e);
      (idx.byDeployer[e.deployer] = idx.byDeployer[e.deployer] || []).push(e);
    });
    idx.launches.forEach(e => { e.grad = !!idx.grads[e.token]; if (e.grad) e.gradBn = idx.grads[e.token]; e.swept = !!idx.swept[e.token]; });
    idx.launches.sort((a, b) => b.bn - a.bn || b.idx - a.idx);
    return idx;
  }
  function deployerRecord(idx, dep, nowBn, blockTime) {
    const list = (idx.byDeployer[dep] || []);
    const grads = list.filter(e => e.grad).length;
    const recent = nowBn && blockTime ? list.filter(e => (nowBn - e.bn) * blockTime <= 1800).length : list.length;
    return { launches: list.length, grads, twins: Math.max(0, recent - 1), rate: list.length ? grads / list.length : null };
  }
  function addToIndex(idx, e) {
    if (e.kind === 'grad') { idx.grads[e.token] = e.bn; const t = idx.byToken[e.token]; if (t) { t.grad = true; t.gradBn = e.bn; } return true; }
    if (e.kind === 'swept') { idx.swept = idx.swept || {}; idx.swept[e.token] = e.bn; const t = idx.byToken[e.token]; if (t) t.swept = true; return true; }
    if (e.kind !== 'launch') return false;
    if (idx.byToken[e.token]) return false;
    e.grad = !!idx.grads[e.token];
    idx.byToken[e.token] = e; idx.launches.unshift(e);
    (idx.byDeployer[e.deployer] = idx.byDeployer[e.deployer] || []).push(e);
    return true;
  }

  /* block time from the head: two blocks, one span */
  async function measureBlockTime(head) {
    const back = 400;
    const [a, b] = await Promise.all([getBlock(head), getBlock(Math.max(0, head - back))]);
    if (!a || !b || a.timestamp <= b.timestamp) return { blockTime: 0.25, headAt: a ? a.timestamp : Date.now() };
    return { blockTime: (a.timestamp - b.timestamp) / 1000 / (a.number - b.number), headAt: a.timestamp };
  }

  return { rpc, factory, T, GRADS, SEL, ZERO, call, ethCall, blockNumber, chainId, getBlock, getCode, receipt, tx, getLogs, parseFactoryLog, curveRead, tokenRead, devBuy, curveBuyers, factoryRecord, devMoves, multicall, readLaunch, buildIndex, deployerRecord, addToIndex, measureBlockTime, sleep, dec: { decUint, decBig, decBool, decAddr, decString, fromWei, word, pad32, hex } };
}

module.exports = { makeChain, makeRpc, T, GRADS, SEL, ZERO, decUint, decBig, decBool, decAddr, decString, fromWei, word, pad32, hex, sleep };
