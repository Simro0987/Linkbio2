'use strict';
/**
 * Automatic on-chain payment verification for methods where funds land on a watched
 * UTXO address (BTC/LTC/BCH/DOGE) we control. NEVER auto-marks gift cards, Revolut
 * Revtag, SEPA, PaysafeCard, card ramps without our address, or other non-chain methods.
 *
 * Runs inside the Render process (chainWatcher sweep + on-demand when a status page
 * is opened / the free tier wakes). Public explorers only; Ryan's addresses come from
 * admin wallets / xpub — never committed.
 */
const cryptoDirect = require('./cryptoDirect');

/** Providers that receive crypto on a watched payout address. */
const AUTO_PROVIDERS = new Set(['revolut_ramp', 'changelly', 'crypto_direct']);

const EXPLORER = {
  btc: (txid) => `https://mempool.space/tx/${txid}`,
  ltc: (txid) => `https://litecoinspace.org/tx/${txid}`,
  bch: (txid) => `https://blockchair.com/bitcoin-cash/transaction/${txid}`,
  doge: (txid) => `https://blockchair.com/dogecoin/transaction/${txid}`,
};

const PAID_RATIO = () => {
  const n = Number(process.env.CHANGELLY_PAID_RATIO);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.85;
};

function isAuto(order) {
  if (!order) return false;
  const p = String(order.provider || '');
  if (!AUTO_PROVIDERS.has(p)) return false;
  const coin = String(order.payoutCoin || '').toLowerCase();
  return !!(order.payoutAddress && ['btc', 'ltc', 'bch', 'doge'].includes(coin) && order.watched !== false);
}

function explorerUrl(coin, txid) {
  if (!txid) return null;
  const fn = EXPLORER[String(coin || '').toLowerCase()];
  return fn ? fn(txid) : null;
}

function maskAddr(a) {
  const s = String(a || '');
  if (s.length < 12) return '…';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

/** Collect txids already claimed by any order (prevents double-matching on reused addresses). */
function claimedTxids(orders, exceptId) {
  const set = new Set();
  for (const o of Object.values(orders || {})) {
    if (!o || o.orderId === exceptId) continue;
    if (o.chainTxid) set.add(String(o.chainTxid));
    for (const t of o.chainTxids || []) if (t) set.add(String(t));
  }
  return set;
}

/**
 * Pick the best new tx for this order from a chainWatcher result.
 * Prefer confirmed txs with valueSat; skip already-claimed txids.
 */
function pickTx(order, r, claimed) {
  const txs = (r && r.txs) || [];
  const withVal = txs.filter((t) => t && t.txid && Number(t.valueSat) > 0 && !claimed.has(t.txid));
  const conf = withVal.filter((t) => t.confirmed);
  const pool = conf.length ? conf : withVal;
  if (pool.length) {
    // Prefer amount closest to expected crypto (if known), else largest
    const expectSat = order.amountCrypto != null ? Math.round(Number(order.amountCrypto) * 1e8) : null;
    pool.sort((a, b) => {
      if (expectSat != null) {
        return Math.abs(a.valueSat - expectSat) - Math.abs(b.valueSat - expectSat);
      }
      return b.valueSat - a.valueSat;
    });
    return pool[0];
  }
  // No usable unclaimed per-tx amounts: only fall back to aggregate newSat when the explorer
  // gave no per-tx values at all (e.g. some BCH backends). If every valued tx is already claimed,
  // do not reuse them for another order.
  const anyValued = txs.some((t) => t && Number(t.valueSat) > 0);
  if (anyValued) return null;
  if (Number(r && r.newSat) > 0) {
    const free = txs.find((t) => t && t.txid && !claimed.has(t.txid));
    return { txid: free ? free.txid : null, valueSat: Number(r.newSat), confirmed: r.status === 'confirmed' };
  }
  return null;
}

async function tg(text) {
  try {
    const t = global.__telegramBot;
    const chat = t && t.loadAdminChatId && t.loadAdminChatId();
    if (chat) await t.sendMessage(chat, text);
  } catch { /* best effort */ }
}

/**
 * Apply a chain status update: mark paid / partial / received_check, claim txid, notify.
 * Idempotent when already paid. Only for AUTO_PROVIDERS.
 * @returns {{ changed: boolean, verdict: string|null }}
 */
async function apply(order, status, r, { loadOrders, saveOrders, appendLog }) {
  if (!isAuto(order)) return { changed: false, verdict: null };
  if (status !== 'unconfirmed' && status !== 'confirmed') return { changed: false, verdict: null };

  const fresh = loadOrders();
  const f = fresh[order.orderId];
  if (!f) return { changed: false, verdict: null };
  if (f.status === 'paid' && f.chainTxid) return { changed: false, verdict: 'paid' };

  const claimed = claimedTxids(fresh, order.orderId);
  const tx = pickTx(f, r, claimed);
  // If pickTx returns null (all valued txs already claimed, or nothing new), do not invent a match.
  // Confirmed-but-unmeasurable (e.g. BCH explorer without amounts) → received_check for Ryan.
  if (!tx || !(Number(tx.valueSat) > 0)) {
    f.chainStatus = status;
    f.chainStatusAt = (r && r.checkedAt) || new Date().toISOString();
    let verdict = null;
    if (status === 'confirmed' && f.status !== 'paid') {
      f.status = 'received_check';
      verdict = 'unknown';
      if (!f._payVerifyUnknownTg) {
        f._payVerifyUnknownTg = true;
        saveOrders(fresh);
        const coin = String(f.payoutCoin || '').toUpperCase();
        await tg(`❔ Platba na chaini, sumu nevieme spoľahlivo overiť\nObjednávka: ${f.orderId}\nSuma: ${f.amountEur} EUR\nMena: ${coin}\nAdresa: ${maskAddr(f.payoutAddress)}\nSkontrolujte peňaženku (/admin/objednavky/${f.orderId}).`);
      } else saveOrders(fresh);
    } else saveOrders(fresh);
    return { changed: !!verdict, verdict };
  }
  const sat = Number(tx.valueSat);

  const coin = String(f.payoutCoin || '').toLowerCase();
  const px = await cryptoDirect.prices().catch(() => ({}));
  const asset = (cryptoDirect.ASSETS || []).find((a) => a.watch === coin || a.id === coin);
  const price = asset && px ? px[asset.cg] : null;
  const recvCoin = sat != null ? sat / 1e8 : null;
  const recvEur = recvCoin != null && price > 0 ? Math.round(recvCoin * price * 100) / 100 : null;
  const ratio = recvEur != null && Number(f.amountEur) > 0 ? recvEur / Number(f.amountEur) : null;
  const need = Number(f.paidRatio) > 0 ? Number(f.paidRatio) : PAID_RATIO();

  f.chainStatus = status;
  f.chainStatusAt = (r && r.checkedAt) || new Date().toISOString();
  if (recvCoin != null) {
    f.receivedCrypto = recvCoin.toFixed(8);
    f.receivedEur = recvEur;
    f.receivedRatio = ratio != null ? Math.round(ratio * 1000) / 1000 : null;
  }
  if (tx && tx.txid) {
    f.chainTxid = tx.txid;
    f.chainTxids = Array.from(new Set([...(f.chainTxids || []), tx.txid]));
    f.chainTxUrl = explorerUrl(coin, tx.txid);
  }

  let verdict = null;
  if (status === 'confirmed') {
    if (ratio == null) {
      verdict = 'unknown';
      if (f.status !== 'paid') f.status = 'received_check';
    } else if (ratio >= need) {
      verdict = 'paid';
      f.status = 'paid';
      f.paidAt = f.paidAt || new Date().toISOString();
    } else {
      verdict = 'partial';
      if (f.status !== 'paid') f.status = 'partial';
    }
  } else if (status === 'unconfirmed') {
    verdict = 'unconfirmed';
    // Do not mark paid until confirmed — still notify once
  }

  saveOrders(fresh);
  const log = appendLog || (() => {});
  log(`PAYVERIFY ${f.orderId} ${f.provider} ${status} recv=${f.receivedCrypto || '?'} eur=${recvEur ?? '?'} ratio=${ratio != null ? ratio.toFixed(3) : '?'}${verdict ? ' → ' + verdict : ''}${tx && tx.txid ? ' tx=' + String(tx.txid).slice(0, 12) : ''}`);

  const brand = f.provider === 'revolut_ramp' ? 'Revolut Ramp'
    : f.provider === 'changelly' ? 'Changelly'
      : 'Krypto priamo';
  const got = recvCoin != null
    ? `\nPrijaté: ${f.receivedCrypto} ${String(f.ticker || coin).toUpperCase()}${recvEur != null ? ` ≈ ${recvEur} EUR (${Math.round(ratio * 100)} %)` : ''}`
    : '';
  const txLine = f.chainTxUrl ? `\nTX: ${f.chainTxUrl}` : (f.chainTxid ? `\nTX: ${f.chainTxid}` : '');
  const head = `Objednávka: ${f.orderId}\nSuma: ${f.amountEur} EUR\nMena: ${String(f.ticker || coin).toUpperCase()}\nAdresa: ${maskAddr(f.payoutAddress)}`;

  if (verdict === 'paid' && !f._payVerifyPaidTg) {
    f._payVerifyPaidTg = true;
    saveOrders(fresh);
    await tg(`✅ Platba prijatá · ${brand}\n${head}${got}${txLine}`);
  } else if (verdict === 'partial' && !f._payVerifyPartialTg) {
    f._payVerifyPartialTg = true;
    saveOrders(fresh);
    await tg(`⚠️ ${brand} – ČIASTOČNÁ platba (pod ${Math.round(need * 100)} %)\n${head}${got}${txLine}\nSkontrolujte a rozhodnite ručne (/admin/objednavky/${f.orderId}).`);
  } else if (verdict === 'unknown' && !f._payVerifyUnknownTg) {
    f._payVerifyUnknownTg = true;
    saveOrders(fresh);
    await tg(`❔ ${brand} – platba na chaini, sumu sa nepodarilo overiť\n${head}${txLine}\nSkontrolujte peňaženku (/admin/objednavky/${f.orderId}).`);
  } else if (verdict === 'unconfirmed' && !f._payVerifyUnconfTg) {
    f._payVerifyUnconfTg = true;
    saveOrders(fresh);
    await tg(`⏳ ${brand} – platba v mempoole (nepotvrdená)\n${head}${got}${txLine}`);
  }

  return { changed: true, verdict };
}

/** On-demand check used by status pages / wake: refresh chain + apply if needed. */
async function checkNow(order, deps) {
  if (!isAuto(order)) return null;
  const watcher = require('./chainWatcher');
  const r = await watcher.statusForOrder(order, { force: true });
  if (!r || r.status === 'error' || r.status === 'unsupported' || r.status === 'waiting') return r;
  // Always try apply when funds seen — idempotent if already paid
  await apply(order, r.status, r, deps);
  return r;
}

function adminSummary(order) {
  if (!order) return null;
  const auto = isAuto(order);
  return {
    auto,
    reason: auto
      ? 'Automaticky: sledujeme BTC/LTC/BCH/DOGE adresu verejnými explorermi na Renderi.'
      : 'Manuálne: túto metódu nie je spoľahlivo overiť na chaini (darčeková karta, Revtag, SEPA, karta u tretieho, nesledovaná sieť…).',
    chainStatus: order.chainStatus || null,
    chainTxid: order.chainTxid || null,
    chainTxUrl: order.chainTxUrl || null,
    receivedCrypto: order.receivedCrypto || null,
    receivedEur: order.receivedEur != null ? order.receivedEur : null,
    coin: order.payoutCoin || null,
    addressMasked: order.payoutAddress ? maskAddr(order.payoutAddress) : null,
  };
}

module.exports = {
  AUTO_PROVIDERS, isAuto, apply, checkNow, adminSummary, explorerUrl, pickTx, claimedTxids, PAID_RATIO, EXPLORER,
};
