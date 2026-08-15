// Minimal k6 script with no HTTP target: safe to run anywhere (CI / local)
// without a server. Used by the opt-in live test.
import { sleep } from "k6";

export default function () {
  sleep(0.01);
}
