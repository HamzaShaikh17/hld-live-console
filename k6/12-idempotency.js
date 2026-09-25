import http from 'k6/http';
// Each virtual user simulates a client that retries the SAME logical
// request 3 times (e.g. because it timed out waiting for a response),
// reusing the same Idempotency-Key each time.
export const options = { vus: 20, iterations: 20 };
export default function () {
  const key = 'idem-' + __VU + '-' + __ITER;
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key };
  for (let i = 0; i < 3; i++) {
    http.post('http://localhost:8080/charge', JSON.stringify({ amount: 10 }), { headers });
  }
}
