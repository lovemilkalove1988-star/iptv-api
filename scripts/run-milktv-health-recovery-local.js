require("dotenv").config();

const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("Type RUN: ", answer => {
  rl.close();
  if (answer.trim() !== "RUN") {
    console.log("Cancelled (no database check started).");
    process.exitCode = 0;
    return;
  }

  process.env.MILKTV_HEALTH_CLI = "true";
  process.env.MILKTV_AUTOPILOT_ENABLED = "false";
  require("../server.js");
});
