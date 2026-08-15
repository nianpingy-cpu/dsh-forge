import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 1,
  duration: "10s",
  thresholds: {
    http_req_duration: ["p(95)<500"],
  },
};

export default function () {
  const res = http.get("http://localhost:8080/");
  check(res, {
    "status is 200": (r) => r.status === 200,
  });
  sleep(0.01);
}
