import http from 'k6/http';
export const options = { vus: 100, duration: '20s' };
export default function () {
  http.get('http://localhost:8080/product/1');
}
