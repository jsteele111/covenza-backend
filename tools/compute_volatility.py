"""
Covenza — Volatility & Correlation Refresh Tool
Computes real, historical (not implied) annualised volatility AND
pairwise correlation for the deposit-sizing model, from CoinGecko's free
public API — no API key required for this basic usage, though a free
Demo key raises rate limits if you run this often (register at
coingecko.com/en/api).

Usage:
    python compute_volatility.py

WHY CORRELATION MATTERS (added after initial volatility-only version):
A borrower's real worst-case exposure isn't necessarily the loan asset's
own volatility against USD — it's the volatility of whichever cross-rate
they end up holding if they exercise the swap privilege. The volatility
of a cross-rate A/B is:

    vol(A/B) = sqrt(volA^2 + volB^2 - 2 * rho * volA * volB)

where rho is the correlation between A and B's daily returns. A naive
independence assumption (rho = 0) overstates the true cross-rate risk
whenever two assets are positively correlated — which ETH and WBTC/BTC
clearly are. This script computes the real rho from the same price data
already pulled for volatility, at no extra API cost.

Methodology:
    1. Pull ONE 180-day trailing daily price series per asset (the 90-day
       figures are then a sub-slice of the same pull, not a separate call
       — halves the number of API requests needed).
    2. Daily log returns: ln(P_t / P_t-1).
    3. Volatility = std dev of returns x sqrt(365).
    4. Correlation = Pearson correlation of two assets' return series over
       the same aligned window.

WBTC note: pulls BTC's own price series, not WBTC's — the model treats
WBTC's price risk as equal to BTC's (see README sheet).
"""

import math
import time
import urllib.request
import urllib.error
import json

COINGECKO_BASE = "https://api.coingecko.com/api/v3"

ASSETS = {
    "ETH":  "ethereum",
    "WBTC": "bitcoin",   # deliberate: models WBTC's price risk on BTC itself
    "USDC": "usd-coin",
    "USDT": "tether",
}

MAX_WINDOW = 180
SUB_WINDOWS = [90, 180]


def fetch_daily_prices(coingecko_id, days, max_retries=3):
    url = f"{COINGECKO_BASE}/coins/{coingecko_id}/market_chart?vs_currency=usd&days={days}&interval=daily"
    req = urllib.request.Request(url, headers={"User-Agent": "covenza-volatility-tool/1.0"})

    for attempt in range(1, max_retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
            return [p[1] for p in data["prices"]]
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < max_retries:
                wait = 20 * attempt
                print(f"  ({coingecko_id}: rate-limited, waiting {wait}s before retry {attempt+1}/{max_retries}...)")
                time.sleep(wait)
                continue
            raise RuntimeError(
                f"CoinGecko request failed ({e.code}) for {coingecko_id} after {attempt} attempt(s). "
                f"Consider registering a free Demo API key at coingecko.com/en/api for higher limits."
            ) from e
    raise RuntimeError(f"Unreachable: retry loop exited without returning for {coingecko_id}")


def log_returns(prices):
    return [math.log(prices[i] / prices[i - 1]) for i in range(1, len(prices))]


def annualised_volatility(returns):
    if len(returns) < 2:
        raise ValueError("Need at least 2 returns to compute a volatility.")
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    return math.sqrt(variance) * math.sqrt(365)


def pearson_correlation(returns_a, returns_b):
    """Aligns to the shorter series (trims from the front) in case the two
    pulls came back with slightly different lengths at the boundary."""
    n = min(len(returns_a), len(returns_b))
    a = returns_a[-n:]
    b = returns_b[-n:]
    mean_a = sum(a) / n
    mean_b = sum(b) / n
    cov = sum((a[i] - mean_a) * (b[i] - mean_b) for i in range(n)) / (n - 1)
    std_a = math.sqrt(sum((x - mean_a) ** 2 for x in a) / (n - 1))
    std_b = math.sqrt(sum((x - mean_b) ** 2 for x in b) / (n - 1))
    if std_a == 0 or std_b == 0:
        return 0.0  # a constant series has no defined correlation; treat as none
    return cov / (std_a * std_b)


def cross_rate_volatility(vol_a, vol_b, rho):
    """vol(A/B) = sqrt(volA^2 + volB^2 - 2*rho*volA*volB) — the real
    cross-rate volatility, replacing the earlier independence-assumed
    version (which used rho = 0 implicitly)."""
    value = vol_a**2 + vol_b**2 - 2 * rho * vol_a * vol_b
    return math.sqrt(max(value, 0))  # guard against tiny negative floating-point noise


def main():
    print("Fetching 180-day price history per asset (90-day figures are a sub-slice — no extra calls)...\n")

    returns_by_asset = {}
    for asset, cg_id in ASSETS.items():
        prices = fetch_daily_prices(cg_id, MAX_WINDOW)
        returns_by_asset[asset] = log_returns(prices)
        time.sleep(12)

    print(f"{'Asset':<8}{'Window':<10}{'Annualised Vol'}")
    print("-" * 40)
    vol_90 = {}
    for asset, returns in returns_by_asset.items():
        for window in SUB_WINDOWS:
            sub_returns = returns[-window:] if window < len(returns) else returns
            vol = annualised_volatility(sub_returns)
            print(f"{asset:<8}{str(window)+'d':<10}{vol*100:>6.2f}%")
            if window == 90:
                vol_90[asset] = vol

    print(f"\n{'Pair':<16}{'Correlation (90d daily returns)'}")
    print("-" * 48)
    asset_names = list(ASSETS.keys())
    correlations = {}
    for i in range(len(asset_names)):
        for j in range(i + 1, len(asset_names)):
            a, b = asset_names[i], asset_names[j]
            r_a = returns_by_asset[a][-90:]
            r_b = returns_by_asset[b][-90:]
            rho = pearson_correlation(r_a, r_b)
            correlations[(a, b)] = rho
            print(f"{a}/{b:<12}{rho:>6.3f}")

    print(f"\n{'Cross-rate':<16}{'Independence-assumed':<24}{'Correlation-adjusted'}")
    print("-" * 60)
    for i in range(len(asset_names)):
        for j in range(i + 1, len(asset_names)):
            a, b = asset_names[i], asset_names[j]
            rho = correlations[(a, b)]
            naive = cross_rate_volatility(vol_90[a], vol_90[b], 0.0)
            adjusted = cross_rate_volatility(vol_90[a], vol_90[b], rho)
            print(f"{a}/{b:<12}{naive*100:>8.2f}%{'':<14}{adjusted*100:>8.2f}%")

    print("\nUpdate 'Volatility Inputs' with the 90-day annualised vol figures above,")
    print("and the correlation-adjusted cross-rate figures feed the worst-case deposit")
    print("calculation on the VaR Model sheet. Source: 'Computed from CoinGecko daily")
    print("closes, 90-day trailing window, <today's date>'.")


if __name__ == "__main__":
    main()