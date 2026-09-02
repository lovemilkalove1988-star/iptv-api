/* Shared, generation-safe HTML5/HLS playback lifecycle for MILK TV pages. */
(function (global) {
  "use strict";

  function create(video, callbacks) {
    if (!video) throw new Error("MILK TV player video element is required");
    const hooks = callbacks || {};
    let generation = 0;
    let hls = null;
    let disposed = false;

    function current(token) {
      return !disposed && token === generation;
    }

    function notify(name, detail, token) {
      if (token !== undefined && !current(token)) return;
      const callback = hooks[name];
      if (typeof callback === "function") callback(detail);
    }

    function stopMedia() {
      if (hls) {
        try { hls.stopLoad(); } catch (_) {}
        try { hls.detachMedia(); } catch (_) {}
        try { hls.destroy(); } catch (_) {}
        hls = null;
      }
      try { video.pause(); } catch (_) {}
      video.removeAttribute("src");
      video.src = "";
      try { video.load(); } catch (_) {}
    }

    function stop() {
      generation += 1;
      stopMedia();
    }

    function play(url, options) {
      const token = ++generation;
      const userInitiated = !!(options && options.userInitiated);
      stopMedia();

      if (!url) {
        notify("onError", new Error("Playback URL is missing"), token);
        return token;
      }

      notify("onLoading", null, token);
      const fail = error => notify("onError", error || new Error("Playback failed"), token);
      const begin = () => {
        if (!current(token)) return;
        let result;
        try { result = video.play(); } catch (error) { fail(error); return; }
        Promise.resolve(result).then(() => notify("onPlaying", null, token)).catch(fail);
      };

      // Protected MILK TV playback URLs hide the original .m3u8 extension.
      // Prefer HLS.js for them as well; it starts live streams faster and
      // gives us explicit control over the live buffer.
      const protectedPlayback =
        url.indexOf("/api/v1/client/public/play/") !== -1;

      if (
        (url.indexOf(".m3u8") !== -1 || protectedPlayback) &&
        global.Hls &&
        global.Hls.isSupported()
      ) {
        const instance = new global.Hls({
          startPosition: -1,
          startFragPrefetch: true,
          liveSyncDurationCount: 1,
          liveMaxLatencyDurationCount: 3,
          maxBufferLength: 12,
          maxMaxBufferLength: 30,
          backBufferLength: 0
        });
        hls = instance;
        instance.on(global.Hls.Events.MEDIA_ATTACHED, () => notify("onMediaAttached", null, token));
        instance.on(global.Hls.Events.MANIFEST_PARSED, begin);
        instance.on(global.Hls.Events.ERROR, (_, data) => {
          if (data && data.fatal) fail(new Error(data.details || data.type || "HLS fatal error"));
        });
        instance.attachMedia(video);
        instance.loadSource(url);
        // HLS manifest parsing is asynchronous.  When the URL was already
        // prepared before a card OK/click, prime play inside that trusted user
        // gesture instead of waiting for MANIFEST_PARSED to lose activation.
        if (userInitiated) begin();
      } else {
        const nativeError = () => {
          if (current(token)) fail(new Error("Native media error"));
        };
        video.addEventListener("error", nativeError, { once: true });
        video.src = url;
        video.load();
        begin();
      }
      return token;
    }

    return { play, stop, destroy: () => { disposed = true; stop(); }, get generation() { return generation; } };
  }

  global.MilkTvPlayerController = { create };
})(window);
