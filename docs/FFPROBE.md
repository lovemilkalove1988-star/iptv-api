# FFprobe runtime

Quality probe uses `FFPROBE_PATH` when set, otherwise the system `ffprobe` command.

Install FFmpeg through the operating system package manager and ensure `ffprobe.exe` is on PATH, or set `FFPROBE_PATH` to its full path.

Run `node scripts/check-ffprobe.js` to test availability without contacting streams.
