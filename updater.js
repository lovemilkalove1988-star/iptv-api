const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT = "C:\\Users\\Admin\\iptv-api";
const LOG = path.join(PROJECT, "updater.log");

const GIT = "C:\\Program Files\\Git\\cmd\\git.exe";
const NPM = "C:\\Windows\\System32\\cmd.exe";
const SC = "C:\\Windows\\System32\\sc.exe";

function log(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(LOG, line);
    console.log(line.trim());
}

function run(file, args) {
    return new Promise((resolve, reject) => {
        execFile(
            file,
            args,
            {
                cwd: PROJECT,
                windowsHide: true
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject(
                        new Error(stderr || stdout || error.message)
                    );
                    return;
                }

                resolve(stdout.trim());
            }
        );
    });
}

async function check() {
    try {
        // Получаем актуальное состояние GitHub
        await run(
            GIT,
            ["fetch", "origin", "main"]
        );

        const remote = await run(
            GIT,
            ["rev-parse", "origin/main"]
        );

        const local = await run(
            GIT,
            ["rev-parse", "HEAD"]
        );

        if (remote === local) {
            log("Обновлений нет.");
            return;
        }

        log(`Найдено обновление: ${local} -> ${remote}`);

        // Обновляем проект
        await run(
            GIT,
            ["pull", "--ff-only", "origin", "main"]
        );

        log("Git обновление завершено.");

        // Устанавливаем зависимости, если package-файлы существуют
        if (
            fs.existsSync(path.join(PROJECT, "package.json")) &&
            fs.existsSync(path.join(PROJECT, "package-lock.json"))
        ) {
            log("Запускаем npm install...");

            await run(
                NPM,
                ["/c", "npm", "install", "--omit=dev"]
            );

            log("npm install завершён.");
        }

        // Перезапускаем IPTV API
        log("Перезапускаем IPTV Manager API...");

        await run(
            SC,
            ["stop", "iptvmanagerapi.exe"]
        );

        await new Promise(resolve =>
            setTimeout(resolve, 3000)
        );

        await run(
            SC,
            ["start", "iptvmanagerapi.exe"]
        );

        log("IPTV Manager API перезапущен.");

    } catch (error) {
        log(`ОШИБКА ОБНОВЛЕНИЯ: ${error.message}`);
    }
}

// Первая проверка сразу после запуска
check();

// Затем проверяем GitHub каждые 5 минут
setInterval(
    check,
    5 * 60 * 1000
);
