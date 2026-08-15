import http from "k6/http";
import { check } from "k6";

export const options = {
  vus: 5,
  duration: "5s",
  thresholds: {
    http_req_duration: ["p(95)<1000"],
  },
};

export default function () {
  const res = http.get("http://localhost:8080/");
  check(res, {
    "status is 200": (r) => r.status === 200,
  });
}
