function run(cmd) {
  // security finding: child_process exec of a command string
  const cp = require("child_process");
  return cp.execSync(cmd);
}
