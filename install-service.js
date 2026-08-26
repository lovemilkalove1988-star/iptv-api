const Service = require("node-windows").Service;
const path = require("path");

const svc = new Service({
  name: "IPTV Manager API",
  description: "IPTV Manager Node.js API Server",
  script: path.join(__dirname, "server.js"),
  workingDirectory: __dirname,
  env: [
    {
      name: "NODE_ENV",
      value: "production"
    }
  ]
});

svc.on("install", () => {
  console.log("IPTV Manager API service installed.");
  svc.start();
});

svc.on("alreadyinstalled", () => {
  console.log("IPTV Manager API service is already installed.");
});

svc.on("start", () => {
  console.log("IPTV Manager API service started.");
});

svc.on("error", (err) => {
  console.error("Service error:", err);
});

svc.install();