import { fetchDollarIndex, fetchEquityIndex } from "../marketData.js";

function main() {
  try {
    const dxy = fetchDollarIndex();
    const equityIndex = fetchEquityIndex();

    console.log(JSON.stringify({
      ok: true,
      checked: "macro_cross_asset_client",
      dxy,
      equity_index: equityIndex
    }, null, 2));

    if (!dxy && !equityIndex) {
      console.warn("WARN: cross-asset macro data unavailable");
    }
  } catch (error) {
    console.error("Macro cross-asset client verification failed", { message: error?.message || String(error) });
    process.exit(1);
  }
}

main();
