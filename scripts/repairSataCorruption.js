#!/usr/bin/env node
/**
 * One-off, idempotent repair for the SATA dual-source pricing corruption.
 *
 * Background: the e3d feed mispriced SATA (0x3ebb...4bee1) ~190-2300x too low at entry, so a ~$848
 * buy "purchased" a fictional ~105M-token position. On 2026-05-26 the DexScreener overlay overwrote
 * SATA's mark with $0.001555, blew past all 3 take-profit targets at once, and booked ~$127,260 of
 * phantom realized P&L (4 phantom sells). This voids the SATA trade entirely (buy + all sells), as
 * if it never happened, and rebuilds portfolio stats from the remaining (legitimate) records.
 *
 * Idempotent: if SATA is already absent it is a no-op. Usage: node scripts/repairSataCorruption.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTFOLIO_FILE = path.join(__dirname, "..", "portfolio.json");
const SATA = "SATA";
const PHANTOM_RATIO = 10;          // sell/entry ratio above which a closed trade is a phantom
const DEFAULT_MARK_DEV = 5;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pnlOf = (t) => num(t.pnl_usd ?? t.realized_pnl_usd ?? t.realized_pnl, 0);

function main() {
  const p = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf8"));
  p.positions = p.positions || {};
  p.closed_trades = Array.isArray(p.closed_trades) ? p.closed_trades : [];
  p.action_history = Array.isArray(p.action_history) ? p.action_history : [];
  p.stats = p.stats || {};
  p.settings = p.settings || {};

  const before = {
    cash: num(p.cash_usd),
    equity: num(p.stats.equity_usd),
    realized: num(p.stats.realized_pnl_usd),
    unrealized: num(p.stats.unrealized_pnl_usd),
    positions: Object.keys(p.positions).length,
    closed: p.closed_trades.length,
  };

  const hasSataPos = !!p.positions[SATA];
  const phantoms = p.closed_trades.filter(
    (t) => t.symbol === SATA && num(t.avg_entry_price) > 0 && num(t.price) / num(t.avg_entry_price) > PHANTOM_RATIO
  );

  if (!hasSataPos && phantoms.length === 0) {
    console.log("No SATA position and no phantom SATA trades found — already clean, no-op.");
    return;
  }

  // Original buy cost B = remaining SATA cost basis + cost portions of the phantom sells.
  // Sells inflow S = net proceeds of the phantom sells.
  const remainingCostBasis = hasSataPos ? num(p.positions[SATA].cost_basis_usd) : 0;
  const sumCostPortion = phantoms.reduce((a, t) => a + num(t.cost_portion_usd), 0);
  const B = remainingCostBasis + sumCostPortion;
  const S = phantoms.reduce((a, t) => a + num(t.net_proceeds_usd ?? t.proceeds_usd), 0);
  const phantomRealized = phantoms.reduce((a, t) => a + pnlOf(t), 0);

  console.log("=== VOID SATA ===");
  console.log("phantom sells found:           ", phantoms.length);
  console.log("original buy cost  B = $", B.toFixed(2), "(remaining basis", remainingCostBasis.toFixed(2), "+ sold cost", sumCostPortion.toFixed(2) + ")");
  console.log("phantom sells inflow S = $", S.toFixed(2));
  console.log("phantom realized removed = $", phantomRealized.toFixed(2));

  // 1. Remove the SATA position.
  delete p.positions[SATA];
  // 2. Remove phantom closed trades.
  p.closed_trades = p.closed_trades.filter(
    (t) => !(t.symbol === SATA && num(t.avg_entry_price) > 0 && num(t.price) / num(t.avg_entry_price) > PHANTOM_RATIO)
  );
  // 3. Remove ALL SATA action_history entries (buy + sells) — full void.
  const ahBefore = p.action_history.length;
  p.action_history = p.action_history.filter((a) => a.symbol !== SATA);
  const ahRemoved = ahBefore - p.action_history.length;

  // 4. Undo cash footprint: add back the buy outflow, remove the sells inflow.
  p.cash_usd = num(p.cash_usd) + B - S;

  // 5. Rebuild stats from scratch.
  const realized = p.closed_trades.reduce((a, t) => a + pnlOf(t), 0);
  let unrealized = 0;
  let posMktVal = 0;
  for (const pos of Object.values(p.positions)) {
    const mv = num(pos.market_value_usd, num(pos.quantity) * num(pos.current_price));
    posMktVal += mv;
    unrealized += mv - num(pos.cost_basis_usd);
  }
  const equity = num(p.cash_usd) + posMktVal;
  p.stats.realized_pnl_usd = realized;
  p.stats.unrealized_pnl_usd = unrealized;
  p.stats.equity_usd = equity;
  p.stats.peak_equity_usd = equity;     // clear the stuck phantom peak; drawdown rebuilds naturally
  p.stats.max_drawdown_pct = 0;

  // 6. Ensure the new guard setting is present.
  if (p.settings.max_mark_deviation_ratio == null) p.settings.max_mark_deviation_ratio = DEFAULT_MARK_DEV;

  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(p, null, 2));

  console.log("\n=== BEFORE -> AFTER ===");
  const after = {
    cash: num(p.cash_usd), equity, realized, unrealized,
    positions: Object.keys(p.positions).length, closed: p.closed_trades.length,
  };
  const row = (k, b, a, fmt = (x) => x) => console.log(k.padEnd(14), String(fmt(b)).padStart(14), " -> ", String(fmt(a)).padStart(14));
  const m = (x) => "$" + Number(x).toFixed(2);
  row("cash", before.cash, after.cash, m);
  row("equity", before.equity, after.equity, m);
  row("realized", before.realized, after.realized, m);
  row("unrealized", before.unrealized, after.unrealized, m);
  row("positions", before.positions, after.positions);
  row("closed_trades", before.closed, after.closed);
  console.log("action_history SATA rows removed:", ahRemoved);
  console.log("\nWrote", PORTFOLIO_FILE);
}

main();
