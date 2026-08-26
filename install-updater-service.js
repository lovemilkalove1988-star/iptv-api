const Service = require("node-windows").Service;

const svc = new Service({
    name: "IPTV Manager Updater",
    description: "Automatic updater for IPTV Manager",
    script: "C:\\Users\\Admin\\iptv-api\\updater.js",
    workingDirectory: "C:\\Users\\Admin\\iptv-api"
});

svc.on("install", () => {
    console.log("IPTV Manager Updater service installed.");
    svc.start();
});

svc.on("alreadyinstalled", () => {
    console.log("IPTV Manager Updater service already installed.");
    svc.start();
});

svc.on("start", () => {
    console.log("IPTV Manager Updater service started.");
});

svc.install();