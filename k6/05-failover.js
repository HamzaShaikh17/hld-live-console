import http from 'k6/http';
// Long, steady, low-volume run so you have time to `docker stop app2`
// (or `docker stop app1` for the single-instance version) mid-test.
export const options = { vus: 20, duration: '60s' };
export default function () {
  const res = http.get('http://localhost:8080/hello');
  if (res.status !== 200) console.log('ERROR', res.status, res.body);
}
