import http from 'k6/http';
export const options = { vus: 40, duration: '30s' };
export default function () {
  const res = http.get('http://localhost:8080/canary/hello');
  if (res.status !== 200) console.log('ERROR from', JSON.parse(res.body || '{}').served_by);
}
