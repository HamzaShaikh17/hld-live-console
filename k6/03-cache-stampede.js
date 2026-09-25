import http from 'k6/http';
// All 200 requests fire in the same short burst - run this right after
// the cached value expires (5s TTL) to trigger a stampede.
export const options = {
  scenarios: {
    burst: { executor: 'shared-iterations', vus: 200, iterations: 200, maxDuration: '10s' },
  },
};
export default function () {
  http.get('http://localhost:8080/hot-item');
}
