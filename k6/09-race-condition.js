import http from 'k6/http';
// 100 concurrent decrement attempts against a stock of 50.
// Broken mode should oversell (final stock < 0, or successes > 50).
// Fixed (atomic) mode should show exactly 50 successes and 50 "out_of_stock".
export const options = {
  scenarios: {
    race: { executor: 'shared-iterations', vus: 100, iterations: 100, maxDuration: '15s' },
  },
};
export default function () {
  http.post('http://localhost:8080/decrement-stock', JSON.stringify({ sku: 1 }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
